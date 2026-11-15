import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Copy, CopyCheck, Download, Trash2 } from "lucide-react";
import type { LogLine } from "../../lib/types";
import { STAMP_CELLS, hexOf, lineText, stampOf } from "./lineText";

/** 必须与 tokens.css 的 --term-row-height 一致，虚拟滚动靠它算位置 */
const ROW_HEIGHT = 22;
const OVERSCAN = 12;
/** .term-row 左右各 12px 内边距，折行宽度要扣掉 */
const ROW_PADDING_X = 24;

/** 东亚宽字符（含 emoji）：占 2 个等宽单元格 */
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const NON_ASCII = /[^\u0000-\u007F]/;

function cellsOf(text: string): number {
  // 纯 ASCII 直接按下标算，避免逐字符遍历（串口日志绝大多数行都是 ASCII）
  if (!NON_ASCII.test(text)) return text.length;
  let cells = 0;
  for (const ch of text) {
    cells += ch.length > 1 || WIDE_CHAR.test(ch) ? 2 : 1;
  }
  return cells;
}

/** 折行后的显示行数：只用来排布局，不参与文本渲染 */
function displayCells(line: LogLine, hex: boolean, timestamp: boolean): number {
  const body = hex ? hexOf(line).length : cellsOf(line.raw);
  return timestamp ? body + STAMP_CELLS : body;
}

function renderSegments(text: string, query: string, active: boolean): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let hit = lower.indexOf(needle);
  let key = 0;

  while (hit !== -1) {
    if (hit > from) parts.push(text.slice(from, hit));
    parts.push(
      <mark key={`m${key}`} className={active ? "is-active" : undefined}>
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    key += 1;
    from = hit + needle.length;
    hit = lower.indexOf(needle, from);
  }

  if (parts.length === 0) return text;
  if (from < text.length) parts.push(<Fragment key="tail">{text.slice(from)}</Fragment>);
  return parts;
}

/** 在 offsets 里找第一行满足 offsets[i] <= y 的下标 */
function findRow(offsets: Float32Array, y: number, count: number): number {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Tauri WebView 里 clipboard API 可能被拒，退回 textarea + execCommand
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

interface LogTerminalProps {
  lines: LogLine[];
  /** 缓冲版本号：append 用 push 复用同一数组，只有它可以触发重算 */
  version: number;
  query: string;
  /** 当前命中的行下标（相对缓冲数组），-1 表示无 */
  activeIndex: number;
  autoScroll: boolean;
  onAutoScrollChange: (next: boolean) => void;
  /** 以十六进制字节展示 */
  hex: boolean;
  /** 行首显示切包时间 HH:MM:SS.mmm */
  timestamp: boolean;
  /** 正文颜色压过各级别色（颜色设置里的「统一正文颜色」） */
  flatColor: boolean;
  /** 长行自动折行（关掉则横向滚动，两者都是定高虚拟滚动） */
  wrap: boolean;
  onClear: () => void;
  /** 导出缓存行的原始字节（唯一无损的保存方式） */
  onSaveRaw: () => void;
}

/**
 * 日志终端：只渲染可视窗口。
 * 2 万行缓冲下 DOM 常驻节点数保持在 100 以内，避免 WebView 累积排版卡死。
 * 折行模式靠等宽字体的字符宽度反推行高，仍然保持虚拟滚动。
 */
export default function LogTerminal({
  lines,
  version,
  query,
  activeIndex,
  autoScroll,
  onAutoScrollChange,
  hex,
  timestamp,
  flatColor,
  wrap,
  onClear,
  onSaveRaw,
}: LogTerminalProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(400);
  const [contentWidth, setContentWidth] = useState(0);
  const [charW, setCharW] = useState(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    selection: string;
  } | null>(null);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewHeight(el.clientHeight);
      setContentWidth(el.clientWidth);
    });
    observer.observe(el);
    setViewHeight(el.clientHeight);
    setContentWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // 用真实的 .term-row 样式量出一个字符的宽度，折行才能算准
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => {
      const probe = document.createElement("span");
      probe.className = "term-row term-row--probe";
      probe.textContent = "0".repeat(50);
      el.appendChild(probe);
      const width = (probe.getBoundingClientRect().width - ROW_PADDING_X) / 50;
      probe.remove();
      if (Number.isFinite(width) && width > 0) setCharW(width);
    };
    measure();
    void document.fonts?.ready.then(measure);
  }, []);

  // 自动滚动：新日志到达时贴底
  useEffect(() => {
    if (!autoScroll) return;
    const el = viewRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [lines.length, autoScroll]);

  const cols =
    charW > 0 && contentWidth > ROW_PADDING_X
      ? Math.max(8, Math.floor((contentWidth - ROW_PADDING_X - 2) / charW))
      : 0;

  /**
   * 折行模式下的行偏移表。关闭折行时返回 null，走 i * ROW_HEIGHT 的算术路径。
   * 依赖 version 而不是 lines：logStore 用 push 写同一个数组，引用不变。
   */
  const layout = useMemo(() => {
    if (!wrap || cols <= 0) return null;
    const count = lines.length;
    const offsets = new Float32Array(count + 1);
    let acc = 0;
    for (let i = 0; i < count; i += 1) {
      offsets[i] = acc;
      const rows = Math.max(1, Math.ceil(displayCells(lines[i], hex, timestamp) / cols));
      acc += rows * ROW_HEIGHT;
    }
    offsets[count] = acc;
    return { offsets, height: acc };
  }, [wrap, cols, hex, timestamp, version, lines]);

  // 命中跳转：把目标行滚到视口中间
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = viewRef.current;
    if (!el) return;
    const top = layout ? layout.offsets[activeIndex] : activeIndex * ROW_HEIGHT;
    const inView = top >= el.scrollTop && top + ROW_HEIGHT <= el.scrollTop + el.clientHeight;
    if (!inView) {
      el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 2));
      setScrollTop(el.scrollTop);
    }
  }, [activeIndex, layout]);

  // 折行让总高度变化时，贴底状态要跟着重新贴一次
  useEffect(() => {
    if (!autoScroll) return;
    const el = viewRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [layout, autoScroll]);

  // 右键菜单：点空白、Esc、窗口变化都关掉
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const handleScroll = () => {
    const el = viewRef.current;
    if (!el) return;
    // 菜单是 fixed 定位，滚动后与原位脱节，直接关掉
    if (menu) setMenu(null);
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    if (atBottom && !autoScroll) onAutoScrollChange(true);
    else if (!atBottom && autoScroll) onAutoScrollChange(false);
  };

  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - 184),
      y: Math.min(event.clientY, window.innerHeight - 176),
      selection: window.getSelection()?.toString() ?? "",
    });
  };

  const total = lines.length;
  /** 复制出来的内容必须等于屏幕上的内容，所以走和渲染同一个 lineText */
  const allText = () => lines.map((line) => lineText(line, { hex, timestamp })).join("\n");
  const offsets = layout?.offsets ?? null;
  const totalHeight = layout ? layout.height : total * ROW_HEIGHT;
  const first = offsets
    ? Math.max(0, findRow(offsets, scrollTop, total) - OVERSCAN)
    : Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  let last = first;
  if (offsets) {
    const bottom = scrollTop + viewHeight;
    while (last < total && offsets[last] <= bottom) last += 1;
  } else {
    last = first + Math.ceil(viewHeight / ROW_HEIGHT) + OVERSCAN * 2;
  }
  last = Math.min(total, last + OVERSCAN);

  const rows: ReactNode[] = [];
  for (let i = first; i < last; i += 1) {
    const line = lines[i];
    const top = offsets ? offsets[i] : i * ROW_HEIGHT;
    const height = offsets ? offsets[i + 1] - top : ROW_HEIGHT;
    const text = hex ? hexOf(line) : line.raw;
    const className = [
      "term-row",
      `term-row--${line.level.toLowerCase()}`,
      wrap ? "term-row--wrap" : "",
    ]
      .filter(Boolean)
      .join(" ");
    rows.push(
      <div
        key={line.seq}
        className={className}
        style={{ transform: `translateY(${top}px)`, height }}
      >
        {/* HEX 视图下 keyword 高亮没有意义，直接给纯文本避免误标 */}
        {/* 尾部空格必须显式插入：JSX 在换行缩进时会把裸空格裁掉 */}
        {timestamp && (
          <span className="term-ts">{stampOf(line.ts)}{" "}</span>
        )}
        {hex ? text : renderSegments(text, query, i === activeIndex)}
      </div>,
    );
  }

  const classes = [
    "terminal",
    wrap ? "terminal--wrap" : "",
    flatColor ? "terminal--flat-color" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      ref={viewRef}
      onScroll={handleScroll}
      onContextMenu={openMenu}
    >
      <div className="terminal__inner" style={{ height: totalHeight }}>
        {rows}
      </div>
      {total === 0 && (
        <div className="terminal__empty">
          <span>还没有日志</span>
          <span className="terminal__empty-hint">选择串口后点击「打开串口」开始接收</span>
        </div>
      )}

      {menu && (
        <div
          className="term-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="term-menu__item"
            disabled={menu.selection.length === 0}
            onClick={() => {
              void copyText(menu.selection);
              setMenu(null);
            }}
          >
            <CopyCheck size={13} />
            复制选中
          </button>
          <button
            type="button"
            className="term-menu__item"
            onClick={() => {
              void copyText(allText());
              setMenu(null);
            }}
          >
            <Copy size={13} />
            复制全部（{total} 行）
          </button>
          <div className="term-menu__split" />
          <button
            type="button"
            className="term-menu__item"
            onClick={() => {
              onSaveRaw();
              setMenu(null);
            }}
          >
            <Download size={13} />
            导出原始数据（.bin）
          </button>
          <button
            type="button"
            className="term-menu__item term-menu__item--danger"
            onClick={() => {
              onClear();
              setMenu(null);
            }}
          >
            <Trash2 size={13} />
            清空日志
          </button>
        </div>
      )}
    </div>
  );
}
