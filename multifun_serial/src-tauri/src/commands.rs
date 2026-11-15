use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::ports::{self, PortInfo};
use crate::serial_reader::{self, AutosaveStatus, OpenRequest, SplitMode};
use crate::state::{AppState, Session};

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
