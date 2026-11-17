/**
 * 后端适配层。
 * 在 Tauri 运行时走真实 IPC；在纯浏览器（`npm run dev:web`）下提供一份带假数据的模拟实现，
 * 这样只改样式时不需要编译 Rust，也能完整验收交互。
 */

import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { tauri, type Unlisten } from "./ipc";
import type {
  AutosaveStatus,
  ChipInfo,
  ConnStatus,
  FlashEntryInput,
  FlashLogLevel,
  FlashLogLine,
  FlashProgressPayload,
  FlashReport,
  FwMergeEntryInput,
  FwMergeResult,
  FwScan,
  LogBatch,
  LogLevel,
  LogLine,
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

  /* ---------- 固件合并 ---------- */

  /** 扫描 build 目录：优先读 flasher_args.json，回退到常见文件名 */
  scanFirmware(root: string): Promise<FwScan>;
  /** 按偏移拼接写盘；outputDir 为空时落到 root 目录 */
  mergeFirmware(
    entries: FwMergeEntryInput[],
    root: string,
    outputDir: string,
    filename: string,
  ): Promise<FwMergeResult>;
  /** 选目录（项目根 / 输出目录），取消返回 null */
  chooseDirectory(title: string): Promise<string | null>;
  /** 选单个 bin 文件，取消返回 null */
  chooseBinFile(): Promise<string | null>;

  /* ---------- ESP32 烧录 ---------- */

  /** 一次性连接设备写入选中的 bin；日志与进度通过事件推送 */
  espFlash(
    port: string,
    baud: number,
    chip: string,
    entries: FlashEntryInput[],
  ): Promise<FlashReport>;
  /** 擦除整片 Flash；调用前必须已经征得用户同意 */
  espErase(port: string, baud: number, chip: string): Promise<FlashReport>;
  espDetect(port: string, baud: number, chip: string): Promise<ChipInfo>;
  onFlashLog(cb: (line: FlashLogLine) => void): Promise<Unlisten>;
  onFlashProgress(cb: (p: FlashProgressPayload) => void): Promise<Unlisten>;
  /** 擦除前的二次确认（真机走系统对话框）*/
  confirmErase(): Promise<boolean>;

  /* ---------- TCP 客户端 / 服务端 ---------- */

  /** 连接服务器，返回 `地址:端口`；连接超时 2 秒 */
  tcpConnect(host: string, port: number): Promise<string>;
  /** 开始监听，返回实际监听地址；`0.0.0.0` 表示所有网卡 */
  tcpListen(host: string, port: number, maxClients: number): Promise<string>;
  tcpDisconnect(): Promise<void>;
  /** hex 为 true 时 data 按十六进制文本解析；返回实际发出的字节与目标数 */
  tcpSend(data: string, hex: boolean): Promise<TcpSent>;
  onTcpData(cb: (chunk: TcpChunk) => void): Promise<Unlisten>;
  onTcpStatus(cb: (status: TcpStatus) => void): Promise<Unlisten>;
  /** 服务端在线客户端变化：连接 / 断开 / 被拒绝 */
  onTcpPeer(cb: (event: TcpPeerEvent) => void): Promise<Unlisten>;

  /* ---------- UDP 通信 ---------- */

  /** 绑定本地端口，返回实际绑上的 `地址:端口`；本地端口 0 表示由系统分配 */
  udpStart(
    localHost: string,
    localPort: number,
    broadcast: boolean,
    multicast: boolean,
    group: string,
  ): Promise<string>;
  udpStop(): Promise<void>;
  /** hex 为 true 时 data 按十六进制文本解析；`host` 为空表示回给最近来源 */
  udpSend(data: string, hex: boolean, host: string, port: number): Promise<UdpSent>;
  onUdpData(cb: (chunk: UdpChunk) => void): Promise<Unlisten>;
  onUdpStatus(cb: (status: UdpStatus) => void): Promise<Unlisten>;
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
    try {
      await tauri.tcpDisconnect();
    } catch {
      /* 同上：TCP 可能已经断了 */
    }
    try {
      await tauri.udpStop();
    } catch {
      /* UDP 没启动时停止是空操作，不必报错 */
    }
  },
  onLogBatch: (cb) => tauri.onLogBatch(cb),
  onStats: (cb) => tauri.onStats(cb),
  onStatus: (cb) => tauri.onStatus(cb),
  onPorts: (cb) => tauri.onPorts(cb),
  onAutosave: (cb) => tauri.onAutosave(cb),
  scanFirmware: (root) => tauri.scanFirmware(root),
  mergeFirmware: (entries, root, outputDir, filename) =>
    tauri.mergeFirmware(entries, root, outputDir, filename),
  async chooseDirectory(title) {
    const picked = await open({ title, directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  async chooseBinFile() {
    const picked = await open({
      title: "选择 Bin 文件",
      multiple: false,
      filters: [{ name: "Bin 文件", extensions: ["bin"] }],
    });
    return typeof picked === "string" ? picked : null;
  },
  espFlash: (port, baud, chip, entries) => tauri.espFlash(port, baud, chip, entries),
  espErase: (port, baud, chip) => tauri.espErase(port, baud, chip),
  espDetect: (port, baud, chip) => tauri.espDetect(port, baud, chip),
  onFlashLog: (cb) => tauri.onFlashLog(cb),
  onFlashProgress: (cb) => tauri.onFlashProgress(cb),
  async confirmErase() {
    return confirm("确定要擦除Flash吗？此操作将清除所有数据！", {
      title: "确认擦除",
      kind: "warning",
    });
  },
  tcpConnect: (host, port) => tauri.tcpConnect(host, port),
  tcpListen: (host, port, maxClients) => tauri.tcpListen(host, port, maxClients),
  tcpDisconnect: () => tauri.tcpDisconnect(),
  tcpSend: (data, hex) => tauri.tcpSend(data, hex),
  onTcpData: (cb) => tauri.onTcpData(cb),
  onTcpStatus: (cb) => tauri.onTcpStatus(cb),
  onTcpPeer: (cb) => tauri.onTcpPeer(cb),
  udpStart: (localHost, localPort, broadcast, multicast, group) =>
    tauri.udpStart(localHost, localPort, broadcast, multicast, group),
  udpStop: () => tauri.udpStop(),
  udpSend: (data, hex, host, port) => tauri.udpSend(data, hex, host, port),
  onUdpData: (cb) => tauri.onUdpData(cb),
  onUdpStatus: (cb) => tauri.onUdpStatus(cb),
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

/** 一次发送的字节表示（TCP 的广播目标数、UDP 的来源都在外面补） */
type MockPayload = Omit<TcpSent, "targets">;

/** 模拟发送：把输入框内容还原成字节，规则与 Rust 侧 parse_send_payload 一致 */
const mockPayloadOf = (data: string, hex: boolean): MockPayload => {
  if (!hex) {
    const bytes = Array.from(new TextEncoder().encode(data));
    return { len: bytes.length, hex: mockHex(data), text: data };
  }
  const raw = data.replace(/[\s,]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(raw)) throw new Error("HEX 数据包含非法字符");
  if (raw.length % 2 !== 0) throw new Error("HEX 数据长度不是偶数（每字节需要两位十六进制）");
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 2) bytes.push(parseInt(raw.slice(i, i + 2), 16));
  return {
    len: bytes.length,
    hex: bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" "),
    text: bytes.map((byte) => String.fromCharCode(byte)).join(""),
  };
};

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** 模拟烧录/擦除的节奏：真机也是先握手、再逐步推进进度 */
const mockDelay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

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
  flashLog: new Set<(line: FlashLogLine) => void>(),
  flashProgress: new Set<(p: FlashProgressPayload) => void>(),
  tcpData: new Set<(chunk: TcpChunk) => void>(),
  tcpStatus: new Set<(s: TcpStatus) => void>(),
  tcpPeer: new Set<(e: TcpPeerEvent) => void>(),
  udpData: new Set<(chunk: UdpChunk) => void>(),
  udpStatus: new Set<(s: UdpStatus) => void>(),
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

/** 模拟服务器主动发的报文：带行尾、有中文，方便验证 HEX 与时间戳 */
const TCP_MOCK_REPLIES = [
  "ACK: ok",
  "温度 23.5℃ 湿度 48.2%",
  "{\"type\":\"status\",\"rssi\":-62}",
  "ERR: timeout on channel 2",
];

/** 模拟服务端接入的客户端：固定几个地址，方便验证「来自 x:port」与广播目标数 */
const TCP_MOCK_CLIENTS = ["192.168.1.50:51234", "192.168.1.91:52100"];

let mockTcpConnected = false;
/** 当前链路是不是服务端：决定 tcpSend 是广播还是单发 */
let mockTcpServer = false;
/** 服务端在线客户端：模拟模式下不变化，启动时按最大连接数填几个 */
let mockTcpPeers: string[] = [];
let mockTcpTimer: number | null = null;
let mockTcpSeq = 0;

const stopMockTcp = () => {
  if (mockTcpTimer !== null) {
    window.clearInterval(mockTcpTimer);
    mockTcpTimer = null;
  }
  mockTcpConnected = false;
  mockTcpServer = false;
  mockTcpPeers = [];
};

/** 模拟 UDP 来源：固定几个地址，方便验证界面上「来自 x.x.x.x:port」前缀 */
const UDP_MOCK_PEERS = ["192.168.1.42:5000", "192.168.1.77:9000", "10.0.0.8:12000"];

const UDP_MOCK_REPLIES = [
  "ACK: ok",
  "温度 23.5℃ 湿度 48.2%",
  '{"type":"status","rssi":-62}',
  "ERR: timeout on channel 2",
];

let mockUdpRunning = false;
let mockUdpTimer: number | null = null;
let mockUdpSeq = 0;
let mockUdpLastPeer = UDP_MOCK_PEERS[0];
/** 是否真的收到过报文：服务端模式没收到过就不该能回复，与 Rust 侧一致 */
let mockUdpSeenPeer = false;

const stopMockUdp = () => {
  if (mockUdpTimer !== null) {
    window.clearInterval(mockUdpTimer);
    mockUdpTimer = null;
  }
  mockUdpRunning = false;
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
    stopMockTcp();
    stopMockUdp();
    mockAutosave = false;
    mockListeners.status.forEach((cb) => cb({ state: "closed", port: null, message: null }));
  },
  onLogBatch: (cb) => subscribe(mockListeners.batch, cb),
  onStats: (cb) => subscribe(mockListeners.stats, cb),
  onStatus: (cb) => subscribe(mockListeners.status, cb),
  onPorts: (cb) => subscribe(mockListeners.ports, cb),
  onAutosave: (cb) => subscribe(mockListeners.autosave, cb),
  async scanFirmware(root) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
    const base = root || "模拟项目";
    return {
      buildDir: `${base}/build`,
      chip: "esp32p4",
      flashSize: "16MB",
      flashFreq: "80m",
      version: "1.4.2",
      projectName: "stamp_dev",
      entries: [
        {
          offset: "0x0",
          path: `${base}/build/bootloader/bootloader.bin`,
          name: "bootloader/bootloader.bin",
          size: 20480,
          source: "flasher",
        },
        {
          offset: "0x8000",
          path: `${base}/build/partition_table/partition-table.bin`,
          name: "partition_table/partition-table.bin",
          size: 3072,
          source: "flasher",
        },
        {
          offset: "0x10000",
          path: `${base}/build/stamp_dev.bin`,
          name: "stamp_dev.bin",
          size: 1441792,
          source: "flasher",
        },
        {
          offset: "",
          path: `${base}/build/extra.bin`,
          name: "extra.bin",
          size: 65536,
          source: "extra",
        },
      ],
      logs: [
        { text: `开始扫描: ${base}/build`, level: "info" },
        { text: "发现配置文件: flasher_args.json", level: "info" },
        { text: "已读取版本号: V1.4.2", level: "info" },
        { text: "已读取项目名称: stamp_dev", level: "info" },
        { text: "解析到芯片信息: esp32p4, Flash: 16MB, 频率: 80m", level: "info" },
        { text: "找到: bootloader.bin (偏移: 0x0)", level: "info" },
        { text: "找到: partition-table.bin (偏移: 0x8000)", level: "info" },
        { text: "找到: stamp_dev.bin (偏移: 0x10000)", level: "info" },
        {
          text: "找到额外文件: extra.bin (未指定偏移地址，需手动填写偏移才会参与合并)",
          level: "warn",
        },
        { text: "扫描完成，共添加 4 个文件。", level: "ok" },
      ],
    };
  },
  async mergeFirmware(entries, root, outputDir, filename) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
    return {
      output: `${outputDir || root || "模拟项目"}/${filename}`,
      size: 0x2a0000,
      count: entries.length,
      overlaps: [],
    };
  },
  async chooseDirectory(title) {
    return title.includes("输出") ? "模拟项目/输出" : "模拟项目";
  },
  async chooseBinFile() {
    return "模拟项目/build/extra2.bin";
  },
  async espFlash(port, baud, chip, entries) {
    if (entries.length === 0) throw new Error("请至少选择一个烧录任务");
    const emitLog = (text: string, level: FlashLogLevel = "info") =>
      mockListeners.flashLog.forEach((cb) => cb({ text, level }));
    const started = Date.now();
    const totalBytes = entries.length * 512 * 1024;
    // 与真机同口径：written/total 是整次任务的字节数，速度是开始写入后的平均值
    const writeStarted = started + 220;
    const emitPct = (percent: number) => {
      const written = Math.round((totalBytes * percent) / 100);
      const secs = Math.max((Date.now() - writeStarted) / 1000, 0.001);
      mockListeners.flashProgress.forEach((cb) =>
        cb({ percent, written, total: totalBytes, bytesPerSec: Math.round(written / secs) }),
      );
    };

    emitLog(`正在连接 ${port}（${chip === "auto" ? "自动检测" : chip} @ ${baud}）…`);
    await mockDelay(220);
    emitLog(`准备烧录 ${entries.length} 个文件`, "info");
    emitLog("已连接 ESP32-S3，开始写入…", "ok");
    for (let percent = 0; percent <= 100; percent += 5) {
      emitPct(percent);
      await mockDelay(40);
    }

    const elapsedMs = Date.now() - started;
    emitLog(`烧录完成：${entries.length} 个文件，用时 ${(elapsedMs / 1000).toFixed(1)}s`, "ok");
    return { chip: "ESP32-S3", bytes: entries.length * 512 * 1024, files: entries.length, elapsedMs };
  },
  async espErase(port, baud, chip) {
    const emitLog = (text: string, level: FlashLogLevel = "info") =>
      mockListeners.flashLog.forEach((cb) => cb({ text, level }));
    const started = Date.now();
    // 擦除也走同一个进度事件，速度字段按 32MB 的容量算
    const totalBytes = 32 * 1024 * 1024;
    const emitPct = (percent: number) => {
      const written = Math.round((totalBytes * percent) / 100);
      const secs = Math.max((Date.now() - started) / 1000, 0.001);
      mockListeners.flashProgress.forEach((cb) =>
        cb({ percent, written, total: totalBytes, bytesPerSec: Math.round(written / secs) }),
      );
    };

    emitLog(`正在连接 ${port}（${chip === "auto" ? "自动检测" : chip} @ ${baud}）…`);
    await mockDelay(200);
    emitLog("开始擦除整片 Flash（32 MB，分 32 块），期间请勿断电", "warn");
    for (let percent = 0; percent <= 100; percent += 10) {
      emitPct(percent);
      await mockDelay(60);
    }

    const elapsedMs = Date.now() - started;
    emitLog(`擦除完成，用时 ${(elapsedMs / 1000).toFixed(1)}s`, "ok");
    return { chip: "ESP32-S3", bytes: 0, files: 0, elapsedMs };
  },
  async espDetect() {
    await mockDelay(360);
    return {
      chip: "ESP32-S3（revision v0.2）",
      crystal: "40 MHz",
      usb: "USB-Serial/JTAG",
      mac: "AC:67:B2:12:34:56",
      flashSize: "8 MB",
      flashMode: "—",
      flashId: "—",
      flashVoltage: "—",
      features: "Wi-Fi, Bluetooth 5, Dual Core + LP Core, 240MHz",
    };
  },
  onFlashLog: (cb) => subscribe(mockListeners.flashLog, cb),
  onFlashProgress: (cb) => subscribe(mockListeners.flashProgress, cb),
  async confirmErase() {
    return window.confirm("确定要擦除Flash吗？此操作将清除所有数据！");
  },
  async tcpConnect(host, port) {
    const target = host.trim();
    if (!target || !Number.isFinite(port) || port <= 0) {
      throw new Error("请输入有效的服务器地址与端口");
    }
    stopMockTcp();
    await mockDelay(320);
    // 端口 1 专门用来演示超时分支，其余端口一律连得上
    if (port === 1) throw new Error(`连接超时：请检查网络并确认 ${target}:${port} 是否在监听`);
    mockTcpConnected = true;
    const remote = `${target}:${port}`;
    mockListeners.tcpStatus.forEach((cb) => cb({ state: "open", remote, message: null }));
    mockTcpTimer = window.setInterval(() => {
      mockTcpSeq += 1;
      const text = `${pick(TCP_MOCK_REPLIES)} #${mockTcpSeq}\n`;
      const bytes = new TextEncoder().encode(text);
      mockListeners.tcpData.forEach((cb) =>
        cb({ ts: Date.now(), len: bytes.length, hex: mockHex(text), text, from: null }),
      );
    }, 1500);
    return remote;
  },
  async tcpListen(host, port, maxClients) {
    const target = host.trim();
    if (!target || !Number.isFinite(port) || port <= 0) {
      throw new Error("请输入有效的监听地址与端口");
    }
    stopMockTcp();
    await mockDelay(260);
    // 端口 1 借用客户端的超时开关演示「端口已被占用」
    if (port === 1) throw new Error(`${target}:${port} 已被占用，请换一个监听端口`);
    mockTcpConnected = true;
    mockTcpServer = true;
    const local = `${target}:${port}`;
    mockListeners.tcpStatus.forEach((cb) => cb({ state: "open", remote: local, message: null }));

    // 按「最大连接」提前接入几个客户端，方便验证广播与在线数
    const limit = Number.isFinite(maxClients) && maxClients > 0 ? maxClients : 1;
    mockTcpPeers = TCP_MOCK_CLIENTS.slice(0, Math.min(limit, TCP_MOCK_CLIENTS.length));
    mockTcpPeers.forEach((peer, index) =>
      mockListeners.tcpPeer.forEach((cb) =>
        cb({ kind: "connected", peer, count: index + 1 }),
      ),
    );
    mockTcpTimer = window.setInterval(() => {
      mockTcpSeq += 1;
      const text = `${pick(TCP_MOCK_REPLIES)} #${mockTcpSeq}\n`;
      const bytes = new TextEncoder().encode(text);
      const from = pick(mockTcpPeers);
      mockListeners.tcpData.forEach((cb) =>
        cb({ ts: Date.now(), len: bytes.length, hex: mockHex(text), text, from }),
      );
    }, 1500);
    return local;
  },
  async tcpDisconnect() {
    // 与 Rust 侧一致：主动断开不再补发 closed 状态，避免界面重复记一条
    stopMockTcp();
  },
  async tcpSend(data, hex) {
    if (!mockTcpConnected) throw new Error("尚未连接，无法发送");
    const sent = mockPayloadOf(data, hex);
    if (sent.len === 0) throw new Error("发送内容不能为空");
    await mockDelay(120);
    if (!mockTcpConnected) throw new Error("连接已断开");
    if (mockTcpServer) {
      // 服务端：没人接入/全掉线时与 Rust 侧同一句报错；广播成功不回显字节
      if (mockTcpPeers.length === 0) throw new Error("还没有客户端连接，无法发送");
      return { ...sent, targets: mockTcpPeers.length };
    }
    // 像回环服务器一样把发出的字节原样推回，方便验证收发通路
    mockListeners.tcpData.forEach((cb) =>
      cb({ ts: Date.now(), len: sent.len, hex: sent.hex, text: sent.text, from: null }),
    );
    return { ...sent, targets: 1 };
  },
  onTcpData: (cb) => subscribe(mockListeners.tcpData, cb),
  onTcpStatus: (cb) => subscribe(mockListeners.tcpStatus, cb),
  onTcpPeer: (cb) => subscribe(mockListeners.tcpPeer, cb),
  async udpStart(localHost, localPort, _broadcast, multicast, group) {
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      throw new Error("请输入有效的本地端口（0 表示由系统分配）");
    }
    if (multicast && !group.trim()) throw new Error("请输入组播地址");
    stopMockUdp();
    await mockDelay(200);
    mockUdpRunning = true;
    // 与真机同口径：本地端口 0 交给系统分配，返回值才是实际端口
    const bound = localPort === 0 ? 49152 + Math.floor(Math.random() * 1000) : localPort;
    const local = `${localHost.trim() || "0.0.0.0"}:${bound}`;
    mockUdpSeenPeer = false;
    mockListeners.udpStatus.forEach((cb) => cb({ state: "open", local, message: null }));
    mockUdpTimer = window.setInterval(() => {
      mockUdpSeq += 1;
      mockUdpLastPeer = pick(UDP_MOCK_PEERS);
      mockUdpSeenPeer = true;
      const text = `${pick(UDP_MOCK_REPLIES)} #${mockUdpSeq}\n`;
      const bytes = new TextEncoder().encode(text);
      mockListeners.udpData.forEach((cb) =>
        cb({ ts: Date.now(), len: bytes.length, hex: mockHex(text), text, from: mockUdpLastPeer }),
      );
    }, 1500);
    return local;
  },
  async udpStop() {
    // 与 Rust 侧一致：主动停止不再补发状态，避免界面重复记一条
    stopMockUdp();
  },
  async udpSend(data, hex, host, port) {
    if (!mockUdpRunning) throw new Error("尚未启动，无法发送");
    const sent = mockPayloadOf(data, hex);
    if (sent.len === 0) throw new Error("发送内容不能为空");
    await mockDelay(80);
    if (!mockUdpRunning) throw new Error("UDP 已停止");
    // host 为空 = 服务端模式：回给最近来源，与 Rust 侧一致
    if (!host.trim() && !mockUdpSeenPeer) {
      throw new Error("还没收到过报文，无法确定回复目标");
    }
    const to = host.trim() ? `${host.trim()}:${port}` : mockUdpLastPeer;
    // 像回环服务器一样把发出的字节原样推回，方便验证收发通路
    mockListeners.udpData.forEach((cb) =>
      cb({ ts: Date.now(), len: sent.len, hex: sent.hex, text: sent.text, from: to }),
    );
    return { ...sent, to };
  },
  onUdpData: (cb) => subscribe(mockListeners.udpData, cb),
  onUdpStatus: (cb) => subscribe(mockListeners.udpStatus, cb),
};

export const backend: Backend = isTauriRuntime() ? realBackend : mockBackend;
