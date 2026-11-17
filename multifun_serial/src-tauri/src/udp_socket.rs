//! UDP 收发：一个 socket = 一个读线程 + 一个可共享的发送端。
//!
//! 对应 Qt 版 `udp_tab.py`。Qt 版有两处「勾了但没生效」的开关，这里补成真实现：
//! - 广播只是个勾选框，从没设过 `SO_BROADCAST`，发 255.255.255.255 会直接失败；
//! - 组播只启用了地址输入框，既没 join 组播组也没设 TTL，收和发都不成立。
//!
//! 另外服务端模式不再把远程输入框藏成摆设：远程留空就回复最近一次收到报文的来源，
//! 否则「服务端」只能看不能答，调试时还得另开一个客户端。

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// 发送内容的解析与十六进制显示与 TCP 共用一份实现，见 `codec.rs`
pub use crate::codec::{hex_of, parse_send_payload};

pub const EVT_UDP_DATA: &str = "udp://data";
pub const EVT_UDP_STATUS: &str = "udp://status";

/// 读线程轮询粒度：与 TCP 保持一致，停止时最多等一个轮询
const READ_POLL: Duration = Duration::from_millis(200);
/// 单个数据报的读取上限，与 Qt 版的 `recvfrom(4096)` 对齐
const READ_CHUNK: usize = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpChunk {
    /// 收到时刻（Unix 毫秒），由 Rust 打，前端补的只会是处理时刻
    pub ts: i64,
    /// 本次数据报的字节数
    pub len: usize,
    /// 大写十六进制，空格分隔
    pub hex: String,
    /// UTF-8 lossy 文本
    pub text: String,
    /// 来源 `地址:端口`：UDP 没有连接，界面上「谁发的」全靠这个字段
    pub from: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpStatus {
    /// open / error（停止由前端自己记，不绕一圈 IPC）
    pub state: &'static str,
    /// 实际绑定到的 `地址:端口`：本地端口填 0 时这里才是系统分到的端口
    pub local: Option<String>,
    pub message: Option<String>,
}

/// 发送回执：界面按行内格式回显，不在 UI 侧重复解析一遍
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpSent {
    pub len: usize,
    pub hex: String,
    pub text: String,
    /// 实际发往的 `地址:端口`：回复模式下的目标是后端自己挑的
    pub to: String,
}

pub struct UdpSession {
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    socket: Arc<UdpSocket>,
    local: String,
    /// 最近一次收到报文的来源：服务端模式留空目标时回给这里
    last_peer: Arc<Mutex<Option<SocketAddr>>>,
}

impl UdpSession {
    pub fn local(&self) -> &str {
        &self.local
    }

    /// 发送端单独暴露成 Arc：发送要进阻塞线程池，拿不到 `&self` 的借用
    pub fn socket(&self) -> Arc<UdpSocket> {
        Arc::clone(&self.socket)
    }

    pub fn last_peer(&self) -> Arc<Mutex<Option<SocketAddr>>> {
        Arc::clone(&self.last_peer)
    }

    /// UDP 没有 shutdown，只能靠读超时轮询退出：
    /// 先置停止位，`join` 最多等一个 READ_POLL
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

/// 绑定本地端口开始接收。调用方负责把返回的会话放进 AppState，
/// 本函数不 emit open：绑定成功与否是命令的返回值说了算
pub fn start(
    app: AppHandle,
    local_host: &str,
    local_port: u16,
    broadcast: bool,
    multicast: bool,
    group: &str,
) -> Result<UdpSession, String> {
    // 0.0.0.0 = 所有网卡；端口 0 = 交给系统分配，启动后把真实端口回报给界面
    let host = if local_host.trim().is_empty() {
        "0.0.0.0"
    } else {
        local_host.trim()
    };
    let listen = resolve_ipv4(host, local_port)?;
    let socket = UdpSocket::bind(listen).map_err(|err| match err.kind() {
        ErrorKind::AddrInUse => format!("{listen} 已被占用，请换一个本地端口"),
        _ => format!("绑定 {listen} 失败: {err}"),
    })?;

    if broadcast {
        socket
            .set_broadcast(true)
            .map_err(|err| format!("开启广播失败: {err}"))?;
    }

    if multicast {
        let group = parse_group(group)?;
        // 绑在具体网卡上时 join 也走同一块网卡；绑 0.0.0.0 就交给系统挑默认路由
        let interface = match socket.local_addr() {
            Ok(SocketAddr::V4(addr)) if !addr.ip().is_unspecified() => *addr.ip(),
            _ => Ipv4Addr::UNSPECIFIED,
        };
        socket
            .join_multicast_v4(&group, &interface)
            .map_err(|err| format!("加入组播组 {group} 失败: {err}"))?;
        // 调试工具没有跨路由分发组播的需求，TTL 固定 1
        socket
            .set_multicast_ttl_v4(1)
            .map_err(|err| format!("设置组播 TTL 失败: {err}"))?;
    }

    socket
        .set_read_timeout(Some(READ_POLL))
        .map_err(|err| format!("设置读超时失败: {err}"))?;

    let local = socket
        .local_addr()
        .map(|addr| addr.to_string())
        .unwrap_or_else(|_| listen.to_string());
    let socket = Arc::new(socket);
    let stop = Arc::new(AtomicBool::new(false));
    let last_peer = Arc::new(Mutex::new(None));
    let reader = spawn_reader(
        app,
        Arc::clone(&socket),
        Arc::clone(&stop),
        Arc::clone(&last_peer),
        local.clone(),
    );

    Ok(UdpSession {
        stop,
        reader: Some(reader),
        socket,
        local,
        last_peer,
    })
}

fn spawn_reader(
    app: AppHandle,
    socket: Arc<UdpSocket>,
    stop: Arc<AtomicBool>,
    last_peer: Arc<Mutex<Option<SocketAddr>>>,
    local: String,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            match socket.recv_from(&mut buf) {
                Ok((len, peer)) => {
                    *last_peer.lock() = Some(peer);
                    let bytes = &buf[..len];
                    let _ = app.emit(
                        EVT_UDP_DATA,
                        UdpChunk {
                            ts: chrono::Local::now().timestamp_millis(),
                            len,
                            hex: hex_of(bytes),
                            text: String::from_utf8_lossy(bytes).into_owned(),
                            from: peer.to_string(),
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
                            Some(local.clone()),
                            Some(format!("接收错误: {err}")),
                        );
                    }
                    return;
                }
            }
        }
    })
}

/// 发一包。
///
/// `host` 为空表示服务端模式：回给最近一次收到报文的来源。
/// UDP 没有连接，界面只有靠返回的目标地址才知道这一包发给了谁。
pub fn send(
    socket: &UdpSocket,
    last_peer: &Arc<Mutex<Option<SocketAddr>>>,
    bytes: &[u8],
    host: &str,
    port: u16,
) -> Result<String, String> {
    let target = if host.trim().is_empty() {
        let peer = *last_peer.lock();
        match peer {
            Some(addr) => addr,
            None => return Err("还没收到过报文，无法确定回复目标".to_string()),
        }
    } else {
        resolve_ipv4(host.trim(), port)?
    };
    socket
        .send_to(bytes, target)
        .map_err(|err| format!("发送失败: {err}"))?;
    Ok(target.to_string())
}

/// 只认 IPv4：广播与组播都只做 IPv4，与 Qt 版的 `AF_INET` 一致。
/// 域名先解析再挑，`localhost` 常常同时给出 ::1 和 127.0.0.1。
fn resolve_ipv4(host: &str, port: u16) -> Result<SocketAddr, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("无法解析地址 {host}: {err}"))?
        .collect();
    addrs
        .into_iter()
        .find(SocketAddr::is_ipv4)
        .ok_or_else(|| format!("UDP 只支持 IPv4，{host} 没有可用的 IPv4 地址"))
}

fn parse_group(text: &str) -> Result<Ipv4Addr, String> {
    let raw = text.trim();
    let group: Ipv4Addr = raw.parse().map_err(|_| format!("组播地址无效: {raw}"))?;
    if !group.is_multicast() {
        return Err(format!(
            "{group} 不是组播地址（应在 224.0.0.0 - 239.255.255.255 之间）"
        ));
    }
    Ok(group)
}

fn emit_status(
    app: &AppHandle,
    state: &'static str,
    local: Option<String>,
    message: Option<String>,
) {
    let _ = app.emit(EVT_UDP_STATUS, UdpStatus { state, local, message });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multicast_group_must_be_in_range() {
        assert!(parse_group("224.1.1.1").is_ok());
        assert!(parse_group("239.255.255.250").is_ok());
        assert!(parse_group("127.0.0.1").is_err());
        assert!(parse_group("not-an-ip").is_err());
    }

    #[test]
    fn resolve_keeps_only_ipv4() {
        let addr = resolve_ipv4("localhost", 8001).unwrap();
        assert!(addr.is_ipv4());
        assert_eq!(addr.port(), 8001);
        // 纯 IPv6 字面量没有可用的 IPv4 结果，要给出中文提示
        assert!(resolve_ipv4("::1", 8001).is_err());
    }

    /// 不依赖 AppHandle：直接验证「解析目标 + send_to」这条通路
    #[test]
    fn send_reaches_the_target_socket() {
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let target = receiver.local_addr().unwrap();

        let last_peer = Arc::new(Mutex::new(None));
        let to = send(&sender, &last_peer, b"ping", "127.0.0.1", target.port()).unwrap();
        assert_eq!(to, target.to_string());

        let mut buf = [0u8; 16];
        let (len, from) = receiver.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..len], b"ping");
        assert_eq!(from.port(), sender.local_addr().unwrap().port());
    }

    #[test]
    fn empty_host_replies_to_last_peer() {
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let peer = receiver.local_addr().unwrap();

        let last_peer = Arc::new(Mutex::new(Some(peer)));
        let to = send(&sender, &last_peer, b"pong", "", 0).unwrap();
        assert_eq!(to, peer.to_string());

        let mut buf = [0u8; 16];
        let (len, _) = receiver.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..len], b"pong");
    }

    #[test]
    fn service_mode_requires_a_peer() {
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let last_peer = Arc::new(Mutex::new(None));
        assert!(send(&sender, &last_peer, b"x", "", 0).is_err());
    }
}
