/**
 * 后端适配层。
 * 在 Tauri 运行时走真实 IPC；在纯浏览器（`npm run dev:web`）下提供一份带假数据的模拟实现，
 * 这样只改样式时不需要编译 Rust，也能完整验收交互。
 */

import { save } from "@tauri-apps/plugin-dialog";
import { tauri, type Unlisten } from "./ipc";
import type {
  AutosaveStatus,
  ConnStatus,
  LogBatch,
  LogLevel,
  LogLine,
  PortInfo,
  SplitMode,
  Stats,
} from "./types";

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface OpenLogOptions {
  port: string;
  baud: number;
  label: string;
  /** 打开后脉冲 EN 复位设备 */
  reset: boolean;
  /** 打开即开始自动保存（必须随打开一起下发，否则开头几十行会丢）*/
  autosave: boolean;
  /** 通用串口模式：不解析 ESP-IDF 前缀，改用关键字过滤 */
  generic: boolean;
  split: SplitMode;
  fixedSize: number;
  idleMs: number;
}

export interface Backend {
  readonly mock: boolean;
  listPorts(): Promise<PortInfo[]>;
  openLog(options: OpenLogOptions): Promise<void>;
  closeLog(): Promise<void>;
  setFilters(levels: Record<string, boolean>, tags: string, generic: boolean): Promise<void>;
  setAutosave(enabled: boolean, dir: string | null): Promise<void>;
  /** 落盘格式（HEX / 时间戳）跟随界面显示 */
  setAutosaveFormat(hex: boolean, timestamp: boolean): Promise<void>;
  saveSnapshot(content: string): Promise<string | null>;
  /** 把缓存行的十六进制还原成原始字节写 .bin（唯一无损的导出方式）*/
  saveRaw(hexLines: string): Promise<string | null>;
  openLogDir(): Promise<void>;
  defaultLogDir(): Promise<string>;
  /** 页面卸载/窗口关闭时收尾，保证不会有残留的读线程或定时器 */
  shutdown(): Promise<void>;
  onLogBatch(cb: (b: LogBatch) => void): Promise<Unlisten>;
  onStats(cb: (s: Stats) => void): Promise<Unlisten>;
  onStatus(cb: (s: ConnStatus) => void): Promise<Unlisten>;
  onPorts(cb: (p: PortInfo[]) => void): Promise<Unlisten>;
  onAutosave(cb: (s: AutosaveStatus) => void): Promise<Unlisten>;
}

/* ---------------- 真实实现 ---------------- */

const realBackend: Backend = {
  mock: false,
  listPorts: () => tauri.listPorts(),
  openLog: (options) => tauri.openLog(options),
  closeLog: () => tauri.closeLog(),
  setFilters: (levels, tags, generic) => tauri.setFilters(levels, tags, generic),
  setAutosave: (enabled, dir) => tauri.setAutosave(enabled, dir),
  setAutosaveFormat: (hex, timestamp) => tauri.setAutosaveFormat(hex, timestamp),
  async saveSnapshot(content) {
    const path = await save({
      title: "保存日志",
      defaultPath: "ESP32_Log.txt",
      filters: [{ name: "文本文件", extensions: ["txt", "log"] }],
    });
    if (!path) return null;
    await tauri.saveSnapshot(path, content);
    return path;
  },
  async saveRaw(hexLines) {
    const path = await save({
      title: "保存原始数据",
      defaultPath: "serial_capture.bin",
      filters: [{ name: "二进制文件", extensions: ["bin"] }],
    });
    if (!path) return null;
    await tauri.saveRawSnapshot(path, hexLines);
    return path;
  },
  openLogDir: () => tauri.openLogDir(),
  defaultLogDir: () => tauri.defaultLogDir(),
  async shutdown() {
    try {
      await tauri.closeLog();
    } catch {
      /* 串口可能已经拔掉，收尾失败无关紧要 */
    }
  },
  onLogBatch: (cb) => tauri.onLogBatch(cb),
  onStats: (cb) => tauri.onStats(cb),
  onStatus: (cb) => tauri.onStatus(cb),
  onPorts: (cb) => tauri.onPorts(cb),
  onAutosave: (cb) => tauri.onAutosave(cb),
};

/* ---------------- 浏览器模拟实现 ---------------- */

const MOCK_TAGS = [
  "EmojiConfig",
  "Backlight",
  "wifi",
  "app_main",
  "esp_netif",
  "audio",
  "gpio",
];

const MOCK_MESSAGES = [
  "state -> RUN",
  "set brightness=%d",
  "STA connected, ip=192.168.1.%d",
  "heap free: %d bytes",
  "task watchdog feed",
  "jpeg decode done in %d ms",
  "i2s write %d frames",
];

/** 通用串口模式的假数据：没有级别前缀，靠 \r\n 分行 */
const MOCK_GENERIC_LINES = [
  "AT+CSQ",
  "+CSQ: 24,99",
  "temp=23.5 humi=48.2",
  "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47",
  "STATE:IDLE,RSSI:-62",
];

/** 原始字节 → 十六进制串，与 Rust 侧 hex_of 的输出格式保持一致 */
const mockHex = (text: string): string =>
  Array.from(new TextEncoder().encode(text), (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase(),
  ).join(" ");

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const pad = (n: number, w = 3) => String(n).padStart(w, "0");

const nowStamp = () => {
  const d = new Date();
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(
    d.getMilliseconds(),
  )}`;
};

const LEVEL_LETTER: Record<string, string> = {
  Error: "E",
  Warning: "W",
  Info: "I",
  Debug: "D",
  Verbose: "V",
  None: "?",
};

let mockSeq = 0;
/** 通用串口模式开关：模拟器跟着 UI 切数据类型，否则验证时看不出来 */
let mockGenericMode = false;

const mockLine = (): LogLine => {
  mockSeq += 1;
  if (mockGenericMode) {
    const raw = pick(MOCK_GENERIC_LINES);
    // 普通设备通常以 \r\n 结尾，hex 里也要带上，否则看不出无损
    return { seq: mockSeq, ts: Date.now(), level: "None", tag: null, raw, hex: mockHex(`${raw}\r\n`) };
  }
  const roll = Math.random();
  const level: LogLevel =
    roll > 0.97 ? "Error" : roll > 0.9 ? "Warning" : roll > 0.75 ? "Debug" : "Info";
  const tag = pick(MOCK_TAGS);
  const msg = pick(MOCK_MESSAGES).replace("%d", String(Math.floor(Math.random() * 4000)));
  const raw = `[${nowStamp()}] ${LEVEL_LETTER[level]} (${1000 + Math.floor(Math.random() * 9000)}) ${tag}: ${msg}`;
  return { seq: mockSeq, ts: Date.now(), level, tag, raw, hex: mockHex(`${raw}\r\n`) };
};

interface MockState {
  levels: Record<string, boolean>;
  tags: string;
  generic: boolean;
}

const mockState: MockState = {
  levels: { Error: true, Warning: true, Info: true, Debug: true, Verbose: true, None: true },
  tags: "",
  generic: false,
};

const mockListeners = {
  batch: new Set<(b: LogBatch) => void>(),
  stats: new Set<(s: Stats) => void>(),
  status: new Set<(s: ConnStatus) => void>(),
  ports: new Set<(p: PortInfo[]) => void>(),
  autosave: new Set<(s: AutosaveStatus) => void>(),
};

const MOCK_PORTS: PortInfo[] = [
  { port: "COM7", description: "CP2102 USB to UART Bridge Controller" },
  { port: "COM3", description: "USB-SERIAL CH340" },
];

const subscribe = <T>(set: Set<(v: T) => void>, cb: (v: T) => void): Promise<Unlisten> => {
  set.add(cb);
  return Promise.resolve(() => {
    set.delete(cb);
  });
};

let mockTimer: number | null = null;
let mockStatsTimer: number | null = null;
let mockAutosave = false;
/** 自动保存的落盘格式：真机上由后端拼文件名，模拟模式只影响提示里的路径 */
let mockAutosaveHex = false;
let mockBytes = 0;
let mockLines = 0;

const stopMockStream = () => {
  if (mockTimer !== null) {
    window.clearInterval(mockTimer);
    mockTimer = null;
  }
  if (mockStatsTimer !== null) {
    window.clearInterval(mockStatsTimer);
    mockStatsTimer = null;
  }
};

const startMockStream = () => {
  stopMockStream();
  mockTimer = window.setInterval(() => {
    const lines: LogLine[] = [];
    for (let i = 0; i < 2; i += 1) {
      const line = mockLine();
      const levelOn = mockState.levels[line.level] !== false;
      // 通用模式按“行内包含关键字”判，和 Rust 侧 Filters::keyword_allowed 一致
      const scopeOk = mockState.generic
        ? mockState.tags.trim() === "" ||
          mockState.tags
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
            .some((key) => line.raw.toLowerCase().includes(key))
        : mockState.tags.trim() === "" ||
          (line.tag !== null &&
            mockState.tags
              .split(",")
              .map((s) => s.trim())
              .includes(line.tag));
      if (!levelOn || !scopeOk) continue;
      lines.push(line);
      mockBytes += line.raw.length + 2;
      mockLines += 1;
    }
    if (lines.length === 0) return;
    const batch: LogBatch = { seq: mockSeq, lines, dropped: 0 };
    mockListeners.batch.forEach((cb) => cb(batch));
  }, 60);

  let lastBytes = mockBytes;
  mockStatsTimer = window.setInterval(() => {
    const stats: Stats = {
      bytes: mockBytes,
      bytesPerSec: mockBytes - lastBytes,
      lines: mockLines,
    };
    lastBytes = mockBytes;
    mockListeners.stats.forEach((cb) => cb(stats));
  }, 1000);
};

const mockBackend: Backend = {
  mock: true,
  listPorts: async () => MOCK_PORTS,
  async openLog({ port, baud, label, autosave, generic }) {
    mockGenericMode = generic;
    mockListeners.status.forEach((cb) =>
      cb({ state: "open", port, message: null }),
    );
    mockAutosave = autosave;
    mockListeners.autosave.forEach((cb) =>
      cb({
        enabled: autosave,
        path: autosave
          ? `模拟目录/ESP32_Log_${Date.now()}${mockAutosaveHex ? "_hex" : ""}.txt (${label}/${baud})`
          : null,
      }),
    );
    startMockStream();
  },
  async closeLog() {
    stopMockStream();
    mockAutosave = false;
    mockListeners.autosave.forEach((cb) => cb({ enabled: false, path: null }));
    mockListeners.status.forEach((cb) => cb({ state: "closed", port: null, message: null }));
  },
  async setFilters(levels, tags, generic) {
    mockState.levels = levels;
    mockState.tags = tags;
    mockState.generic = generic;
  },
  async setAutosave(enabled) {
    mockAutosave = enabled;
    mockListeners.autosave.forEach((cb) =>
      cb({
        enabled: mockAutosave,
        path: enabled ? `模拟目录/ESP32_Log_模拟${mockAutosaveHex ? "_hex" : ""}.txt` : null,
      }),
    );
  },
  async setAutosaveFormat(hex) {
    mockAutosaveHex = hex;
  },
  async saveSnapshot() {
    return "模拟目录/ESP32_Log_导出.txt";
  },
  async saveRaw() {
    return "模拟目录/serial_capture.bin";
  },
  async openLogDir() {
    /* 浏览器环境无可打开的目录 */
  },
  async defaultLogDir() {
    return "模拟目录/logs";
  },
  async shutdown() {
    stopMockStream();
    mockAutosave = false;
    mockListeners.status.forEach((cb) => cb({ state: "closed", port: null, message: null }));
  },
  onLogBatch: (cb) => subscribe(mockListeners.batch, cb),
  onStats: (cb) => subscribe(mockListeners.stats, cb),
  onStatus: (cb) => subscribe(mockListeners.status, cb),
  onPorts: (cb) => subscribe(mockListeners.ports, cb),
  onAutosave: (cb) => subscribe(mockListeners.autosave, cb),
};

export const backend: Backend = isTauriRuntime() ? realBackend : mockBackend;
