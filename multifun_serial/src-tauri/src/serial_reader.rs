use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serialport::SerialPort;
use tauri::{AppHandle, Emitter};

use crate::log_parser;
use crate::ports;
use crate::state::{AutosaveControl, Filters};

/// 批量阈值：攒够 50 行或距上次推送 33ms 就发一批，避免每行一次 IPC
const FLUSH_LINES: usize = 50;
const FLUSH_INTERVAL: Duration = Duration::from_millis(33);
const STATS_INTERVAL: Duration = Duration::from_secs(1);
/// 与 PySide6 版 `serial.Serial(..., timeout=0.1)` 保持一致
const READ_TIMEOUT: Duration = Duration::from_millis(100);
/// 长行/二进制噪声保护：残行缓存的硬上限
const PENDING_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub seq: u64,
    /// 切包时刻（Unix 毫秒）。由 Rust 打而不是前端补：
    /// IPC 是批量推送的，前端收到时同一批的几十行只能拿到同一个时间。
    pub ts: i64,
    pub level: &'static str,
    pub tag: Option<String>,
    pub raw: String,
    /// 原始字节的十六进制串（空格分隔，含行尾）。
    /// 不能从 raw 反推：`from_utf8_lossy` 已把非法字节换成 U+FFFD，
    /// 而 `\r\n` 在切行时就被去掉了——普通串口/二进制报文必须靠它才无损。
    pub hex: String,
}

/// 切包策略。通用串口的“行尾”不一定是 `\n`，二进制流甚至完全没有分隔符。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitMode {
    /// 遇 `\r` 或 `\n` 切（CRLF 算一个），ESP 模式固定用这个
    CrLf,
    /// 不靠分隔符，静默超过阈值就把攒到的字节整段切出
    Idle,
    /// 攒够固定字节数切一包，适合定长报文
    Fixed,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogBatch {
    pub seq: u64,
    pub lines: Vec<LogLine>,
    pub dropped: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub bytes: u64,
    #[serde(rename = "bytesPerSec")]
    pub bytes_per_sec: u64,
    pub lines: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnStatus {
    pub state: &'static str,
    pub port: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutosaveStatus {
    pub enabled: bool,
    pub path: Option<String>,
}

pub struct OpenRequest {
    pub port: String,
    pub baud: u32,
    pub label: String,
    /// 打开后是否主动复位设备（默认 false，纯日志监听不动控制线）
    pub reset: bool,
    /// 通用串口模式：不解析 ESP-IDF 前缀，改用关键字过滤
    pub generic: bool,
    pub split: SplitMode,
    /// `SplitMode::Fixed` 时的每包字节数
    pub fixed_size: usize,
    /// 静默切包阈值（毫秒）
    pub idle_ms: u64,
}

fn open_port(request: &OpenRequest) -> Result<Box<dyn SerialPort>, String> {
    serialport::new(&request.port, request.baud)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|err| format!("打开串口 {} 失败：{err}", request.port))
}

impl OpenRequest {
    /// 真正生效的切包策略：ESP 模式固定只认行尾，界面上的选择不参与
    fn effective_split(&self) -> SplitMode {
        if self.generic {
            self.split
        } else {
            SplitMode::CrLf
        }
    }
}

/// 自动保存文件头里的切包说明，方便事后回想这份日志是怎么切出来的
fn describe_split(split: SplitMode, fixed_size: usize, idle_ms: u64) -> String {
    match split {
        SplitMode::CrLf => "按行尾（CR / LF）".to_string(),
        SplitMode::Idle => format!("按空闲超时（{idle_ms}ms）"),
        SplitMode::Fixed => format!("按固定字节数（{fixed_size} 字节）"),
    }
}

/// 原始字节 → 大写十六进制串（空格分隔）。
/// 用 `write!` 直接追加到 String，避免每个字节都 format! 出一个小 String。
fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(bytes.len() * 3);
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        let _ = write!(out, "{byte:02X}");
    }
    out
}

/// 在 pending 里找下一个可以切出的位置（返回切出的字节数），None 表示还不够。
fn next_cut(pending: &[u8], split: SplitMode, fixed_size: usize) -> Option<usize> {
    match split {
        SplitMode::CrLf => {
            for (index, byte) in pending.iter().enumerate() {
                match byte {
                    b'\n' => return Some(index + 1),
                    b'\r' => {
                        // CRLF 当成一个行尾，否则会多切出一个空行
                        return Some(if pending.get(index + 1) == Some(&b'\n') {
                            index + 2
                        } else {
                            index + 1
                        });
                    }
                    _ => {}
                }
            }
            None
        }
        SplitMode::Fixed => (fixed_size > 0 && pending.len() >= fixed_size).then_some(fixed_size),
        // 只靠静默超时切包，正常情况下永远不够
        SplitMode::Idle => None,
    }
}

/// 自动保存的写句柄。
///
/// 格式跟着界面显示走：HEX 视图下如果还写原始字节，用户用记事本打开 `.txt`
/// 只会看到一堆乱码，与屏幕上看到的对不上。格式变了就收尾重开一个文件，
/// 否则同一个文件里前半段文本、后半段十六进制，两种都读不了。
struct AutosaveWriter {
    file: BufWriter<File>,
    path: PathBuf,
    hex: bool,
    timestamp: bool,
}

/// 把 pending 里已经能确定的包取走，生成 `LogLine`、写自动保存文件。
/// 抽成结构体是因为它要同时改 seq / 批量缓冲 / 写句柄 / 计数，
/// 全塞进 read_loop 的闭包会和借用检查打架。
struct LineFeed<'a> {
    filters: &'a Arc<Mutex<Filters>>,
    batch: &'a mut Vec<LogLine>,
    generic: bool,
    seq: u64,
    total_lines: u64,
}

impl LineFeed<'_> {
    /// 返回从 `pending` 头部消耗的字节数
    fn drain(
        &mut self,
        pending: &[u8],
        writer: &mut Option<AutosaveWriter>,
        split: SplitMode,
        fixed_size: usize,
        idle_ready: bool,
    ) -> usize {
        let mut consumed = 0usize;
        // 一次 drain 处理的都是本轮读到的一堆数据，取一次就够
        let now = chrono::Local::now();
        let ts = now.timestamp_millis();
        loop {
            let slice = &pending[consumed..];
            if slice.is_empty() {
                break;
            }

            let cut = match next_cut(slice, split, fixed_size) {
                Some(size) => size,
                // 无分隔符的流 / 半个包：静默够了就整段收下
                None if idle_ready => slice.len(),
                None => break,
            };
            let line_bytes = &slice[..cut];
            consumed += cut;

            // 行尾只用于切分，不进正文（但保留在 hex 里，二进制导出要它）
            let mut body = line_bytes;
            while let Some((&tail, rest)) = body.split_last() {
                if tail == b'\n' || tail == b'\r' {
                    body = rest;
                } else {
                    break;
                }
            }
            if body.is_empty() {
                continue;
            }

            let raw = String::from_utf8_lossy(body).into_owned();
            let (level, tag) = if self.generic {
                // 普通设备没有 ESP-IDF 前缀，硬解析只会把整行归为 None
                (log_parser::Level::Unknown, None)
            } else {
                log_parser::parse(&raw)
            };
            {
                let guard = self.filters.lock();
                if !guard.line_allowed(&raw, tag.as_deref(), level.as_str()) {
                    continue;
                }
            }

            self.seq += 1;
            self.total_lines += 1;

            if let Some(target) = writer.as_mut() {
                if target.timestamp {
                    let _ = write!(target.file, "{} ", now.format("%H:%M:%S%.3f"));
                }
                if target.hex {
                    // hex 串里已经包含了行尾字节，不再额外补换行
                    let _ = writeln!(target.file, "{}", hex_of(line_bytes));
                } else {
                    // 写原始字节：二进制数据经过 lossy 转换就不可逆了
                    let _ = target.file.write_all(body);
                    if split == SplitMode::CrLf {
                        let _ = target.file.write_all(b"\n");
                    }
                }
            }

            self.batch.push(LogLine {
                seq: self.seq,
                ts,
                level: level.as_str(),
                tag,
                hex: hex_of(line_bytes),
                raw,
            });
        }
        consumed
    }
}

/// 脉冲 EN 复位芯片（与 esptool 的 `hard_reset` 一致，只动 RTS）。
///
/// 电平约定（esptool 源码注释）：RTS = EN，active low，True = 0V = 芯片在复位；
/// DTR = GPIO0，active low，True = 0V = 进下载模式。
/// 所以本函数全程保持 DTR = false（GPIO0 高），只给 EN 一个脉冲 → 芯片重启后跑应用。
///
/// 每次 RTS 写入后补一次 DTR 写入：Windows 的 usbser.sys 不会单独下发 RTS 变化，
/// 这是 esptool `_setRTS` 里的同名变通。
fn pulse_reset(port: &mut Box<dyn SerialPort>) {
    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(true);
    let _ = port.write_data_terminal_ready(false);
    std::thread::sleep(Duration::from_millis(100));
    let _ = port.write_request_to_send(false);
    let _ = port.write_data_terminal_ready(false);
}

/// 原生 USB 口复位后会重新枚举，旧句柄失效，必须关掉重开
fn reopen_after_reset(request: &OpenRequest) -> Result<Box<dyn SerialPort>, String> {
    let mut last = String::new();
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(250));
        match open_port(request) {
            Ok(port) => return Ok(port),
            Err(err) => last = err,
        }
    }
    Err(format!(
        "复位后串口没有重新枚举（{last}）。请点「刷新端口」后重试，或改选 UART 桥对应的 COM 口。"
    ))
}

/// 打开串口并起读线程。返回停止标志与线程句柄，由 `AppState` 持有。
pub fn spawn(
    app: AppHandle,
    request: OpenRequest,
    filters: Arc<Mutex<Filters>>,
    autosave: Arc<Mutex<AutosaveControl>>,
) -> Result<(Arc<AtomicBool>, JoinHandle<()>), String> {
    let mut port = open_port(&request)?;

    // 复位是可选项，默认开启（与 PySide6 版行为一致：复位一次才能拿到启动日志）。
    // 但时序必须是“只脉冲 EN”，不是“DTR/RTS 同时拉高再归零”——
    // 后者会让 EN 释放的瞬间 GPIO0 仍为低，芯片直接进 download 模式。
    if request.reset {
        pulse_reset(&mut port);
        if ports::is_native_usb(&request.port) {
            drop(port);
            port = reopen_after_reset(&request)?;
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = std::thread::spawn(move || {
        read_loop(app, port, request, filters, autosave, thread_stop);
    });

    Ok((stop, handle))
}

fn read_loop(
    app: AppHandle,
    mut port: Box<dyn SerialPort>,
    request: OpenRequest,
    filters: Arc<Mutex<Filters>>,
    autosave: Arc<Mutex<AutosaveControl>>,
    stop: Arc<AtomicBool>,
) {
    let _ = app.emit(
        "esp://status",
        ConnStatus {
            state: "open",
            port: Some(request.port.clone()),
            message: None,
        },
    );

    let mut buffer = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::with_capacity(8192);
    let mut batch: Vec<LogLine> = Vec::with_capacity(FLUSH_LINES);
    let mut writer: Option<AutosaveWriter> = None;

    // 切包策略：ESP 模式固定只认行尾，保持与 PySide6 版完全一致
    let split = request.effective_split();
    // 静默切包只对通用模式开：ESP 日志里出现裸 \r 时切成碎片反而不如等下一个 \n
    let idle_limit = (request.generic && split != SplitMode::Fixed)
        .then(|| Duration::from_millis(request.idle_ms.clamp(5, 2000)));

    let mut feed = LineFeed {
        filters: &filters,
        batch: &mut batch,
        generic: request.generic,
        seq: 0,
        total_lines: 0,
    };

    let mut dropped: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut bytes_at_stats: u64 = 0;
    let mut last_flush = Instant::now();
    let mut last_stats = Instant::now();
    let mut last_rx = Instant::now();

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        // 自动保存的开关/目录由外部命令写入，这里按状态开启或收尾
        reconcile_writer(&app, &autosave, &mut writer, &request);

        match port.read(&mut buffer) {
            Ok(count) if count > 0 => {
                total_bytes += count as u64;
                pending.extend_from_slice(&buffer[..count]);
                last_rx = Instant::now();
            }
            Ok(_) => std::thread::sleep(Duration::from_millis(5)),
            Err(err) => {
                // Read::read 返回 std::io::Error，超时是正常路径，断开才终止
                let timed_out = err.kind() == io::ErrorKind::TimedOut;
                if !timed_out {
                    let _ = app.emit(
                        "esp://status",
                        ConnStatus {
                            state: "error",
                            port: Some(request.port.clone()),
                            message: Some(format!("串口断开: {err}")),
                        },
                    );
                    break;
                }
            }
        }

        // 静默到点了就把残段收下：没有分隔符的流只能这么切
        let idle_ready = idle_limit.is_some_and(|limit| last_rx.elapsed() >= limit);
        let consumed = feed.drain(&pending, &mut writer, split, request.fixed_size, idle_ready);
        if consumed > 0 {
            pending.drain(..consumed);
        }
        if pending.len() > PENDING_LIMIT {
            pending.clear();
            dropped += 1;
        }

        if !feed.batch.is_empty()
            && (feed.batch.len() >= FLUSH_LINES || last_flush.elapsed() >= FLUSH_INTERVAL)
        {
            let payload = LogBatch {
                seq: feed.seq,
                lines: std::mem::take(feed.batch),
                dropped: std::mem::take(&mut dropped),
            };
            let _ = app.emit("esp://log-batch", payload);
            last_flush = Instant::now();
            if let Some(target) = writer.as_mut() {
                let _ = target.file.flush();
            }
        }

        if last_stats.elapsed() >= STATS_INTERVAL {
            let payload = Stats {
                bytes: total_bytes,
                bytes_per_sec: total_bytes - bytes_at_stats,
                lines: feed.total_lines,
            };
            bytes_at_stats = total_bytes;
            let _ = app.emit("esp://stats", payload);
            last_stats = Instant::now();
        }
    }

    if !feed.batch.is_empty() {
        let _ = app.emit(
            "esp://log-batch",
            LogBatch {
                seq: feed.seq,
                lines: std::mem::take(feed.batch),
                dropped,
            },
        );
    }
    if let Some(mut target) = writer.take() {
        finish_writer(&mut target.file);
        let _ = app.emit(
            "esp://autosave",
            AutosaveStatus {
                enabled: false,
                path: Some(target.path.display().to_string()),
            },
        );
    }
    let _ = app.emit(
        "esp://status",
        ConnStatus {
            state: "closed",
            port: Some(request.port),
            message: None,
        },
    );
}

fn reconcile_writer(
    app: &AppHandle,
    control: &Arc<Mutex<AutosaveControl>>,
    writer: &mut Option<AutosaveWriter>,
    request: &OpenRequest,
) {
    let (enabled, dir, hex, timestamp) = {
        let guard = control.lock();
        (guard.enabled, guard.dir.clone(), guard.hex, guard.timestamp)
    };

    // 显示格式变了：同一个文件里前半段文本、后半段十六进制，谁也读不了，
    // 把当前文件正常收尾，下面按新格式另开一个（文件名带 _hex 区分）
    if let Some(current) = writer.as_ref() {
        if current.hex != hex || current.timestamp != timestamp {
            if let Some(mut old) = writer.take() {
                finish_writer(&mut old.file);
            }
        }
    }

    if enabled && writer.is_none() {
        let base = dir.unwrap_or_else(crate::commands::default_log_dir_path);
        // 按年月分层：logs/2026-11/ESP32_Log_20261115_143022.txt
        // 单目录堆上千个文件后 Windows 资源管理器打开会明显卡顿，
        // 而且按月份归档后，回头找"上周那次"比按时间戳文件名扫快得多
        let now = chrono::Local::now();
        let dir = base.join(now.format("%Y-%m").to_string());
        if std::fs::create_dir_all(&dir).is_err() {
            eprintln!("创建日志目录失败: {}", dir.display());
            return;
        }
        // 两种数据源分前缀：混在一个目录里时，从文件名就能看出是哪种日志
        let prefix = if request.generic { "Serial" } else { "ESP32" };
        let suffix = if hex { "_hex" } else { "" };
        let stamp = now.format("%Y%m%d_%H%M%S").to_string();
        let mut path = dir.join(format!("{prefix}_Log_{stamp}{suffix}.txt"));
        // 同一秒里切两次格式会撞名，而 File::create 会直接把上一个截断
        let mut index = 1;
        while path.exists() && index < 100 {
            index += 1;
            path = dir.join(format!("{prefix}_Log_{stamp}{suffix}_{index}.txt"));
        }

        match File::create(&path) {
            Ok(handle) => {
                let mut file = BufWriter::new(handle);
                // ESP 模式的文件头与 Python 版逐字一致；通用模式的设备根本没有
                // ESP-IDF 概念，写死 “ESP32 日志文件” 只会让人误会
                let _ = writeln!(
                    file,
                    "{}",
                    if request.generic {
                        "串口日志文件"
                    } else {
                        "ESP32 日志文件"
                    }
                );
                let _ = writeln!(
                    file,
                    "开始保存时间: {}",
                    now.format("%Y-%m-%d %H:%M:%S")
                );
                let _ = writeln!(file, "串口: {}", request.label);
                let _ = writeln!(file, "波特率: {}", request.baud);
                if request.generic {
                    let _ = writeln!(
                        file,
                        "切包: {}",
                        describe_split(
                            request.effective_split(),
                            request.fixed_size,
                            request.idle_ms
                        )
                    );
                }
                // HEX 文件的内容是十六进制文本，但文件头仍是可读的说明，
                // 否则过几天打开根本不知道这份日志是什么
                let _ = writeln!(
                    file,
                    "格式: {}{}",
                    if hex {
                        "十六进制（每行一个包，含行尾字节）"
                    } else {
                        "文本"
                    },
                    if timestamp { " · 行首时间戳" } else { "" }
                );
                let _ = writeln!(file, "{}", "=".repeat(50));
                let _ = writeln!(file);
                let _ = file.flush();

                let _ = app.emit(
                    "esp://autosave",
                    AutosaveStatus {
                        enabled: true,
                        path: Some(path.display().to_string()),
                    },
                );
                *writer = Some(AutosaveWriter {
                    file,
                    path,
                    hex,
                    timestamp,
                });
            }
            Err(err) => {
                eprintln!("创建日志文件失败 {}: {err}", path.display());
            }
        }
    } else if !enabled && writer.is_some() {
        if let Some(mut target) = writer.take() {
            finish_writer(&mut target.file);
            let _ = app.emit(
                "esp://autosave",
                AutosaveStatus {
                    enabled: false,
                    path: Some(target.path.display().to_string()),
                },
            );
        }
    }
}

fn finish_writer(file: &mut BufWriter<File>) {
    let _ = writeln!(
        file,
        "\n\n结束保存时间: {}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    let _ = file.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_uppercase_and_space_separated() {
        assert_eq!(hex_of(&[0x41, 0x0d, 0x0a]), "41 0D 0A");
        assert_eq!(hex_of(&[]), "");
    }

    #[test]
    fn crlf_counts_as_one_line_break() {
        let pending = b"AT\r\nOK\r\n";
        assert_eq!(next_cut(pending, SplitMode::CrLf, 0), Some(4));
        assert_eq!(next_cut(&pending[4..], SplitMode::CrLf, 0), Some(4));
    }

    #[test]
    fn bare_cr_also_splits() {
        // 只发 \r 的设备以前会永远攒不出行，现在必须能切
        assert_eq!(next_cut(b"123\r", SplitMode::CrLf, 0), Some(4));
    }

    #[test]
    fn idle_mode_ignores_separators() {
        assert_eq!(next_cut(b"no newline here", SplitMode::Idle, 0), None);
    }

    #[test]
    fn fixed_mode_waits_for_full_frame() {
        assert_eq!(next_cut(&[1, 2, 3], SplitMode::Fixed, 4), None);
        assert_eq!(next_cut(&[1, 2, 3, 4, 5], SplitMode::Fixed, 4), Some(4));
    }
}
