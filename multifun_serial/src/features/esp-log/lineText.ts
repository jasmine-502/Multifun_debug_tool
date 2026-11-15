import type { LogLine } from "../../lib/types";

/**
 * 日志行文本化的唯一实现。
 *
 * 屏幕渲染、右键复制、保存日志文件三处必须共用它，否则会出现
 * "界面是 HEX、存下来是乱码" 这种对不上的情况。
 */

/** `12:34:56.789 ` 占的字符数，折行计算要算进去 */
export const STAMP_CELLS = 13;

const encoder = new TextEncoder();

/** 按 UTF-8 字节展示，不可见字符和乱码都能看出来 */
export function toHex(text: string): string {
  const bytes = encoder.encode(text);
  if (bytes.length === 0) return "";
  const parts: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    parts[i] = bytes[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return parts.join(" ");
}

/** 毫秒级时间戳；时间无效时用等宽的占位符，避免行宽跳动 */
export function stampOf(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--.---";
  const d = new Date(ts);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 一行在 HEX 视图下的文本。
 * 优先用后端在切包那刻生成的 `line.hex`——`raw` 已过 `from_utf8_lossy`，
 * 非法字节变成了 U+FFFD，行尾也被 trim 掉了，从它反推的十六进制是错的。
 */
export function hexOf(line: LogLine): string {
  return line.hex || toHex(line.raw);
}

export interface LineTextOptions {
  hex: boolean;
  timestamp: boolean;
}

export function lineText(line: LogLine, options: LineTextOptions): string {
  const body = options.hex ? hexOf(line) : line.raw;
  return options.timestamp ? `${stampOf(line.ts)} ${body}` : body;
}
