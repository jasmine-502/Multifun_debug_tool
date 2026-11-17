use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::esp_flash;
use crate::firmware_merge;
use crate::ports::{self, PortInfo};
use crate::serial_reader::{self, AutosaveStatus, OpenRequest, SplitMode};
use crate::state::{AppState, Session};
use crate::tcp_client::{self, TcpLink, TcpSent, TcpStatus, EVT_TCP_STATUS};
use crate::udp_socket::{self, UdpSent, UdpStatus, EVT_UDP_STATUS};

/// 默认日志目录：exe 同级的 `logs/`，与 PySide6 版打包后的行为一致
pub fn default_log_dir_path() -> PathBuf {
    let base = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("logs")
}

pub fn stop_session(state: &AppState) {
    let taken = state.session.lock().take();
    if let Some(Session { stop, handle }) = taken {
        stop.store(true, Ordering::Relaxed);
        let _ = handle.join();
    }
}

#[tauri::command]
pub fn list_ports(state: State<'_, AppState>) -> Vec<PortInfo> {
    let blocked = state.blacklist.lock().clone();
    ports::collect(&blocked)
}

#[tauri::command]
pub fn open_log(
    app: AppHandle,
    state: State<'_, AppState>,
    port: String,
    baud: u32,
    label: String,
    reset: Option<bool>,
    autosave: Option<bool>,
    generic: Option<bool>,
    split: Option<String>,
    fixed_size: Option<u32>,
    idle_ms: Option<u32>,
) -> Result<(), String> {
    if state.session.lock().is_some() {
        return Err("串口已经打开，请先关闭".to_string());
    }

    let generic = generic.unwrap_or(false);
    let split = match split.as_deref().unwrap_or("crlf") {
        "idle" => SplitMode::Idle,
        "fixed" => SplitMode::Fixed,
        _ => SplitMode::CrLf,
    };

    // 必须在起读线程之前把自动保存意图写进去：
    // 读线程一启动就会 reconcile_writer，晚一步就会丢掉开头几十行。
    state.autosave.lock().enabled = autosave.unwrap_or(true);
    // 过滤语义也得先定下来：通用模式不看日志名，改按关键字包含判断
    state.filters.lock().generic = generic;

    let request = OpenRequest {
        port,
        baud,
        label,
        reset: reset.unwrap_or(false),
        generic,
        split,
        fixed_size: fixed_size.unwrap_or(64).clamp(1, 4096) as usize,
        idle_ms: idle_ms.unwrap_or(50).clamp(5, 2000) as u64,
    };
    let (stop, handle) = serial_reader::spawn(
        app,
        request,
        Arc::clone(&state.filters),
        Arc::clone(&state.autosave),
    )?;

    *state.session.lock() = Some(Session { stop, handle });
    Ok(())
}

#[tauri::command]
pub fn close_log(state: State<'_, AppState>) -> Result<(), String> {
    stop_session(&state);
    Ok(())
}

#[tauri::command]
pub fn set_filters(
    state: State<'_, AppState>,
    levels: HashMap<String, bool>,
    tags: String,
    generic: Option<bool>,
) {
    let mut guard = state.filters.lock();
    guard.levels = levels;
    guard.tags = tags;
    if let Some(generic) = generic {
        guard.generic = generic;
    }
}

#[tauri::command]
pub fn set_autosave(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    dir: Option<String>,
) {
    {
        let mut guard = state.autosave.lock();
        guard.enabled = enabled;
        guard.dir = dir.map(PathBuf::from);
    }

    // 关闭时立即通知 UI，不必等读线程下一次轮询
    if !enabled {
        let _ = app.emit(
            "esp://autosave",
            AutosaveStatus {
                enabled: false,
                path: None,
            },
        );
    }
}

/// 让自动保存的落盘格式跟随界面显示。
///
/// 不并入 `set_autosave`：那个是「要不要存」，这个是「怎么存」。
/// 格式变了读线程会把当前文件收尾并另开一个，不会在同一文件里混写。
#[tauri::command]
pub fn set_autosave_format(state: State<'_, AppState>, hex: bool, timestamp: bool) {
    let mut guard = state.autosave.lock();
    guard.hex = hex;
    guard.timestamp = timestamp;
}

#[tauri::command]
pub fn save_snapshot(path: String, content: String) -> Result<(), String> {
    use std::io::Write;

    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
        }
    }

    let mut file =
        std::fs::File::create(&target).map_err(|err| format!("创建文件失败: {err}"))?;

    // 文件头与 PySide6 版 `_save_logs_once` 保持一致，方便两版日志互相比对
    let header = format!(
        "ESP32 日志文件\n保存时间: {}\n{}\n\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        "=".repeat(50)
    );
    file.write_all(header.as_bytes())
        .map_err(|err| format!("写入失败: {err}"))?;
    file.write_all(content.as_bytes())
        .map_err(|err| format!("写入失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn default_log_dir() -> String {
    default_log_dir_path().display().to_string()
}

/// 把前端缓存行的十六进制还原成原始字节写文件。
/// 这是唯一无损的导出路径：文本快照已经过 `from_utf8_lossy`，不可逆。
#[tauri::command]
pub fn save_raw_snapshot(path: String, hex_lines: String) -> Result<(), String> {
    let mut bytes: Vec<u8> = Vec::with_capacity(hex_lines.len() / 3 + 16);
    for line in hex_lines.lines() {
        let mut high: Option<u8> = None;
        for ch in line.chars() {
            let value = match ch.to_digit(16) {
                Some(value) => value as u8,
                // 空白、逗号等分隔符直接跳过
                None => continue,
            };
            match high.take() {
                None => high = Some(value),
                Some(high_nibble) => bytes.push((high_nibble << 4) | value),
            }
        }
        if high.is_some() {
            return Err("十六进制数据长度不是偶数，无法还原字节".to_string());
        }
    }

    if bytes.is_empty() {
        return Err("当前没有可保存的数据".to_string());
    }

    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
        }
    }
    std::fs::write(&target, &bytes).map_err(|err| format!("写入失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_log_dir() -> Result<(), String> {
    let dir = default_log_dir_path();
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建日志目录失败: {err}"))?;
    reveal(&dir).map_err(|err| format!("打开目录失败: {err}"))
}

#[cfg(target_os = "windows")]
fn reveal(dir: &Path) -> std::io::Result<()> {
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn reveal(dir: &Path) -> std::io::Result<()> {
    std::process::Command::new("open")
        .arg(dir)
        .spawn()
        .map(|_| ())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn reveal(dir: &Path) -> std::io::Result<()> {
    std::process::Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
}

/* ---------------- 固件合并 ---------------- */

/// 扫 build 目录：优先 flasher_args.json，回退到常见文件名，顺便取版本号 / 项目名
#[tauri::command]
pub fn scan_firmware(root: String) -> Result<firmware_merge::ScanResult, String> {
    firmware_merge::scan(&root)
}

/// 按偏移拼接，写到 output_dir（留空则用项目根目录）/ filename
#[tauri::command]
pub fn merge_firmware(
    entries: Vec<firmware_merge::MergeEntry>,
    root: String,
    output_dir: String,
    filename: String,
) -> Result<firmware_merge::MergeResult, String> {
    firmware_merge::merge(&entries, &root, &output_dir, &filename)
}

/* ---------------- ESP32 烧录 ---------------- */

/// 烧录页不常驻串口，但日志页可能会占着同一个端口：
/// 提前给一句中文提示，比让 espflash 报 "access denied" 好懂
fn ensure_serial_free(state: &AppState) -> Result<(), String> {
    if state.session.lock().is_some() {
        return Err("ESP32 日志页正在占用串口，请先关闭日志再烧录".to_string());
    }
    Ok(())
}

/// 烧录会阻塞几秒到几十秒，必须放到阻塞线程池：
/// 同步命令跑在主线程上会把整个界面卡住，进度事件也刷不出来
async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("后台任务异常退出: {err}"))?
}

#[tauri::command]
pub async fn esp_flash(
    app: AppHandle,
    state: State<'_, AppState>,
    port: String,
    baud: u32,
    chip: String,
    entries: Vec<esp_flash::FlashEntry>,
) -> Result<esp_flash::FlashReport, String> {
    ensure_serial_free(&state)?;
    run_blocking(move || esp_flash::flash(&app, &port, baud, &chip, &entries)).await
}

#[tauri::command]
pub async fn esp_erase(
    app: AppHandle,
    state: State<'_, AppState>,
    port: String,
    baud: u32,
    chip: String,
) -> Result<esp_flash::FlashReport, String> {
    ensure_serial_free(&state)?;
    run_blocking(move || esp_flash::erase(&app, &port, baud, &chip)).await
}

#[tauri::command]
pub async fn esp_detect(
    app: AppHandle,
    state: State<'_, AppState>,
    port: String,
    baud: u32,
    chip: String,
) -> Result<esp_flash::ChipInfo, String> {
    ensure_serial_free(&state)?;
    run_blocking(move || esp_flash::detect(&app, &port, baud, &chip)).await
}

/* ---------------- TCP 客户端 / 服务端 ---------------- */

/// 收掉 TCP 链路：关窗、点断开、发送失败后共用同一个入口，避免三处各写一遍
pub fn stop_tcp(state: &AppState) {
    if let Some(mut link) = state.tcp.lock().take() {
        link.stop();
    }
}

/// 连接服务器。连接超时 2 秒，跑在阻塞线程池里，不占主线程
#[tauri::command]
pub async fn tcp_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> Result<String, String> {
    // 重复点连接时先收掉旧连接，否则旧读线程会继续往界面上推数据
    stop_tcp(&state);

    let handle = app.clone();
    let (session, remote) = run_blocking(move || {
        tcp_client::connect(handle, &host, port).map(|session| {
            let remote = session.remote().to_string();
            (session, remote)
        })
    })
    .await?;

    *state.tcp.lock() = Some(TcpLink::Client(session));
    let _ = app.emit(
        EVT_TCP_STATUS,
        TcpStatus {
            state: "open",
            remote: Some(remote.clone()),
            message: None,
        },
    );
    Ok(remote)
}

#[tauri::command]
pub async fn tcp_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    // 服务端要等 N 条读线程退出，别让同步命令把主线程按住
    let Some(mut link) = state.tcp.lock().take() else {
        return Ok(());
    };
    run_blocking(move || {
        link.stop();
        Ok(())
    })
    .await
}

/// 开始监听。与连接一样跑在阻塞线程池里，返回实际监听地址
#[tauri::command]
pub async fn tcp_listen(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    port: u16,
    max_clients: u16,
) -> Result<String, String> {
    // 重复点启动时先收掉旧链路，否则旧 accept 线程会继续收客户端
    stop_tcp(&state);

    let handle = app.clone();
    let (server, local) = run_blocking(move || {
        tcp_client::listen(handle, &host, port, max_clients as usize).map(|server| {
            let local = server.local().to_string();
            (server, local)
        })
    })
    .await?;

    *state.tcp.lock() = Some(TcpLink::Server(server));
    let _ = app.emit(
        EVT_TCP_STATUS,
        TcpStatus {
            state: "open",
            remote: Some(local.clone()),
            message: None,
        },
    );
    Ok(local)
}

/// 发送一包。客户端发给服务器，服务端广播给所有在线客户端
#[tauri::command]
pub async fn tcp_send(
    app: AppHandle,
    state: State<'_, AppState>,
    data: String,
    hex: bool,
) -> Result<TcpSent, String> {
    let bytes = tcp_client::parse_send_payload(&data, hex)?;
    if bytes.is_empty() {
        return Err("发送内容不能为空".to_string());
    }
    // 先把回执要用的字节表示备好：bytes 一旦 move 进闭包就拿不回来了
    let len = bytes.len();
    let hex = tcp_client::hex_of(&bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();

    // 发送目标先取出来再 await：MutexGuard 不能跨越 await 点
    let (target, is_client, endpoint) = {
        let guard = state.tcp.lock();
        let link = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，无法发送".to_string())?;
        (link.send_target(), link.is_client(), link.endpoint().to_string())
    };

    match run_blocking(move || target.send(&bytes)).await {
        Ok(targets) => Ok(TcpSent {
            len,
            hex,
            text,
            targets,
        }),
        Err(err) => {
            // 客户端写失败说明这条连接已经半包上线、不可信，必须收掉；
            // 服务端只是某个客户端掉了，监听本身没问题，别因为一次广播失败把服务停掉
            if is_client {
                stop_tcp(&state);
                let _ = app.emit(
                    EVT_TCP_STATUS,
                    TcpStatus {
                        state: "error",
                        remote: Some(endpoint),
                        message: Some(err.clone()),
                    },
                );
            }
            Err(err)
        }
    }
}

/* ---------------- UDP 通信 ---------------- */

/// 收掉 UDP socket：关窗、点停止、接收线程出错后共用同一个入口
pub fn stop_udp(state: &AppState) {
    if let Some(mut session) = state.udp.lock().take() {
        session.stop();
    }
}

/// 绑定本地端口开始收发。bind 和 join 组播都是瞬间完成的操作，不必进阻塞线程池
#[tauri::command]
pub fn udp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    local_host: String,
    local_port: u16,
    broadcast: bool,
    multicast: bool,
    group: String,
) -> Result<String, String> {
    // 重复点启动时先收掉旧 socket，否则旧读线程会继续把数据推到界面上
    stop_udp(&state);

    let session = udp_socket::start(
        app.clone(),
        &local_host,
        local_port,
        broadcast,
        multicast,
        &group,
    )?;
    let local = session.local().to_string();
    *state.udp.lock() = Some(session);
    let _ = app.emit(
        EVT_UDP_STATUS,
        UdpStatus {
            state: "open",
            local: Some(local.clone()),
            message: None,
        },
    );
    Ok(local)
}

#[tauri::command]
pub fn udp_stop(state: State<'_, AppState>) {
    stop_udp(&state);
}

/// 发送一包。`host` 为空表示服务端模式：由后端回给最近一次收到报文的来源
#[tauri::command]
pub async fn udp_send(
    state: State<'_, AppState>,
    data: String,
    hex: bool,
    host: String,
    port: u16,
) -> Result<UdpSent, String> {
    let bytes = udp_socket::parse_send_payload(&data, hex)?;
    if bytes.is_empty() {
        return Err("发送内容不能为空".to_string());
    }

    // socket 先取出来再 await：MutexGuard 不能跨越 await 点
    let (socket, last_peer) = {
        let guard = state.udp.lock();
        let session = guard
            .as_ref()
            .ok_or_else(|| "尚未启动，无法发送".to_string())?;
        (session.socket(), session.last_peer())
    };

    // 先把回执要用的字节表示备好：bytes 一旦 move 进闭包就拿不回来了
    let len = bytes.len();
    let hex = udp_socket::hex_of(&bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();

    let to = run_blocking(move || udp_socket::send(&socket, &last_peer, &bytes, &host, port)).await?;
    Ok(UdpSent {
        len,
        hex,
        text,
        to,
    })
}