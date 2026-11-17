//! TCP 客户端 / 服务端：
//! 客户端一条连接 = 一个读线程 + 一个可共享的写端；
//! 服务端 = 一个 accept 线程 + 每个客户端一条读线程，发送时广播给所有在线客户端。
//!
//! 对应 Qt 版 `tcp_tab.py` 的两种模式，有以下刻意差异：
//! - 连接超时固定 2 秒且不提供「取消连接」：Windows 上阻塞中的 connect 无法可靠中断，
//!   与其放一个点了没反应的按钮，不如让用户等满 2 秒；
//! - 「不显示接收」只停止界面回显，字节统计照常累加（Qt 版会把统计一起停掉）；
//! - 服务端的「最大连接」是硬上限：Qt 版把它当成 listen backlog，实际拦不住多余连接。

use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// 发送内容的解析与十六进制显示与 UDP 共用一份实现，见 `codec.rs`
pub use crate::codec::{hex_of, parse_send_payload};

pub const EVT_TCP_DATA: &str = "tcp://data";
pub const EVT_TCP_STATUS: &str = "tcp://status";
pub const EVT_TCP_PEER: &str = "tcp://peer";

/// 与 Qt 版一致：整个连接过程总预算 2 秒（多个解析结果共用这个额度）
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// 读线程轮询粒度：太长会让断开慢半拍，太短会空转
const READ_POLL: Duration = Duration::from_millis(200);
/// accept 轮询粒度：`TcpListener` 没有 shutdown，停止只能靠轮询退出
const ACCEPT_POLL: Duration = Duration::from_millis(100);
/// 单次读取上限，与 Qt 版的 `recv(4096)` 对齐
const READ_CHUNK: usize = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpChunk {
    /// 收到时刻（Unix 毫秒）。由 Rust 打而不是前端补：
    /// 一条 TCP 流会连续吐很多包，前端补时间只会拿到「处理时刻」
    pub ts: i64,
    /// 本次收到的字节数
    pub len: usize,
    /// 大写十六进制，空格分隔
    pub hex: String,
    /// UTF-8 lossy 文本
    pub text: String,
    /// 服务端模式的来源 `地址:端口`；客户端模式只有一条连接，不带来源
    pub from: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpStatus {
    /// open / closed / error（connecting 由前端自己维护，不绕一圈 IPC）
    pub state: &'static str,
    pub remote: Option<String>,
    pub message: Option<String>,
}

/// 发送回执：前端按行内格式（ASCII / HEX）回显，不在 UI 侧重复解析一遍
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpSent {
    pub len: usize,
    pub hex: String,
    pub text: String,
    /// 写成几个连接：客户端恒为 1，服务端是广播成功数
    pub targets: usize,
}

/// 服务端在线客户端变化：连接、断开、被拒绝各发一条
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpPeerEvent {
    /// connected / disconnected / rejected
    pub kind: &'static str,
    pub peer: String,
    /// 变化之后的在线数量
    pub count: usize,
}

pub struct TcpSession {
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    writer: Arc<Mutex<TcpStream>>,
    remote: String,
}

impl TcpSession {
    pub fn remote(&self) -> &str {
        &self.remote
    }

    /// 写端单独暴露成 Arc：发送要进阻塞线程池，拿不到 `&self` 的借用
    pub fn writer(&self) -> Arc<Mutex<TcpStream>> {
        Arc::clone(&self.writer)
    }

    /// 收尾：先置停止位再 shutdown。顺序反过来的话，
    /// 读线程会把「自己关的」当成对端断开而误报一条 closed 状态
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.writer.lock().shutdown(Shutdown::Both);
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

/// 连接服务器。调用方负责把返回的会话放进 AppState，
/// 本函数不 emit open：连上与否是命令的返回值说了算
pub fn connect(app: AppHandle, host: &str, port: u16) -> Result<TcpSession, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("请输入服务器地址".to_string());
    }
    if port == 0 {
        return Err("端口必须在 1-65535 之间".to_string());
    }

    // 先把域名解析错误单独报出来：`connect` 自带的 "failed to lookup address" 不好懂
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("无法解析地址 {host}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("无法解析地址 {host}"));
    }

    // 按 getaddrinfo 的顺序逐个试，但总预算仍是 2 秒：
    // localhost 常常先返回 ::1，而服务端只监听 127.0.0.1，只试第一个地址会误报「连接被拒绝」
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut stream: Option<TcpStream> = None;
    let mut chosen: Option<SocketAddr> = None;
    let mut last_error: Option<(SocketAddr, std::io::Error)> = None;
    for addr in &addrs {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(addr, remaining) {
            Ok(connected) => {
                stream = Some(connected);
                chosen = Some(*addr);
                break;
            }
            Err(err) => last_error = Some((*addr, err)),
        }
    }

    let (stream, addr) = match (stream, chosen) {
        (Some(stream), Some(addr)) => (stream, addr),
        _ => {
            let Some((addr, err)) = last_error else {
                return Err(format!("无法连接 {host}:{port}"));
            };
            return Err(match err.kind() {
                ErrorKind::TimedOut => format!("连接超时：请检查网络并确认 {addr} 是否在监听"),
                _ => format!("连接失败: {err}"),
            });
        }
    };

    // 调试工具发的是短指令，攒包会让回包凭空晚 40ms
    let _ = stream.set_nodelay(true);
    stream
        .set_read_timeout(Some(READ_POLL))
        .map_err(|err| format!("设置读超时失败: {err}"))?;

    let reader_stream = stream
        .try_clone()
        .map_err(|err| format!("创建读句柄失败: {err}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let remote = addr.to_string();
    let reader = spawn_reader(app, reader_stream, Arc::clone(&stop), remote.clone());

    Ok(TcpSession {
        stop,
        reader: Some(reader),
        writer: Arc::new(Mutex::new(stream)),
        remote,
    })
}

fn spawn_reader(
    app: AppHandle,
    mut stream: TcpStream,
    stop: Arc<AtomicBool>,
    remote: String,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            match stream.read(&mut buf) {
                Ok(0) => {
                    // 对端正常关闭；本端主动 shutdown 时 stop 已置位，这里不会再报
                    if !stop.load(Ordering::Relaxed) {
                        emit_status(
                            &app,
                            "closed",
                            Some(remote.clone()),
                            Some("服务器已关闭连接".to_string()),
                        );
                    }
                    return;
                }
                Ok(len) => {
                    let bytes = &buf[..len];
                    let _ = app.emit(
                        EVT_TCP_DATA,
                        TcpChunk {
                            ts: chrono::Local::now().timestamp_millis(),
                            len,
                            hex: hex_of(bytes),
                            text: String::from_utf8_lossy(bytes).into_owned(),
                            from: None,
                        },
                    );
                }
                // 读超时是 200ms 轮询的正常出口，不是错误
                Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(err) if err.kind() == ErrorKind::Interrupted => {}
                Err(err) => {
                    if !stop.load(Ordering::Relaxed) {
                        emit_status(
                            &app,
                            "error",
                            Some(remote.clone()),
                            Some(format!("接收错误: {err}")),
                        );
                    }
                    return;
                }
            }
        }
    })
}

/// 持锁写完整一包。
///
/// `write_all` 在中途出错时已经有多少字节上线是不可知的，
/// 所以一旦返回错误，调用方必须把整条连接收掉，不能接着发下一条。
pub fn write_all(writer: &Arc<Mutex<TcpStream>>, bytes: &[u8]) -> Result<(), String> {
    let mut stream = writer.lock();
    stream
        .write_all(bytes)
        .map_err(|err| format!("发送失败: {err}"))?;
    stream.flush().map_err(|err| format!("发送失败: {err}"))
}

fn emit_status(
    app: &AppHandle,
    state: &'static str,
    remote: Option<String>,
    message: Option<String>,
) {
    let _ = app.emit(EVT_TCP_STATUS, TcpStatus { state, remote, message });
}

/* ---------------- 服务端模式 ---------------- */

/// 一个页面只有一条链路：要么连出去，要么听进来。
/// 收编成枚举而不是两个 Option，是为了让「先停旧的再起新的」只有一个入口
pub enum TcpLink {
    Client(TcpSession),
    Server(TcpServer),
}

impl TcpLink {
    /// 客户端是服务器地址，服务端是监听地址：界面上都用「这条链路的地址」描述
    pub fn endpoint(&self) -> &str {
        match self {
            TcpLink::Client(session) => session.remote(),
            TcpLink::Server(server) => server.local(),
        }
    }

    pub fn is_client(&self) -> bool {
        matches!(self, TcpLink::Client(_))
    }

    /// 发送目标快照：发送要进阻塞线程池，调用前先把借用变成 Arc
    pub fn send_target(&self) -> TcpSendTarget {
        match self {
            TcpLink::Client(session) => TcpSendTarget::Client(session.writer()),
            TcpLink::Server(server) => TcpSendTarget::Server(server.broadcaster()),
        }
    }

    pub fn stop(&mut self) {
        match self {
            TcpLink::Client(session) => session.stop(),
            TcpLink::Server(server) => server.stop(),
        }
    }
}

/// 发送目标：客户端是一条连接，服务端是一组连接
pub enum TcpSendTarget {
    Client(Arc<Mutex<TcpStream>>),
    Server(TcpBroadcaster),
}

impl TcpSendTarget {
    /// 返回实际写成的连接数：客户端恒为 1，服务端是广播成功数
    pub fn send(self, bytes: &[u8]) -> Result<usize, String> {
        match self {
            TcpSendTarget::Client(writer) => write_all(&writer, bytes).map(|()| 1),
            TcpSendTarget::Server(broadcaster) => broadcaster.send(bytes),
        }
    }
}

/// 服务端：一个 accept 线程 + 每个客户端一条读线程。
///
/// `TcpListener` 没有 shutdown，停止只能靠非阻塞 accept 轮询；
/// 比起「自连一次监听端口来打断 accept」这种技巧，100ms 醒一次更容易说清楚。
pub struct TcpServer {
    stop: Arc<AtomicBool>,
    local: String,
    acceptor: Option<JoinHandle<()>>,
    clients: Arc<Mutex<Vec<ClientSlot>>>,
}

struct ClientSlot {
    writer: Arc<Mutex<TcpStream>>,
    /// 该客户端读线程的停止位：线程退出时置 true，广播就会跳过死连接
    stop: Arc<AtomicBool>,
    reader: JoinHandle<()>,
}

impl TcpServer {
    /// 实际监听地址（`0.0.0.0:8000` 这种），比用户输入的 host 更能说明问题
    pub fn local(&self) -> &str {
        &self.local
    }

    /// 广播端快照：发送要进阻塞线程池，拿不到 `&self` 的借用
    pub fn broadcaster(&self) -> TcpBroadcaster {
        TcpBroadcaster {
            clients: Arc::clone(&self.clients),
        }
    }

    /// 收尾：先置停止位再 shutdown。
    /// 顺序反过来的话，每个客户端的读线程都会把「自己关的」报成「客户端断开」
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let slots = std::mem::take(&mut *self.clients.lock());
        // 先全部 shutdown，把阻塞在 read 上的线程叫醒，再统一 join：
        // 一个个 shutdown+join 的话，最坏要等 N × 200ms
        for slot in &slots {
            slot.stop.store(true, Ordering::Relaxed);
            let _ = slot.writer.lock().shutdown(Shutdown::Both);
        }
        for slot in slots {
            let _ = slot.reader.join();
        }
        if let Some(handle) = self.acceptor.take() {
            let _ = handle.join();
        }
    }
}

/// 广播端快照：调用方先拿 `Arc` 化的副本，再进阻塞线程池
#[derive(Clone)]
pub struct TcpBroadcaster {
    clients: Arc<Mutex<Vec<ClientSlot>>>,
}

impl TcpBroadcaster {
    /// 写一包给所有在线客户端，返回写成功的个数。
    /// 单个客户端失败不影响其他客户端：TCP 的失败是连接级的，不是服务级的
    pub fn send(&self, bytes: &[u8]) -> Result<usize, String> {
        let slots = self.clients.lock();
        if slots.is_empty() {
            return Err("还没有客户端连接，无法发送".to_string());
        }
        let mut live = 0usize;
        let mut sent = 0usize;
        for slot in slots.iter() {
            if slot.stop.load(Ordering::Relaxed) {
                continue;
            }
            live += 1;
            let mut stream = slot.writer.lock();
            if stream.write_all(bytes).is_ok() {
                let _ = stream.flush();
                sent += 1;
            }
        }
        if live == 0 {
            return Err("所有客户端都已断开，发送失败".to_string());
        }
        if sent == 0 {
            return Err("写入失败，客户端可能已经断开".to_string());
        }
        Ok(sent)
    }
}

/// 开始监听。调用方负责把返回的服务端放进 AppState，
/// 本函数不 emit open：监听起来与否是命令的返回值说了算
pub fn listen(
    app: AppHandle,
    host: &str,
    port: u16,
    max_clients: usize,
) -> Result<TcpServer, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("请输入监听地址（0.0.0.0 表示所有网卡）".to_string());
    }
    if port == 0 {
        return Err("端口必须在 1-65535 之间".to_string());
    }
    let max_clients = max_clients.max(1);

    // localhost 可能先解析到 ::1，逐个试到绑上为止
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("无法解析地址 {host}: {err}"))?
        .collect();
    let mut listener: Option<TcpListener> = None;
    let mut last_error: Option<std::io::Error> = None;
    for addr in addrs {
        match TcpListener::bind(addr) {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(err) => last_error = Some(err),
        }
    }
    let Some(listener) = listener else {
        return Err(match last_error {
            Some(err) if err.kind() == ErrorKind::AddrInUse => {
                format!("{host}:{port} 已被占用，请换一个监听端口")
            }
            Some(err) => format!("监听 {host}:{port} 失败: {err}"),
            None => format!("无法解析地址 {host}"),
        });
    };

    listener
        .set_nonblocking(true)
        .map_err(|err| format!("设置非阻塞失败: {err}"))?;
    let local = listener
        .local_addr()
        .map(|addr| addr.to_string())
        .unwrap_or_else(|_| format!("{host}:{port}"));

    let stop = Arc::new(AtomicBool::new(false));
    let clients: Arc<Mutex<Vec<ClientSlot>>> = Arc::new(Mutex::new(Vec::new()));
    let online = Arc::new(AtomicUsize::new(0));
    let acceptor = spawn_acceptor(
        app,
        listener,
        Arc::clone(&stop),
        Arc::clone(&clients),
        Arc::clone(&online),
        max_clients,
        local.clone(),
    );

    Ok(TcpServer {
        stop,
        local,
        acceptor: Some(acceptor),
        clients,
    })
}

fn spawn_acceptor(
    app: AppHandle,
    listener: TcpListener,
    server_stop: Arc<AtomicBool>,
    clients: Arc<Mutex<Vec<ClientSlot>>>,
    online: Arc<AtomicUsize>,
    max_clients: usize,
    local: String,
) -> JoinHandle<()> {
    thread::spawn(move || loop {
        if server_stop.load(Ordering::Relaxed) {
            return;
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                let peer = peer.to_string();
                let count = online.load(Ordering::Relaxed);
                if count >= max_clients {
                    // 硬上限：先关掉再报告，避免客户端以为连上了却没人在读
                    let _ = stream.shutdown(Shutdown::Both);
                    emit_peer(&app, "rejected", peer, count);
                    continue;
                }
                let _ = stream.set_nodelay(true);
                let _ = stream.set_read_timeout(Some(READ_POLL));
                let reader_stream = match stream.try_clone() {
                    Ok(cloned) => cloned,
                    Err(err) => {
                        emit_status(
                            &app,
                            "error",
                            Some(local.clone()),
                            Some(format!("创建客户端句柄失败: {err}")),
                        );
                        continue;
                    }
                };
                let stop = Arc::new(AtomicBool::new(false));
                let writer = Arc::new(Mutex::new(stream));
                let online_after = online.fetch_add(1, Ordering::Relaxed) + 1;
                let reader = spawn_client_reader(
                    app.clone(),
                    reader_stream,
                    Arc::clone(&stop),
                    Arc::clone(&server_stop),
                    Arc::clone(&online),
                    peer.clone(),
                );
                clients.lock().push(ClientSlot {
                    writer,
                    stop,
                    reader,
                });
                emit_peer(&app, "connected", peer, online_after);
            }
            // 非阻塞 accept 的空转出口
            Err(err) if err.kind() == ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            Err(err) => {
                if !server_stop.load(Ordering::Relaxed) {
                    emit_status(
                        &app,
                        "error",
                        Some(local.clone()),
                        Some(format!("服务端接收错误: {err}")),
                    );
                }
                return;
            }
        }
    })
}

fn spawn_client_reader(
    app: AppHandle,
    mut stream: TcpStream,
    stop: Arc<AtomicBool>,
    server_stop: Arc<AtomicBool>,
    online: Arc<AtomicUsize>,
    peer: String,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(len) => {
                    let bytes = &buf[..len];
                    let _ = app.emit(
                        EVT_TCP_DATA,
                        TcpChunk {
                            ts: chrono::Local::now().timestamp_millis(),
                            len,
                            hex: hex_of(bytes),
                            text: String::from_utf8_lossy(bytes).into_owned(),
                            from: Some(peer.clone()),
                        },
                    );
                }
                Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(err) if err.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }

        // 读线程自己退出 = 这个客户端没了：标记死连接好让广播跳过它，再告诉前端
        stop.store(true, Ordering::Relaxed);
        if !server_stop.load(Ordering::Relaxed) {
            let count = online.fetch_sub(1, Ordering::Relaxed).saturating_sub(1);
            emit_peer(&app, "disconnected", peer, count);
        }
    })
}

fn emit_peer(app: &AppHandle, kind: &'static str, peer: String, count: usize) {
    let _ = app.emit(EVT_TCP_PEER, TcpPeerEvent { kind, peer, count });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// listen / accept 需要 AppHandle，这里只测不需要事件的那一半：广播怎么写、怎么计数
    fn slot_with(stream: TcpStream) -> ClientSlot {
        ClientSlot {
            writer: Arc::new(Mutex::new(stream)),
            stop: Arc::new(AtomicBool::new(false)),
            reader: thread::spawn(|| {}),
        }
    }

    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        (server, client)
    }

    #[test]
    fn broadcast_without_clients_says_so() {
        let broadcaster = TcpBroadcaster {
            clients: Arc::new(Mutex::new(Vec::new())),
        };
        let err = broadcaster.send(b"x").unwrap_err();
        assert!(err.contains("还没有客户端连接"));
    }

    #[test]
    fn broadcast_reaches_every_client() {
        let (server_a, mut client_a) = pair();
        let (server_b, mut client_b) = pair();
        let broadcaster = TcpBroadcaster {
            clients: Arc::new(Mutex::new(vec![slot_with(server_a), slot_with(server_b)])),
        };

        assert_eq!(broadcaster.send(b"ping").unwrap(), 2);

        let mut buf = [0u8; 4];
        client_a.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping");
        client_b.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping");
    }

    #[test]
    fn broadcast_skips_clients_whose_reader_exited() {
        let (server, mut client) = pair();
        let mut slot = slot_with(server);
        // 读线程退出时会把停止位置起来，广播就该跳过这条死连接
        slot.stop = Arc::new(AtomicBool::new(true));
        let broadcaster = TcpBroadcaster {
            clients: Arc::new(Mutex::new(vec![slot])),
        };

        let err = broadcaster.send(b"x").unwrap_err();
        assert_eq!(err, "所有客户端都已断开，发送失败");
        // 对端不该收到任何东西
        client
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let mut buf = [0u8; 1];
        assert!(client.read(&mut buf).is_err());
    }
}
