/**
 * IPC 封装：Tauri 命令 + 事件。
 * 事件名与 `src-tauri/src/serial_reader.rs`、`ports.rs` 中的 emit 名称保持一致。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AutosaveStatus,
  ChipInfo,
  ConnStatus,
  FlashEntryInput,
  FlashLogLine,
  FlashProgressPayload,
  FlashReport,
  FwMergeEntryInput,
  FwMergeResult,
  FwScan,
  LogBatch,
  PortInfo,
  SplitMode,
  Stats,
  TcpChunk,
  TcpPeerEvent,
  TcpSent,
  TcpStatus,
  UdpChunk,
  UdpSent,
  UdpStatus,
} from "./types";

export const EVT_LOG_BATCH = "esp://log-batch";
export const EVT_STATS = "esp://stats";
export const EVT_STATUS = "esp://status";
export const EVT_PORTS = "esp://ports";
export const EVT_AUTOSAVE = "esp://autosave";
export const EVT_FLASH_LOG = "esp://flash/log";
export const EVT_FLASH_PROGRESS = "esp://flash/progress";
export const EVT_TCP_DATA = "tcp://data";
export const EVT_TCP_STATUS = "tcp://status";
export const EVT_TCP_PEER = "tcp://peer";
export const EVT_UDP_DATA = "udp://data";
export const EVT_UDP_STATUS = "udp://status";

export type Unlisten = UnlistenFn;

export const tauri = {
  listPorts: () => invoke<PortInfo[]>("list_ports"),

  openLog: (options: {
    port: string;
    baud: number;
    label: string;
    reset: boolean;
    autosave: boolean;
    /** 通用串口模式：不解析 ESP-IDF 前缀 */
    generic: boolean;
    split: SplitMode;
    /** `split === "fixed"` 时的每包字节数 */
    fixedSize: number;
    /** 静默切包阈值（毫秒） */
    idleMs: number;
  }) => invoke<void>("open_log", options),

  closeLog: () => invoke<void>("close_log"),

  setFilters: (levels: Record<string, boolean>, tags: string, generic: boolean) =>
    invoke<void>("set_filters", { levels, tags, generic }),

  setAutosave: (enabled: boolean, dir: string | null) =>
    invoke<void>("set_autosave", { enabled, dir }),

  /** 落盘格式跟随界面显示：HEX 视图与时间戳开关都要同步给后端 */
  setAutosaveFormat: (hex: boolean, timestamp: boolean) =>
    invoke<void>("set_autosave_format", { hex, timestamp }),

  saveSnapshot: (path: string, content: string) =>
    invoke<void>("save_snapshot", { path, content }),

  saveRawSnapshot: (path: string, hexLines: string) =>
    invoke<void>("save_raw_snapshot", { path, hexLines }),

  openLogDir: () => invoke<void>("open_log_dir"),

  defaultLogDir: () => invoke<string>("default_log_dir"),

  onLogBatch: (cb: (b: LogBatch) => void) =>
    listen<LogBatch>(EVT_LOG_BATCH, (e) => cb(e.payload)),

  onStats: (cb: (s: Stats) => void) => listen<Stats>(EVT_STATS, (e) => cb(e.payload)),

  onStatus: (cb: (s: ConnStatus) => void) =>
    listen<ConnStatus>(EVT_STATUS, (e) => cb(e.payload)),

  onPorts: (cb: (p: PortInfo[]) => void) =>
    listen<PortInfo[]>(EVT_PORTS, (e) => cb(e.payload)),

  onAutosave: (cb: (s: AutosaveStatus) => void) =>
    listen<AutosaveStatus>(EVT_AUTOSAVE, (e) => cb(e.payload)),

  /* ---------- 固件合并 ---------- */

  scanFirmware: (root: string) => invoke<FwScan>("scan_firmware", { root }),

  /** 偏移已在 TS 侧解析成数字；outputDir 为空时由 Rust 落到 root */
  mergeFirmware: (
    entries: FwMergeEntryInput[],
    root: string,
    outputDir: string,
    filename: string,
  ) => invoke<FwMergeResult>("merge_firmware", { entries, root, outputDir, filename }),

  /* ---------- ESP32 烧录 ---------- */

  /** 一次性连接设备写入选中的 bin；过程日志与进度走事件 */
  espFlash: (port: string, baud: number, chip: string, entries: FlashEntryInput[]) =>
    invoke<FlashReport>("esp_flash", { port, baud, chip, entries }),

  espErase: (port: string, baud: number, chip: string) =>
    invoke<FlashReport>("esp_erase", { port, baud, chip }),

  espDetect: (port: string, baud: number, chip: string) =>
    invoke<ChipInfo>("esp_detect", { port, baud, chip }),

  onFlashLog: (cb: (line: FlashLogLine) => void) =>
    listen<FlashLogLine>(EVT_FLASH_LOG, (e) => cb(e.payload)),

  onFlashProgress: (cb: (p: FlashProgressPayload) => void) =>
    listen<FlashProgressPayload>(EVT_FLASH_PROGRESS, (e) => cb(e.payload)),

  /* ---------- TCP 客户端 / 服务端 ---------- */

  /** 连上后返回 `地址:端口`，连接超时 2 秒 */
  tcpConnect: (host: string, port: number) =>
    invoke<string>("tcp_connect", { host, port }),

  /** 开始监听，返回实际监听地址（`0.0.0.0:8000`） */
  tcpListen: (host: string, port: number, maxClients: number) =>
    invoke<string>("tcp_listen", { host, port, maxClients }),

  tcpDisconnect: () => invoke<void>("tcp_disconnect"),

  /** hex 为 true 时 `data` 按十六进制文本解析；返回实际发出的字节 */
  tcpSend: (data: string, hex: boolean) => invoke<TcpSent>("tcp_send", { data, hex }),

  onTcpData: (cb: (chunk: TcpChunk) => void) =>
    listen<TcpChunk>(EVT_TCP_DATA, (e) => cb(e.payload)),

  onTcpStatus: (cb: (status: TcpStatus) => void) =>
    listen<TcpStatus>(EVT_TCP_STATUS, (e) => cb(e.payload)),

  /** 服务端在线客户端变化：连接 / 断开 / 被拒绝 */
  onTcpPeer: (cb: (event: TcpPeerEvent) => void) =>
    listen<TcpPeerEvent>(EVT_TCP_PEER, (e) => cb(e.payload)),

  /* ---------- UDP 通信 ---------- */

  /** 绑定本地端口，返回实际绑上的 `地址:端口`（本地端口 0 时由系统分配） */
  udpStart: (
    localHost: string,
    localPort: number,
    broadcast: boolean,
    multicast: boolean,
    group: string,
  ) =>
    invoke<string>("udp_start", { localHost, localPort, broadcast, multicast, group }),

  udpStop: () => invoke<void>("udp_stop"),

  /** `host` 为空表示服务端模式：回给最近一次收到报文的来源 */
  udpSend: (data: string, hex: boolean, host: string, port: number) =>
    invoke<UdpSent>("udp_send", { data, hex, host, port }),

  onUdpData: (cb: (chunk: UdpChunk) => void) =>
    listen<UdpChunk>(EVT_UDP_DATA, (e) => cb(e.payload)),

  onUdpStatus: (cb: (status: UdpStatus) => void) =>
    listen<UdpStatus>(EVT_UDP_STATUS, (e) => cb(e.payload)),
};
