//! ESP32 烧录：对齐 Qt 版 `debug_tool/app/esp32_flash_tab.py`。
//!
//! 旧版是拼 `esptool` 命令行、再解析 stdout 里的百分比和字段；这里直接调
//! [`espflash`] 操作串口：日志与进度都是结构化事件，不需要外部 Python 环境，
//! 也不用担心 esptool 换个版本就把正则打废。
//!
//! 与前端的契约只有三条命令：烧录、擦除、检测芯片。三者都用
//! [`OpenRequest`](crate::serial_reader) 之外的一次性连接：进来开串口，结束关串口，
//! 不常驻，因此不会出现「串口被烧录页攥着关不掉」的情况。

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::{FlashSize, Flasher};
use espflash::image_format::Segment;
use espflash::target::{Chip, ProgressCallbacks};
use log::{Level, LevelFilter, Log, Metadata, Record};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// 进度百分比（0~100）
pub const EVT_FLASH_PROGRESS: &str = "esp://flash/progress";
/// 一行操作日志，载荷 `{ text, level }`
pub const EVT_FLASH_LOG: &str = "esp://flash/log";

/// 三个动作共用同一个物理串口，同一时刻只允许一个任务
static BUSY: AtomicBool = AtomicBool::new(false);

/// 本页连接设备时固定的握手波特率：espflash 会先在这个速率下同步，
/// 成功后再切到用户选择的高速档（与 esptool 的做法一致）。
const SYNC_BAUD: u32 = 115_200;

/// Espressif 原生 USB-Serial-JTAG 的 PID，用来判断走的是芯片 USB 还是 UART 桥
const USB_SERIAL_JTAG_PID: u16 = 0x1001;

/* ---------------- espflash 日志桥 ---------------- */

/// espflash 用 `log` 输出复位策略、boot 模式、切波特率这些现场信息。
/// 应用里没有别的 logger，这里把它接到烧录页日志：
/// 「连不上」时能看到卡在哪一步，而不只是一句英文。
static LOG_SINK: OnceLock<AppHandle> = OnceLock::new();

struct EspFlashLog;

impl Log for EspFlashLog {
    fn enabled(&self, metadata: &Metadata) -> bool {
        // 只转发 espflash 自己的日志，其它 crate 的噪音一律不碰
        metadata.target().starts_with("espflash")
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let Some(app) = LOG_SINK.get() else {
            return;
        };
        let level = match record.level() {
            Level::Error => "error",
            Level::Warn => "warn",
            _ => "info",
        };
        log(app, format!("espflash: {}", record.args()), level);
    }

    fn flush(&self) {}
}

/// 在 setup 里调一次；已经有全局 logger（宿主注入）就不覆盖
pub fn install_logger(app: AppHandle) {
    let _ = LOG_SINK.set(app);
    if log::set_logger(&EspFlashLog).is_ok() {
        log::set_max_level(LevelFilter::Debug);
    }
}

/* ---------------- 前后端契约 ---------------- */

/// 界面表格里的一行烧录任务
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashEntry {
    /// 界面表格里的行号（从 1 起）。错误提示要指向用户看得见的那一行，
    /// 而勾选顺序和表格行号不一致，所以由前端带过来。
    #[serde(default)]
    pub row: Option<u32>,
    /// 表格原文。**一律按十六进制解释**：`0x10000` 与 `10000` 都是 0x10000，
    /// 与旧版 `_format_addr` 的行为保持一致（注意和固件合并页的十进制规则不同）。
    pub addr: String,
    pub path: String,
}

/// 烧录 / 擦除完成后的回执
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashReport {
    /// 实际连上的芯片，例如 `ESP32-C3`
    pub chip: String,
    /// 写入（或擦除范围）的字节数
    pub bytes: u64,
    /// 参与本次任务的 bin 文件数
    pub files: usize,
    pub elapsed_ms: u64,
}

/// 检测芯片的结果：字段名与旧版界面一一对应，取不到的填 `—`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChipInfo {
    pub chip: String,
    pub crystal: String,
    pub usb: String,
    pub mac: String,
    pub flash_size: String,
    pub flash_mode: String,
    pub flash_id: String,
    pub flash_voltage: String,
    pub features: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlashLog {
    pub text: String,
    pub level: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub percent: u8,
    /// 已写入字节数（整次任务累计，不是当前文件）
    pub written: u64,
    /// 本次任务要写的总字节数
    pub total: u64,
    /// 从开始写入直到此刻的平均速度（字节/秒），界面直接除 1024 用
    pub bytes_per_sec: u64,
}

/* ---------------- 互斥 ---------------- */

/// 占用标记，Drop 时自动释放：中途 return / panic 都不会把页面永久锁死
struct BusyGuard;

impl BusyGuard {
    fn acquire() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| BusyGuard)
            .map_err(|_| "已有烧录任务在执行，请等它结束".to_string())
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/* ---------------- 对外入口 ---------------- */

/// 烧录：一次性连接设备，把所有勾选的文件按各自地址写入。
pub fn flash(
    app: &AppHandle,
    port: &str,
    baud: u32,
    chip: &str,
    entries: &[FlashEntry],
) -> Result<FlashReport, String> {
    let _guard = BusyGuard::acquire()?;
    let started = Instant::now();

    // 先读文件再碰串口：路径写错时不该把设备复位一遍
    let plan = load_plan(entries)?;
    let total: u64 = plan.iter().map(|item| item.data.len() as u64).sum();

    log(app, format!("准备烧录 {} 个文件，共 {}", plan.len(), human_bytes(total)), "info");
    for item in &plan {
        log(
            app,
            format!("  0x{:x}  {}  ({})", item.addr, item.name, human_bytes(item.data.len() as u64)),
            "info",
        );
    }
    report(app, 0, 0, total, started);

    let Session { mut flasher, .. } = connect(app, port, baud, chip)?;
    let chip_name = chip_label(flasher.chip()).to_string();
    log(app, format!("已连接 {chip_name}，开始写入…"), "ok");

    let sizes: HashMap<u32, u64> =
        plan.iter().map(|item| (item.addr, item.data.len() as u64)).collect();
    let segments: Vec<Segment> = plan
        .iter()
        .map(|item| Segment {
            addr: item.addr,
            data: Cow::Borrowed(item.data.as_slice()),
        })
        .collect();

    let mut sink = ProgressSink {
        app,
        sizes,
        grand: total,
        started: Instant::now(),
        base: 0,
        seg: 0,
        seg_chunks: 1,
        last_pct: -1,
        last_at: Instant::now(),
    };
    // 速度只算真正开始写入之后的时间，不看读文件与握手的那几秒
    let write_started = sink.started;

    // write_bins_to_flash 内部最后会 reboot，所以不复位设备
    flasher
        .write_bins_to_flash(&segments, &mut sink)
        .map_err(|err| format!("烧录失败: {}", describe(&err)))?;
    drop(flasher);

    report(app, 100, total, total, write_started);
    let elapsed = started.elapsed().as_millis() as u64;
    // 速度按「写入耗时」算，与界面上的实时值同口径；耗时仍报整个任务（含握手）
    let write_ms = write_started.elapsed().as_millis() as u64;
    let speed = if write_ms == 0 {
        0
    } else {
        total * 1000 / write_ms
    };
    log(
        app,
        format!(
            "烧录完成：{} 个文件 / {}，用时 {:.1}s（写入 {:.1}s，平均 {}/s）",
            plan.len(),
            human_bytes(total),
            elapsed as f64 / 1000.0,
            write_ms as f64 / 1000.0,
            human_bytes(speed)
        ),
        "ok",
    );

    Ok(FlashReport {
        chip: chip_name,
        bytes: total,
        files: plan.len(),
        elapsed_ms: elapsed,
    })
}

/// 擦除整片 Flash。
///
/// 两个前提决定了这里的写法：
///
/// 1. **必须有 stub**。`EraseFlash(0xD0)` / `EraseRegion(0xD1)` 在 espflash 的
///    `command.rs` 里被归为 "Stub-only commands"，ROM 加载器根本不认——
///    真机上把 `EraseRegion` 发给 ROM，就是石沉大海 30 秒超时，再发 `EraseFlash`
///    又是几分钟无声。所以这里只走 [`connect_stub`]，连不上就直接报错。
/// 2. **不用 `erase_flash()`**。它是单条 `EraseFlash`，超时在 crate 里写死 120 秒，
///    而 32MB 的 NOR 芯片级擦除典型就 100 秒上下，正好卡边界。改成 1MB 一堆
///    `EraseRegion`：每块 30 秒预算（espflash 的 `ERASE_REGION_TIMEOUT_PER_MB`），
///    还能每块报一次进度。
pub fn erase(app: &AppHandle, port: &str, baud: u32, chip: &str) -> Result<FlashReport, String> {
    let _guard = BusyGuard::acquire()?;
    let started = Instant::now();

    let Session { mut flasher, stub } = connect_stub(app, port, baud, chip).map_err(|err| {
        format!(
            "{err}\n整片擦除必须在 stub 模式下做：ROM 加载器没有擦除命令（0xD0/0xD1 是 stub-only）。\
             可以直接开始烧录——烧录会按扇区自动擦除要写入的区域，不必先整片擦；\
             或者换台机器用 esptool erase_flash 擦。"
        )
    })?;
    let chip_name = chip_label(flasher.chip()).to_string();
    let info = flasher
        .device_info()
        .map_err(|err| format!("读取 Flash 容量失败: {}", describe(&err)))?;
    let total = flash_size_bytes(info.flash_size);
    log(
        app,
        format!(
            "开始擦除整片 Flash（{}，分 {} 块），期间请勿断电",
            flash_size_label(info.flash_size),
            total.div_ceil(ERASE_CHUNK)
        ),
        "warn",
    );

    let result = erase_chunks(app, &mut flasher, total, Instant::now());
    // 无论成败都让芯片正常启动，与 esptool 的 --after hard_reset 一致。
    // 4.x 起 reset_after 要自己交代是不是 stub，芯片型号也从 flasher 取
    let chip_kind = flasher.chip();
    let _ = flasher.connection().reset_after(stub, chip_kind);
    drop(flasher);

    // 出错就到此为止：超时后链路已经不同步，再补发一条整片擦除命令
    // 只会把等待时间翻倍（上一版就是这样卡了几十分钟）
    result.map_err(|err| format!("擦除失败: {}", describe(&err)))?;

    let elapsed = started.elapsed().as_millis() as u64;
    log(app, format!("擦除完成，用时 {:.1}s", elapsed as f64 / 1000.0), "ok");

    Ok(FlashReport {
        chip: chip_name,
        bytes: 0,
        files: 0,
        elapsed_ms: elapsed,
    })
}

/// 分块擦除的单块大小。
///
/// `EraseRegion` 的超时是 30 秒/MB，1MB 一块就有 30 秒预算、而实际只擦几秒：
/// 既有余量，万一卡住一分钟内也能退出来。
const ERASE_CHUNK: u32 = 1024 * 1024;

fn erase_chunks(
    app: &AppHandle,
    flasher: &mut Flasher,
    total: u32,
    started: Instant,
) -> Result<(), espflash::Error> {
    let mut done: u32 = 0;
    let mut reported: u32 = 0;
    while done < total {
        let size = ERASE_CHUNK.min(total - done);
        flasher.erase_region(done, size)?;
        done += size;
        // 一块基本要几秒，不需要节流；进度条和速度字段与烧录共用同一个事件
        let percent = (done as u64 * 100 / total as u64) as u8;
        report(app, percent.min(100), done as u64, total as u64, started);
        // 每 4MB 报一行，32MB 的模块总共 8 行，看得出还在动
        if done - reported >= 4 * ERASE_CHUNK || done == total {
            reported = done;
            log(
                app,
                format!(
                    "已擦除 {:.0}/{:.0} MB",
                    done as f64 / 1_048_576.0,
                    total as f64 / 1_048_576.0
                ),
                "info",
            );
        }
    }
    Ok(())
}

/// 检测芯片：读型号、晶振、MAC、Flash 容量与特性。
pub fn detect(app: &AppHandle, port: &str, baud: u32, chip: &str) -> Result<ChipInfo, String> {
    let _guard = BusyGuard::acquire()?;

    let Session { mut flasher, stub } = connect(app, port, baud, chip)?;
    let info = flasher
        .device_info()
        .map_err(|err| format!("读取芯片信息失败: {}", describe(&err)))?;
    let pid = flasher.connection().usb_pid();
    let chip_kind = flasher.chip();
    let _ = flasher.connection().reset_after(stub, chip_kind);
    drop(flasher);

    let version = match info.revision {
        Some((major, minor)) => format!("{}（revision v{major}.{minor}）", chip_label(info.chip)),
        None => chip_label(info.chip).to_string(),
    };
    let crystal = info.crystal_frequency.to_string();
    let mac = info.mac_address.clone().unwrap_or_else(|| "—".to_string());
    let features = if info.features.is_empty() {
        "—".to_string()
    } else {
        info.features.join(", ")
    };

    log(
        app,
        format!("检测完成：{version} / {crystal} / Flash {}", flash_size_label(info.flash_size)),
        "ok",
    );

    Ok(ChipInfo {
        chip: version,
        crystal,
        usb: if pid == USB_SERIAL_JTAG_PID {
            "USB-Serial/JTAG".to_string()
        } else {
            "UART 桥接".to_string()
        },
        mac,
        flash_size: flash_size_label(info.flash_size).to_string(),
        // espflash 不读 eFuse 里的这几项，旧版界面照样留位，显示破折号而不是留空
        flash_mode: "—".to_string(),
        flash_id: "—".to_string(),
        flash_voltage: "—".to_string(),
        features,
    })
}

/* ---------------- 内部实现 ---------------- */

#[derive(Debug)]
struct Plan {
    addr: u32,
    data: Vec<u8>,
    name: String,
}

/// 校验并读入所有勾选行。错误文案与旧版保持一致，用户看到的是同一个说法。
fn load_plan(entries: &[FlashEntry]) -> Result<Vec<Plan>, String> {
    if entries.is_empty() {
        return Err("请至少选择一个烧录任务".to_string());
    }

    let mut plan = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let row = entry.row.map(|value| value as usize).unwrap_or(index + 1);
        let addr_text = entry.addr.trim();
        let path_text = entry.path.trim();
        if addr_text.is_empty() || path_text.is_empty() {
            return Err(format!("第{row}行地址或文件路径为空"));
        }
        let addr = parse_addr(addr_text).map_err(|err| format!("第{row}行{err}"))?;

        let path = Path::new(path_text);
        if !path.is_file() {
            return Err(format!("第{row}行文件不存在: {}", path.display()));
        }
        let data = std::fs::read(path)
            .map_err(|err| format!("第{row}行读取失败: {}: {err}", path.display()))?;
        if data.is_empty() {
            return Err(format!("第{row}行文件是空的: {}", path.display()));
        }

        plan.push(Plan {
            addr,
            data,
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path_text.to_string()),
        });
    }
    Ok(plan)
}

/// 地址一律按十六进制解释：`0x10000` / `0X10000` / `10000` 等价。
pub fn parse_addr(text: &str) -> Result<u32, String> {
    let lowered = text.trim().to_ascii_lowercase();
    let digits = lowered.strip_prefix("0x").unwrap_or(lowered.as_str());
    if digits.is_empty() {
        return Err(format!("\"{text}\" 不是合法的地址"));
    }
    u32::from_str_radix(digits, 16)
        .map_err(|_| format!("\"{text}\" 不是合法的十六进制地址"))
}

/// 依次尝试的复位方式。
///
/// esptool 默认只有 `default_reset`，但原生 USB-Serial-JTAG 的板子要 `usb_reset`，
/// 而个别定制板的 DTR/RTS 根本没接对（只能手按 BOOT）——都试一遍，
/// 比把「请先按 BOOT」丢给用户去猜强。每次尝试都重新打开串口。
///
/// 原生 USB-Serial-JTAG 口（PID 0x1001）下 DTR/RTS 不起作用，espflash 的
/// `DefaultReset` 会直接退化成 `UsbJtagSerialReset`，跟 `UsbReset` 完全重复，
/// 所以这里只留一种——真机日志里这重复的一轮白等了 3 秒。
fn reset_order(usb: &serialport::UsbPortInfo) -> Vec<(ResetBeforeOperation, &'static str)> {
    if usb.pid == USB_SERIAL_JTAG_PID {
        vec![
            (ResetBeforeOperation::UsbReset, "USB-JTAG 复位"),
            (ResetBeforeOperation::NoReset, "不复位直接同步"),
        ]
    } else {
        vec![
            (ResetBeforeOperation::DefaultReset, "默认复位"),
            (ResetBeforeOperation::UsbReset, "USB-JTAG 复位"),
            (ResetBeforeOperation::NoReset, "不复位直接同步"),
        ]
    }
}

/// 擦除专用的复位顺序：去掉 `NoReset`。
///
/// 擦除只能走 stub；而第一次 stub 失联后芯片已经死在 stub 里，`NoReset`
/// 同步不上只会白等 7×5 次 Sync（真机上 8 秒），能做的只有再复位一次。
fn stub_reset_order(usb: &serialport::UsbPortInfo) -> Vec<(ResetBeforeOperation, &'static str)> {
    reset_order(usb)
        .into_iter()
        .filter(|(before, _)| *before != ResetBeforeOperation::NoReset)
        .collect()
}

/// 每个串口上次成功的模式（`true` = 带 stub）。
///
/// P4/C5 这类在 USB-Serial-JTAG 上 stub 会失联的板子，记住之后就不必每次都
/// 从已知会失败的模式试起，连接时间能从十几秒压到一两秒。只在进程内记忆，
/// 不写入配置——插上别的板子同一个 COM 号也能重新探测。
static GOOD_MODE: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());

fn mode_key(port: &str, usb: &serialport::UsbPortInfo) -> String {
    format!("{port}@{:04x}:{:04x}", usb.vid, usb.pid)
}

fn preferred_mode(key: &str) -> Option<bool> {
    GOOD_MODE
        .lock()
        .iter()
        .find(|(saved, _)| saved == key)
        .map(|(_, stub)| *stub)
}

fn remember_mode(key: &str, stub: bool) {
    let mut saved = GOOD_MODE.lock();
    match saved.iter_mut().find(|(item, _)| item == key) {
        Some(entry) => entry.1 = stub,
        None => {
            if saved.len() >= 8 {
                saved.remove(0);
            }
            saved.push((key.to_string(), stub));
        }
    }
}

/// 一次成功的连接。
///
/// `stub` 必须跟着 flasher 一起带走：收尾的 `Connection::reset_after(is_stub, chip)`
/// 要按 stub / ROM 发不同的复位命令，而 espflash 4 的 `Flasher` 不再提供
/// `use_stub()` 之类的 getter，只能自己记着。
struct Session {
    flasher: Flasher,
    stub: bool,
}

/// 打开串口并握手到可用状态；`chip` 为 `auto` 时由芯片自己上报型号。
fn connect(app: &AppHandle, port: &str, baud: u32, chip: &str) -> Result<Session, String> {
    open(app, port, baud, chip, true)
}

/// 擦除专用：0xD0 / 0xD1 是 **stub-only** 命令（见 espflash `command.rs`），
/// ROM 模式根本没有擦除能力，只能在 stub 下擦。所以这里不退回 ROM——
/// 否则会把两条注定不回答的命令各等一遍（真机上就是 31 秒 + 几分钟白等）。
fn connect_stub(app: &AppHandle, port: &str, baud: u32, chip: &str) -> Result<Session, String> {
    open(app, port, baud, chip, false)
}

fn open(
    app: &AppHandle,
    port: &str,
    baud: u32,
    chip: &str,
    allow_rom: bool,
) -> Result<Session, String> {
    let port = port.trim();
    if port.is_empty() {
        return Err("请先选择串口".to_string());
    }
    let target = parse_chip(chip)?;
    let usb = usb_port_info(port);
    log(
        app,
        format!(
            "端口 {port}: VID 0x{:04x} / PID 0x{:04x}{}",
            usb.vid,
            usb.pid,
            if usb.pid == USB_SERIAL_JTAG_PID {
                "（USB-Serial-JTAG）"
            } else {
                ""
            }
        ),
        "info",
    );

    let mut session = handshake(app, port, target, usb.clone(), SYNC_BAUD, allow_rom)?;
    if baud <= SYNC_BAUD {
        return Ok(session);
    }

    // 先按 115200 把 stub 和 Flash 参数读好，再单独切高速：
    // 切速度失败只该影响快慢，不该把整次烧录判死（部分 CH340 在 460800 上不跟手）
    match session.flasher.change_baud(baud) {
        Ok(()) => {
            log(app, format!("已切换到 {baud} 波特率"), "ok");
            Ok(session)
        }
        Err(err) => {
            log(
                app,
                format!(
                    "切换到 {baud} 失败: {}，退回 {SYNC_BAUD} 继续（会慢一些）",
                    describe(&err)
                ),
                "warn",
            );
            // 切速失败的链接不能再用（收发可能错位），重开串口重连。
            // 两种下场都要防：命令没送达（芯片还在 115200），或芯片已经切过去但主机侧没跟上
            drop(session);
            let mut last = String::new();
            for speed in [SYNC_BAUD, baud] {
                match handshake(app, port, target, usb.clone(), speed, allow_rom) {
                    Ok(session) => return Ok(session),
                    Err(reason) => last = reason,
                }
            }
            Err(last)
        }
    }
}

/// 按 [`reset_order`] 逐个试，任一成功即返回；全失败时把每次的根因都带回去。
///
/// `allow_rom` 为真时先带 stub 跑（快），只有在「确实已经进了下载模式、只是 stub 没跑起来」
/// 时才退回 ROM 模式再试一轮——espflash 的 stub 在 USB-Serial-JTAG 上偶发丢握手帧
/// （`Stub written!` 之后再无字节，见 esp-rs/espflash#1113），ROM 模式不传 stub，
/// 正好绕过这一段。擦除不能传 stub 以外的模式（0xD0/0xD1 是 stub-only），
/// 所以那边传 `false`，改成把每种复位方式都试一遍。
///
/// 两个「别白等」的剪枝：
/// - 复位/同步就没成功时，换 stub 还是 ROM 结果一样，直接结束；
/// - stub 已经写进 RAM 又失联时，烧录剩下两种复位方式全跳过（结果一样）。
/// 上次成功过的模式由 [`preferred_mode`] 提前，第二次连同一块板子只需一两秒。
///
/// 怎么区分这两个阶段：espflash 4 把连接拆成了两步，这里先自己 `begin()`
/// （只做复位 + 同步），成功后才交给 `Flasher::connect`（检测芯片、读修订号、装 stub）。
/// 4.x 的 `ConnectionError` 已经收回 crate 内部，不能再像 3.x 那样 match 错误类型，
/// 所以改用「卡在哪一步」来判断：`begin()` 报错就是同步阶段，之后的报错就是 stub 阶段。
/// 代价是 `Flasher::connect` 内部会再 `begin()` 一次（多一次复位，约 0.4 秒）。
fn handshake(
    app: &AppHandle,
    port: &str,
    target: Option<Chip>,
    usb: serialport::UsbPortInfo,
    speed: u32,
    allow_rom: bool,
) -> Result<Session, String> {
    let label = target.map(chip_label).unwrap_or("自动检测");
    let key = mode_key(port, &usb);
    let mut failures: Vec<String> = Vec::new();
    // 有没有哪次尝试越过了「复位 / 同步」这一关
    let mut past_sync = false;

    let modes: Vec<bool> = if !allow_rom {
        vec![true]
    } else if preferred_mode(&key).unwrap_or(true) {
        vec![true, false]
    } else {
        vec![false, true]
    };

    for (round, stub) in modes.into_iter().enumerate() {
        if round > 0 {
            if !past_sync {
                break;
            }
            log(
                app,
                if stub {
                    "ROM 模式没成功，再回头试 stub 模式"
                } else {
                    "stub 模式没成功，改用 ROM 模式重试（能烧，但会慢一些）"
                },
                "warn",
            );
        }

        // 擦除没有 ROM 退路，所以 stub 失联后再整轮重试一次（#1113 那种偶发丢帧重跑常能过）；
        // 重试只重复第一种复位方式——NoReset 在不复位的死 stub 上同步，只会白等几秒
        let attempts = if allow_rom { 1 } else { 2 };
        for attempt in 0..attempts {
            if attempt > 0 {
                if !past_sync {
                    break;
                }
                log(app, "stub 握手仍然没成，再重试一轮", "warn");
            }
            // 只试会真的复位的策略：上一个 stub 已经死了，NoReset 压根同步不上，
            // 白等 7×5 次 Sync（真机上就是 8 秒）
            let mut order = if allow_rom {
                reset_order(&usb)
            } else {
                stub_reset_order(&usb)
            };
            if attempt > 0 {
                order.truncate(1);
            }

            for (before, strategy) in order {
                // 上一次刚把串口关掉，Windows 释放句柄要一点时间
                if !failures.is_empty() {
                    std::thread::sleep(Duration::from_millis(150));
                }
                let mode = if stub { "stub" } else { "ROM" };
                log(
                    app,
                    format!("正在连接 {port}（{label} @ {speed}，{strategy}，{mode} 模式）…"),
                    "info",
                );

                let serial = match serialport::new(port, speed)
                    .flow_control(serialport::FlowControl::None)
                    .open_native()
                {
                    Ok(serial) => serial,
                    // 打不开是「口被占用 / 不存在」，换复位方式也救不回来
                    Err(err) => {
                        return Err(format!("打开串口 {port} 失败: {err}（检查是否被其他程序占用）"));
                    }
                };

                let mut connection = Connection::new(
                    serial,
                    usb.clone(),
                    ResetAfterOperation::HardReset,
                    before,
                    speed,
                );
                // 第一段：复位 + 同步。失败就换下一种复位方式。
                if let Err(err) = connection.begin() {
                    let reason = describe(&err);
                    log(app, format!("{strategy} 复位/同步失败: {reason}"), "warn");
                    failures.push(format!("{strategy}/{mode}: {reason}"));
                    continue;
                }

                // 第二段：检测芯片、读修订号、装 stub。能走到这里说明链路已经通了，
                // 再失败就是 stub 本身的问题（4.x 会按 P4 修订号选 stub，见 Cargo.toml 注释）。
                match Flasher::connect(connection, stub, false, false, target, None) {
                    Ok(flasher) => {
                        remember_mode(&key, stub);
                        log(app, format!("已连接（{strategy}，{mode} 模式）"), "ok");
                        return Ok(Session { flasher, stub });
                    }
                    Err(err) => {
                        let reason = describe(&err);
                        log(app, format!("{strategy}（{mode}）失败: {reason}"), "warn");
                        failures.push(format!("{strategy}/{mode}: {reason}"));
                        past_sync = true;
                        // stub 已经写进 RAM 才失联：擦除没有 ROM 退路，只能换复位方式再试一遍；
                        // 烧录还能退回 ROM，所以剩下的复位方式不必再花时间
                        if stub && allow_rom {
                            log(app, "stub 在跳转后失联，跳过其余复位方式", "warn");
                            break;
                        }
                    }
                }
            }
        }
    }

    Err(format!(
        "连接失败: {}（排查顺序：① 串口是否被其他程序占用；② 板子是否上电、端口是否选错；③ 按住 BOOT 再点一次；④ 波特率降到 115200）",
        failures.join("；")
    ))
}

/// espflash 的 `Display` 往往只有一句 "Error while connecting to device"，
/// 真正原因藏在 `source()` 链里（复位没生效、boot 模式不对、同步超时…）。
/// 把整条链拼出来，界面上才能看出到底卡在哪一步。
fn describe(err: &espflash::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        source = std::error::Error::source(cause);
    }
    parts.join(" → ")
}

fn parse_chip(name: &str) -> Result<Option<Chip>, String> {
    let raw = name.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    // espflash 的 FromStr 区分大小写（只认 "esp32p4" 这种全小写），
    // 界面或配置里写成 "ESP32P4" 也要能认
    raw.to_ascii_lowercase().parse::<Chip>().map(Some).map_err(|_| {
        format!(
            "不支持的芯片型号: {raw}（可选 auto / esp32 / esp32s2 / esp32s3 / esp32c2 / esp32c3 / esp32c5 / esp32c6 / esp32c61 / esp32h2 / esp32h4 / esp32p4 / esp32s31）"
        )
    })
}

/// 串口对应的 USB 信息（复位时序要靠 PID 判断是不是原生 USB）
fn usb_port_info(port: &str) -> serialport::UsbPortInfo {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .find(|info| info.port_name == port)
        .and_then(|info| match info.port_type {
            serialport::SerialPortType::UsbPort(usb) => Some(usb),
            _ => None,
        })
        .unwrap_or(serialport::UsbPortInfo {
            vid: 0,
            pid: 0,
            serial_number: None,
            manufacturer: None,
            product: None,
        })
}

pub fn chip_label(chip: Chip) -> &'static str {
    match chip {
        Chip::Esp32 => "ESP32",
        Chip::Esp32c2 => "ESP32-C2",
        Chip::Esp32c3 => "ESP32-C3",
        Chip::Esp32c5 => "ESP32-C5",
        Chip::Esp32c6 => "ESP32-C6",
        Chip::Esp32c61 => "ESP32-C61",
        Chip::Esp32h2 => "ESP32-H2",
        Chip::Esp32h4 => "ESP32-H4",
        Chip::Esp32p4 => "ESP32-P4",
        Chip::Esp32s2 => "ESP32-S2",
        Chip::Esp32s3 => "ESP32-S3",
        Chip::Esp32s31 => "ESP32-S31",
        // Chip 标了 non_exhaustive，espflash 以后加新型号时这里还能编译
        _ => "未知芯片",
    }
}

fn flash_size_label(size: FlashSize) -> &'static str {
    match size {
        FlashSize::_256Kb => "256 KB",
        FlashSize::_512Kb => "512 KB",
        FlashSize::_1Mb => "1 MB",
        FlashSize::_2Mb => "2 MB",
        FlashSize::_4Mb => "4 MB",
        FlashSize::_8Mb => "8 MB",
        FlashSize::_16Mb => "16 MB",
        FlashSize::_32Mb => "32 MB",
        FlashSize::_64Mb => "64 MB",
        FlashSize::_128Mb => "128 MB",
        FlashSize::_256Mb => "256 MB",
        // FlashSize 是 non_exhaustive，以后加新型号这里兜底
        _ => "未知",
    }
}

/// 容量转字节数，`None` 类未知型号按 4MB 保守处理（擦到哪算哪，不影响烧录）
fn flash_size_bytes(size: FlashSize) -> u32 {
    match size {
        FlashSize::_256Kb => 256 * 1024,
        FlashSize::_512Kb => 512 * 1024,
        FlashSize::_1Mb => 1024 * 1024,
        FlashSize::_2Mb => 2 * 1024 * 1024,
        FlashSize::_4Mb => 4 * 1024 * 1024,
        FlashSize::_8Mb => 8 * 1024 * 1024,
        FlashSize::_16Mb => 16 * 1024 * 1024,
        FlashSize::_32Mb => 32 * 1024 * 1024,
        FlashSize::_64Mb => 64 * 1024 * 1024,
        FlashSize::_128Mb => 128 * 1024 * 1024,
        FlashSize::_256Mb => 256 * 1024 * 1024,
        _ => 4 * 1024 * 1024,
    }
}

fn human_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
}

fn log(app: &AppHandle, text: impl Into<String>, level: &'static str) {
    let _ = app.emit(
        EVT_FLASH_LOG,
        FlashLog {
            text: text.into(),
            level,
        },
    );
}

fn report(app: &AppHandle, percent: u8, written: u64, total: u64, since: Instant) {
    let secs = since.elapsed().as_secs_f64();
    let bytes_per_sec = if written > 0 && secs > 0.0 {
        (written as f64 / secs) as u64
    } else {
        0
    };
    let _ = app.emit(
        EVT_FLASH_PROGRESS,
        ProgressPayload {
            percent,
            written,
            total,
            bytes_per_sec,
        },
    );
}

/// 把逐段的进度折算成整次任务的总进度。
///
/// espflash 每写一段就先 `init(addr, 分块数)`，之后每个分块 `update(i+1)`，
/// 所以段内进度是「已写分块 / 总块数」，段与段之间按字节数加权，
/// 否则先写 20 KB 的 bootloader 会瞬间冲到 50%。
struct ProgressSink<'a> {
    app: &'a AppHandle,
    sizes: HashMap<u32, u64>,
    grand: u64,
    /// 写入开始时刻，用来算平均速度
    started: Instant,
    base: u64,
    seg: u64,
    seg_chunks: usize,
    last_pct: i32,
    last_at: Instant,
}

impl ProgressCallbacks for ProgressSink<'_> {
    fn init(&mut self, addr: u32, total: usize) {
        self.seg = self.sizes.get(&addr).copied().unwrap_or(0);
        self.seg_chunks = total.max(1);
    }

    fn update(&mut self, current: usize) {
        let fraction = current.min(self.seg_chunks) as u64 * 1_000_000 / self.seg_chunks as u64;
        let done = self.base + self.seg * fraction / 1_000_000;
        let pct = if self.grand == 0 {
            0
        } else {
            ((done * 100) / self.grand).min(100) as i32
        };
        // 分块粒度很细，不节流会把 IPC 打满
        let due = pct != self.last_pct
            && (pct >= 100 || self.last_at.elapsed() >= Duration::from_millis(50));
        if due {
            self.last_pct = pct;
            self.last_at = Instant::now();
            report(self.app, pct as u8, done, self.grand, self.started);
        }
    }

    // 校验阶段不算进度：这里没开 verify，不会走到
    fn verifying(&mut self) {}

    // 一个段结束时把它的字节数计入基数。4.x 多一个 skipped 参数（跳过已写区域时
    // 不走 update，直接 finish(true)），这里没开 skip，两者都按已写完处理
    fn finish(&mut self, _skipped: bool) {
        self.base += self.seg;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_is_always_hex() {
        assert_eq!(parse_addr("0x10000").unwrap(), 0x10000);
        assert_eq!(parse_addr("0X8000").unwrap(), 0x8000);
        // 没有前缀也按十六进制，和旧版 `_format_addr` 一致
        assert_eq!(parse_addr("10000").unwrap(), 0x1_0000);
        assert_eq!(parse_addr(" 0x0 ").unwrap(), 0);
    }

    #[test]
    fn address_rejects_garbage() {
        assert!(parse_addr("").is_err());
        assert!(parse_addr("   ").is_err());
        assert!(parse_addr("0x").is_err());
        assert!(parse_addr("zz").is_err());
        assert!(parse_addr("0x1_0000").is_err());
    }

    #[test]
    fn empty_plan_is_rejected() {
        assert_eq!(load_plan(&[]).unwrap_err(), "请至少选择一个烧录任务");
    }

    #[test]
    fn blank_cell_is_reported_with_row_number() {
        let entries = vec![FlashEntry {
            row: None,
            addr: "0x0".to_string(),
            path: "  ".to_string(),
        }];
        assert_eq!(load_plan(&entries).unwrap_err(), "第1行地址或文件路径为空");
    }

    #[test]
    fn error_points_at_the_table_row_not_the_check_order() {
        // 只勾了第 3 行时，报错必须说「第3行」，和旧版按行号提示一致
        let entries = vec![FlashEntry {
            row: Some(3),
            addr: "0x0".to_string(),
            path: String::new(),
        }];
        assert_eq!(load_plan(&entries).unwrap_err(), "第3行地址或文件路径为空");
    }

    #[test]
    fn describe_exposes_the_root_cause() {
        // 界面原来只能看到「Error while connecting to device」，根因必须能从 source 链里挖出来。
        // 4.x 起 ConnectionError 不再对外公开，只能从入口（串口错误）造一个等价错误来验
        let err = espflash::Error::from(serialport::Error::new(
            serialport::ErrorKind::NoDevice,
            "no such port",
        ));
        let text = describe(&err);
        assert!(text.contains("Error while connecting to device"), "{text}");
        // 串口层给的那句原因必须被拼进同一条链里，否则界面只剩一句空话
        assert!(text.contains("no such port"), "{text}");
        assert!(text != err.to_string(), "{text}");
    }

    #[test]
    fn auto_and_blank_chip_mean_detect() {
        assert!(parse_chip("auto").unwrap().is_none());
        assert!(parse_chip(" AUTO ").unwrap().is_none());
        assert!(parse_chip("").unwrap().is_none());
        assert_eq!(parse_chip("esp32c6").unwrap(), Some(Chip::Esp32c6));
        // espflash 4.x 认的型号明显变多（C5/C61/H4/S31 都是新加的）
        assert_eq!(parse_chip("esp32c61").unwrap(), Some(Chip::Esp32c61));
        // 大小写不该影响结果（espflash 自己的 FromStr 只认全小写）
        assert_eq!(parse_chip("ESP32P4").unwrap(), Some(Chip::Esp32p4));
        // 真不认识的型号仍然要在界面上拦住，而不是连上去再失败
        assert!(parse_chip("esp32xx").is_err());
    }

    #[test]
    fn flash_size_is_converted_to_bytes_for_chunked_erase() {
        // 32MB 的模块要分 32 块擦，块数算错就会漏擦或越界
        assert_eq!(flash_size_bytes(FlashSize::_32Mb), 32 * 1024 * 1024);
        assert_eq!(flash_size_bytes(FlashSize::_4Mb), 4 * 1024 * 1024);
        assert_eq!(
            flash_size_bytes(FlashSize::_32Mb).div_ceil(ERASE_CHUNK),
            32
        );
    }

    fn usb_port(pid: u16) -> serialport::UsbPortInfo {
        serialport::UsbPortInfo {
            vid: 0x303a,
            pid,
            serial_number: None,
            manufacturer: None,
            product: None,
        }
    }

    #[test]
    fn reset_order_skips_the_duplicate_usb_jtag_strategy() {
        // PID 0x1001 时 DefaultReset 和 UsbReset 是同一套时序，重复试白等 3 秒
        let order = reset_order(&usb_port(USB_SERIAL_JTAG_PID));
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].0, ResetBeforeOperation::UsbReset);

        // 普通 UART 桥口还是要按 DTR/RTS → USB → 不复位 的顺序试
        let order = reset_order(&usb_port(0x7523));
        assert_eq!(order.len(), 3);
        assert_eq!(order[0].0, ResetBeforeOperation::DefaultReset);
    }

    #[test]
    fn erase_only_resets_instead_of_trying_no_reset() {
        // 擦除只能走 stub：NoReset 在已经死在 stub 里的芯片上同步不上，白等几秒
        let order = stub_reset_order(&usb_port(USB_SERIAL_JTAG_PID));
        assert_eq!(order.len(), 1);
        assert_eq!(order[0].0, ResetBeforeOperation::UsbReset);

        let order = stub_reset_order(&usb_port(0x7523));
        assert_eq!(order.len(), 2);
        assert!(order.iter().all(|(before, _)| *before != ResetBeforeOperation::NoReset));
    }

    #[test]
    fn remembered_mode_is_sticky_per_port() {
        let key = mode_key("COM_TEST", &usb_port(USB_SERIAL_JTAG_PID));
        assert_eq!(preferred_mode(&key), None);
        remember_mode(&key, false);
        assert_eq!(preferred_mode(&key), Some(false));
        remember_mode(&key, true);
        assert_eq!(preferred_mode(&key), Some(true));
        // 换个端口互不干扰
        assert_eq!(preferred_mode("COM_OTHER@303a:1001"), None);
    }
}
