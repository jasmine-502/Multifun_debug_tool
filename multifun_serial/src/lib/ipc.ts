/**
 * IPC 封装：Tauri 命令 + 事件。
 * 事件名与 `src-tauri/src/serial_reader.rs`、`ports.rs` 中的 emit 名称保持一致。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AutosaveStatus,
  ConnStatus,
  FwMergeEntryInput,
  FwMergeResult,
  FwScan,
  LogBatch,
  PortInfo,
  SplitMode,
  Stats,
} from "./types";

export const EVT_LOG_BATCH = "esp://log-batch";
export const EVT_STATS = "esp://stats";
export const EVT_STATUS = "esp://status";
export const EVT_PORTS = "esp://ports";
export const EVT_AUTOSAVE = "esp://autosave";

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
};
