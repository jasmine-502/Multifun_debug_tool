import {
  COMM_HISTORY_LIMIT,
  COMM_SEND_ROWS,
  type CommFormat,
  type CommMode,
  type CommProtocol,
} from "../../lib/types";

/** 收发记录、5 行发送配置和地址历史都存在这一个 key 下 */
export const PREFS_KEY = "multifun-serial.comm.prefs.v1";

/** 合并前两个独立页面各自的 key，只用来做一次迁移 */
const LEGACY_TCP_KEY = "multifun-serial.tcp.prefs.v1";
const LEGACY_UDP_KEY = "multifun-serial.udp.prefs.v1";

/** 终端里的一行：接收/发送都带 hex，切 HEX 视图时能回溯已显示的内容 */
export type EntryLevel = "rx" | "tx" | "info" | "warn" | "error";

export interface CommEntry {
  id: number;
  ts: number;
  level: EntryLevel;
  text: string;
  /** 只有 rx / tx 才有：十六进制视图用的无损表示 */
  hex?: string;
  /** 对端：接收是来源地址，发送是目标（TCP 服务端是广播目标描述） */
  peer?: string;
}

export interface SendRow {
  data: string;
  interval: string;
  format: CommFormat;
  auto: boolean;
}

export interface Prefs {
  protocol?: CommProtocol;
  mode?: CommMode;
  // TCP：客户端是服务器地址，服务端是监听地址
  host?: string;
  port?: string;
  maxClients?: string;
  hostHistory?: string[];
  portHistory?: string[];
  // UDP：绑定本地端口，客户端另有远程目标
  localHost?: string;
  localPort?: string;
  localHostHistory?: string[];
  localPortHistory?: string[];
  remoteHost?: string;
  remotePort?: string;
  remoteHostHistory?: string[];
  remotePortHistory?: string[];
  broadcast?: boolean;
  multicast?: boolean;
  group?: string;
  // 两个协议共用
  rows?: SendRow[];
  hexView?: boolean;
  timestamp?: boolean;
  showRecv?: boolean;
  highlight?: string;
}

const readJson = (key: string): Prefs | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Prefs) : null;
  } catch {
    return null;
  }
};

/**
 * 先读合并后的 key；没有就回退到旧的 TCP / UDP 两份。
 * 共享字段（模式、发送行、显示开关、醒目词）以 TCP 那份为准：
 * 两者语义完全一致，谁覆盖谁只影响用户第一次打开时看到的内容。
 */
export const loadPrefs = (): Prefs => {
  const own = readJson(PREFS_KEY);
  if (own) return own;
  const tcp = readJson(LEGACY_TCP_KEY);
  const udp = readJson(LEGACY_UDP_KEY);
  if (!tcp && !udp) return {};
  return { ...(udp ?? {}), ...(tcp ?? {}) };
};

export const savePrefs = (prefs: Prefs) => {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式下写不进去，不影响当前会话 */
  }
};

export const blankRows = (): SendRow[] =>
  Array.from({ length: COMM_SEND_ROWS }, () => ({
    data: "",
    interval: "1000",
    format: "ascii" as CommFormat,
    auto: false,
  }));

/** 恢复上次的 5 行配置；自动发送一律不恢复，免得一开机就往设备连发指令 */
export const restoreRows = (saved: SendRow[] | undefined): SendRow[] => {
  const rows = blankRows();
  if (!saved) return rows;
  return rows.map((row, index) => {
    const item = saved[index];
    if (!item) return row;
    return {
      data: typeof item.data === "string" ? item.data : "",
      interval: typeof item.interval === "string" ? item.interval : row.interval,
      format: item.format === "hex" ? "hex" : "ascii",
      auto: false,
    };
  });
};

/** 地址/端口历史：新的插到最前面，重复的旧记录删掉，只留最近 20 条 */
export const pushHistory = (value: string, list: string[]): string[] => {
  const trimmed = value.trim();
  if (!trimmed) return list;
  return [trimmed, ...list.filter((item) => item !== trimmed)].slice(0, COMM_HISTORY_LIMIT);
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const stampOf = (ts: number): string => {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, "0")}`;
};

export const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
};

export const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** 自动发送间隔：空值/非法值回退 1000ms，下限 10ms 防止把网卡打满 */
export const intervalOf = (raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1000;
  return Math.min(3_600_000, Math.max(10, value));
};

/** 从 "0.0.0.0:8001" 取出实际端口：本地端口填 0 时只有它才是真端口 */
export const portOf = (local: string | null): number | null => {
  if (!local) return null;
  const value = Number(local.slice(local.lastIndexOf(":") + 1));
  return Number.isInteger(value) ? value : null;
};
