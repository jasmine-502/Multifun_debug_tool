/** 前后端契约：与 `src-tauri/src/*.rs` 中的 serde 结构一一对应 */

export type LogLevel = "Error" | "Warning" | "Info" | "Debug" | "Verbose" | "None";

export const LOG_LEVELS: LogLevel[] = ["Error", "Warning", "Info", "Debug", "Verbose"];

export interface LogLine {
  seq: number;
  /** 切包时刻（Unix 毫秒），由 Rust 打，避免批量 IPC 把一整批压成同一时间 */
  ts: number;
  level: LogLevel;
  tag: string | null;
  raw: string;
  /**
   * 原始字节的十六进制串（空格分隔，含行尾）。
   * 不能从 raw 反推：UTF-8 lossy 已丢掉非法字节，`\r\n` 也在切行时被去掉了。
   */
  hex: string;
}

export interface LogBatch {
  seq: number;
  lines: LogLine[];
  dropped: number;
}

export interface Stats {
  bytes: number;
  bytesPerSec: number;
  lines: number;
}

export interface PortInfo {
  port: string;
  description: string;
  /** USB VID，非 USB 串口时缺省 */
  vid?: number;
  pid?: number;
  /** Espressif 原生 USB-Serial-JTAG：动控制线会被当成 download 请求 */
  jtag?: boolean;
}

export type ConnState = "closed" | "open" | "error";

export interface ConnStatus {
  state: ConnState;
  port: string | null;
  message: string | null;
}

export interface AutosaveStatus {
  enabled: boolean;
  path: string | null;
}

export type LevelFilter = Record<LogLevel, boolean>;

/** 数据源：ESP-IDF 日志带级别/日志名前缀，通用串口只有裸数据 */
export type DataMode = "esp" | "generic";

/** 切包策略：通用串口的“行尾”不一定是 \n，二进制流甚至没有分隔符 */
export type SplitMode = "crlf" | "idle" | "fixed";

export const DEFAULT_LEVEL_FILTER: LevelFilter = {
  Error: true,
  Warning: true,
  Info: true,
  Debug: true,
  Verbose: true,
  None: true,
};

export const BAUD_RATES = [
  "4800",
  "9600",
  "19200",
  "38400",
  "57600",
  "115200",
  "230400",
  "460800",
  "921600",
  "1000000",
  "1500000",
];

/* ---------- 固件合并 ---------- */

/** 扫描出来的一个 bin；offset 为空串表示需要用户手填 */
export interface FwEntry {
  offset: string;
  path: string;
  name: string;
  size: number;
  /** flasher=来自 flasher_args.json；fallback=按文件名猜的；extra=build 里多出来的 */
  source: "flasher" | "fallback" | "extra";
}

export type FwLogLevel = "info" | "warn" | "error" | "ok";

export interface FwScanLog {
  text: string;
  level: FwLogLevel;
}

export interface FwScan {
  buildDir: string;
  chip: string;
  flashSize: string;
  flashFreq: string;
  version: string | null;
  projectName: string | null;
  entries: FwEntry[];
  logs: FwScanLog[];
}

/** 下发给 Rust 的合并项：偏移传原文，十进制 / 十六进制由 Rust 统一解析 */
export interface FwMergeEntryInput {
  offset: string;
  path: string;
}

export interface FwMergeResult {
  output: string;
  size: number;
  count: number;
  /** 条目交叠提示，后者覆盖前者 */
  overlaps: string[];
}

/* ---------- ESP32 烧录 ---------- */

/**
 * 芯片下拉项。espflash 4.x 支持的型号；
 * 4.x 起 C5 / C61 / H4 / S31 也能认，所以旧版故意剔掉的 C61 重新放回来。
 */
export const FLASH_CHIPS = [
  { value: "auto", label: "自动检测" },
  { value: "esp32", label: "ESP32" },
  { value: "esp32s2", label: "ESP32-S2" },
  { value: "esp32s3", label: "ESP32-S3" },
  { value: "esp32c2", label: "ESP32-C2" },
  { value: "esp32c3", label: "ESP32-C3" },
  { value: "esp32c5", label: "ESP32-C5" },
  { value: "esp32c6", label: "ESP32-C6" },
  { value: "esp32c61", label: "ESP32-C61" },
  { value: "esp32h2", label: "ESP32-H2" },
  { value: "esp32h4", label: "ESP32-H4" },
  { value: "esp32p4", label: "ESP32-P4" },
  { value: "esp32s31", label: "ESP32-S31" },
] as const;

/** 烧录页的波特率档位：首档是握手速率，其余是写入速率 */
export const FLASH_BAUD_RATES = [115200, 230400, 460800, 921600];

/** 一次烧录/擦除/检测的连接参数 */
export interface FlashTarget {
  port: string;
  baud: number;
  /** `auto` 交给芯片自己上报，其余按 espflash 的型号名传 */
  chip: string;
}

/** 表格里的一行：地址传原文，十六进制解析在 Rust 侧统一做 */
export interface FlashEntryInput {
  /** 界面行号（从 1 起）：报错要说「第N行」，而勾选顺序和行号不一致 */
  row: number;
  addr: string;
  path: string;
}

export interface FlashReport {
  chip: string;
  bytes: number;
  files: number;
  elapsedMs: number;
}

/** 检测结果：espflash 取不到的字段由后端填「—」，前端只管展示 */
export interface ChipInfo {
  chip: string;
  crystal: string;
  usb: string;
  mac: string;
  flashSize: string;
  flashMode: string;
  flashId: string;
  flashVoltage: string;
  features: string;
}

export type FlashLogLevel = "info" | "ok" | "warn" | "error";

export interface FlashLogLine {
  text: string;
  level: FlashLogLevel;
}

export interface FlashProgressPayload {
  percent: number;
  /** 已写入字节数（整次任务累计，不是当前文件） */
  written: number;
  /** 本次任务要写的总字节数 */
  total: number;
  /** 从开始写入到现在的平均速度，字节/秒 */
  bytesPerSec: number;
}
