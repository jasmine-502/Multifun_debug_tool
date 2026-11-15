import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronUp,
  FolderOpen,
  Palette,
  Play,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react";
import Button from "../../shell/Button";
import Card from "../../shell/Card";
import PageShell from "../../shell/PageShell";
import Switch from "../../shell/Switch";
import { backend } from "../../lib/backend";
import type { Unlisten } from "../../lib/ipc";
import {
  BAUD_RATES,
  DEFAULT_LEVEL_FILTER,
  type ConnStatus,
  type DataMode,
  type LevelFilter,
  type LogLevel,
  type PortInfo,
  type SplitMode,
  type Stats,
} from "../../lib/types";
import ColorSettings, { DEFAULT_TERM_FG, DEFAULT_TERM_TS } from "./ColorSettings";
import LevelChips from "./LevelChips";
import LogTerminal from "./LogTerminal";
import SearchPanel, { type SearchHit } from "./SearchPanel";
import { lineText } from "./lineText";
import { MAX_LINES, logStore } from "./logStore";

const PREFS_KEY = "esp-log-console.prefs.v2";
/** 旧 key 里的 port / resetOnOpen 已失效：那是浏览器 mock 时代的假端口与旧复位语义 */
const LEGACY_PREFS_KEY = "esp-log-console.prefs";

interface Prefs {
  port?: string;
  baud?: string;
  levels?: LevelFilter;
  tags?: string;
  autoSave?: boolean;
  resetOnOpen?: boolean;
  /** 十六进制视图 */
  hex?: boolean;
  /** 行首显示切包时间 */
  timestamp?: boolean;
  /** 长行自动折行 */
  wrap?: boolean;
  /** 数据源：ESP-IDF 日志 / 通用串口 */
  mode?: DataMode;
  /** 通用串口的切包策略 */
  split?: SplitMode;
  /** 定长切包时的每包字节数 */
  fixedSize?: number;
  /** 日志区正文颜色（覆盖 --term-fg） */
  termFg?: string;
  /** 日志区时间戳颜色（覆盖 --term-ts） */
  termTs?: string;
  /** 正文颜色是否压过各级别色 */
  flatColor?: boolean;
}

const loadPrefs = (): Prefs => {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) as Prefs;
    // 首次升级：只继承与串口选择无关的偏好，端口和复位开关重新取值
    const legacy = JSON.parse(
      window.localStorage.getItem(LEGACY_PREFS_KEY) ?? "{}",
    ) as Prefs;
    return { baud: legacy.baud, levels: legacy.levels, tags: legacy.tags };
  } catch {
    return {};
  }
};

const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
};

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** 日志文件取最后两段（`2026-11/ESP32_Log_x.txt`）：按年月分层后只给文件名看不出分到哪去了 */
const monthAndFile = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

export default function EspLogPage() {
  const prefs = useRef(loadPrefs()).current;

  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState(prefs.port ?? "");
  const [baud, setBaud] = useState(prefs.baud ?? "115200");
  const [conn, setConn] = useState<ConnStatus>({ state: "closed", port: null, message: null });
  const [levels, setLevels] = useState<LevelFilter>(prefs.levels ?? DEFAULT_LEVEL_FILTER);
  const [tags, setTags] = useState(prefs.tags ?? "");
  const [autoSave, setAutoSave] = useState(prefs.autoSave ?? true);
  const [resetOnOpen, setResetOnOpen] = useState(prefs.resetOnOpen ?? true);
  /** 终端显示选项：与串口参数无关，但一样要持久化 */
  const [hex, setHex] = useState(prefs.hex ?? false);
  const [timestamp, setTimestamp] = useState(prefs.timestamp ?? false);
  const [wrap, setWrap] = useState(prefs.wrap ?? false);
  /** 数据源与切包策略：只在打开串口时生效，所以连接后控件置灰 */
  const [mode, setMode] = useState<DataMode>(prefs.mode ?? "esp");
  const [split, setSplit] = useState<SplitMode>(prefs.split ?? "crlf");
  const [fixedSize, setFixedSize] = useState(prefs.fixedSize ?? 64);
  /** 日志颜色：直接落到 :root 的 CSS 变量上，改一个字符终端就变 */
  const [termFg, setTermFg] = useState(prefs.termFg ?? DEFAULT_TERM_FG);
  const [termTs, setTermTs] = useState(prefs.termTs ?? DEFAULT_TERM_TS);
  const [flatColor, setFlatColor] = useState(prefs.flatColor ?? false);
  const [colorOpen, setColorOpen] = useState(false);
  const [autoSavePath, setAutoSavePath] = useState<string | null>(null);
  const [logDir, setLogDir] = useState("");
  const [stats, setStats] = useState<Stats>({ bytes: 0, bytesPerSec: 0, lines: 0 });
  const [autoScroll, setAutoScroll] = useState(true);
  const [queryInput, setQueryInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeHit, setActiveHit] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 已连接时配置区默认收起，把高度留给终端；手动展开后保留 */
  const [configOpen, setConfigOpen] = useState(false);
  /** 连接建立时已接收的字节数，用来判断这次连接到底有没有收到数据 */
  const bytesAtOpen = useRef(0);
  const lastBytes = useRef(0);
  const [noData, setNoData] = useState(false);

  /**
   * 通用串口：不解析 ESP-IDF 级别/日志名，过滤降级为关键字包含。
   * 必须声明在所有把它写进依赖数组的 effect 之前——依赖数组是在渲染期求值的，
   * 放到后面会直接报 TDZ（Cannot access 'generic' before initialization）。
   */
  const generic = mode === "generic";

  const version = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot, logStore.getSnapshot);
  const lines = useMemo(() => logStore.getLines(), [version]);

  /* ---- 订阅后端事件 ---- */
  useEffect(() => {
    let disposed = false;
    const unlisteners: Unlisten[] = [];
    const keep = (unlisten: Unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };

    void (async () => {
      keep(await backend.onLogBatch((batch) => logStore.append(batch.lines)));
      keep(await backend.onStats((next) => setStats(next)));
      keep(
        await backend.onStatus((next) => {
          setConn(next);
          if (next.state === "error" && next.message) setError(next.message);
        }),
      );
      keep(await backend.onPorts((next) => {
        setPorts(next);
        // 设备插拔后旧选择可能已经不存在（含浏览器 mock 留下的假 COM 号）
        setPort((current) =>
          next.some((item) => item.port === current) ? current : (next[0]?.port ?? ""),
        );
      }));
      keep(
        await backend.onAutosave((next) => {
          // 这里只反映“文件状态”，不能反向覆盖用户的开关偏好：
          // 关闭串口时后端也会发 enabled:false（意为写入结束）
          if (next.path) setAutoSavePath(next.path);
        }),
      );
      const initial = await backend.listPorts();
      if (!disposed) {
        setPorts(initial);
        setPort((current) =>
          initial.some((item) => item.port === current) ? current : (initial[0]?.port ?? ""),
        );
      }
      const dir = await backend.defaultLogDir();
      if (!disposed) setLogDir(dir);
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      // 页面真的卸载时收尾，避免 mock 定时器或 Rust 读线程残留
      void backend.shutdown();
    };
  }, []);

  /* ---- 偏好持久化 ---- */
  useEffect(() => {
    const prefsToSave: Prefs = {
      port,
      baud,
      levels,
      tags,
      autoSave,
      resetOnOpen,
      hex,
      timestamp,
      wrap,
      mode,
      split,
      fixedSize,
      termFg,
      termTs,
      flatColor,
    };
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefsToSave));
  }, [
    port,
    baud,
    levels,
    tags,
    autoSave,
    resetOnOpen,
    hex,
    timestamp,
    wrap,
    mode,
    split,
    fixedSize,
    termFg,
    termTs,
    flatColor,
  ]);

  /* ---- 过滤条件下发（防抖）---- */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void backend.setFilters(levels, tags, generic);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [levels, tags, generic]);

  /* ---- 日志颜色：写回 :root 的 CSS 变量 ---- */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--term-fg", termFg);
    root.style.setProperty("--term-ts", termTs);
  }, [termFg, termTs]);

  /* ---- 落盘格式跟随显示：HEX / 时间戳变了同步给后端，否则 .txt 里是乱码 ---- */
  useEffect(() => {
    void backend.setAutosaveFormat(hex, timestamp);
  }, [hex, timestamp]);

  /* ---- 提示自动消失 ---- */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = ports.find((item) => item.port === port);
  const portLabel = selected ? `${selected.port} - ${selected.description}` : port;
  const connected = conn.state === "open";
  // 两种口都允许复位，但原生 USB 口走的是 USB-JTAG 的标准时序（只拉 EN）
  const willReset = resetOnOpen;
  // 未连接时必须展示完整配置；已连接时默认收起，可手动展开
  const showConfig = !connected || configOpen;
  const autoSaveHint = autoSavePath
    ? monthAndFile(autoSavePath)
    : logDir
      ? `${basename(logDir)}/`
      : "";

  /* ---- 连接后 6 秒无数据就提示（download 模式 / 口选错 / 波特率错）---- */
  useEffect(() => {
    lastBytes.current = stats.bytes;
  }, [stats.bytes]);

  useEffect(() => {
    if (!connected) {
      setNoData(false);
      return;
    }
    setNoData(false);
    const timer = window.setTimeout(() => {
      if (lastBytes.current <= bytesAtOpen.current) setNoData(true);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [connected]);

  const refreshPorts = async () => {
    try {
      const next = await backend.listPorts();
      setPorts(next);
      if (!next.some((item) => item.port === port)) setPort(next[0]?.port ?? "");
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleConnection = async () => {
    setError(null);
    setNotice(null);
    if (connected) {
      setBusy(true);
      try {
        await backend.closeLog();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!port) {
      setError("请先选择串口");
      return;
    }
    const baudRate = Number(baud);
    if (!Number.isFinite(baudRate) || baudRate <= 0) {
      setError(`无效的波特率: ${baud}`);
      return;
    }
    setBusy(true);
    bytesAtOpen.current = stats.bytes;
    try {
      setAutoSavePath(null);
      // 落盘格式要赶在读线程创建文件之前写好，否则开头几行还是旧格式
      await backend.setAutosaveFormat(hex, timestamp);
      // autosave 必须随 openLog 一起下发：后端 AutosaveControl 默认关闭，
      // 而读线程一启动就会创建写句柄
      await backend.openLog({
        port,
        baud: baudRate,
        label: portLabel,
        reset: willReset,
        autosave: autoSave,
        generic,
        split,
        fixedSize,
        idleMs: 50,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAutoSave = async (next: boolean) => {
    setAutoSave(next);
    if (!next) setAutoSavePath(null);
    try {
      await backend.setAutosave(next, null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleSave = async () => {
    const all = logStore.getLines();
    // 跟随当前视图：HEX 视图下存 raw 文本，等于给用户一份和屏幕对不上的文件
    const content = all.map((line) => lineText(line, { hex, timestamp })).join("\n");
    if (!content) {
      setNotice("当前没有可保存的日志");
      return;
    }
    setBusy(true);
    try {
      const saved = await backend.saveSnapshot(content);
      if (saved) setNotice(`日志已保存: ${saved}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveRaw = async () => {
    const all = logStore.getLines();
    if (all.length === 0) {
      setNotice("当前没有可导出的数据");
      return;
    }
    setBusy(true);
    try {
      // hex 带行尾，逐行拼接就是原始字节流，落盘完全无损
      const saved = await backend.saveRaw(all.map((line) => line.hex).join("\n"));
      if (saved) setNotice(`原始数据已保存: ${saved}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenDir = async () => {
    try {
      await backend.openLogDir();
    } catch (err) {
      setError(String(err));
    }
  };

  const runSearch = () => {
    const query = queryInput.trim();
    if (!query) {
      setHits([]);
      setActiveQuery("");
      setActiveHit(-1);
      return;
    }
    const all = logStore.getLines();
    const needle = query.toLowerCase();
    const found: SearchHit[] = [];
    for (let i = 0; i < all.length; i += 1) {
      if (all[i].raw.toLowerCase().includes(needle)) {
        found.push({ index: i, lineText: all[i].raw });
      }
    }
    setActiveQuery(query);
    setHits(found);
    setActiveHit(found.length > 0 ? 0 : -1);
    setAutoScroll(false);
    if (found.length === 0) setNotice(`未找到「${query}」`);
  };

  const closeSearch = () => {
    setActiveQuery("");
    setHits([]);
    setActiveHit(-1);
  };

  const handleClear = () => {
    logStore.clear();
    closeSearch();
    setStats({ bytes: 0, bytesPerSec: 0, lines: 0 });
  };

  const toggleLevel = (level: LogLevel) => {
    setLevels((current) => ({ ...current, [level]: current[level] === false }));
  };

  /**
   * 切数据源。复位开关跟着切：ESP32 不脉冲 EN 会停在 ROM 里不吐字节，
   * 而普通设备的 EN 未必接在 RTS 上，默认复位只会有意外重启的风险。
   */
  const changeMode = (next: DataMode) => {
    if (next === mode) return;
    setMode(next);
    setResetOnOpen(next === "esp");
  };

  return (
    <PageShell
      fill
      // 已连接时收起配置，页面留白一起收紧，把高度让给日志终端
      className={connected ? "page-shell--focus" : undefined}
      title={generic ? "串口日志" : "ESP32 日志"}
      subtitle={
        connected
          ? "串口实时日志 · 配置已收起，点右侧「配置」可随时展开"
          : generic
            ? "通用串口：不解析 ESP-IDF 前缀，按行尾 / 空闲 / 定长切包，HEX 视图无损"
            : "串口实时日志，过滤 / 查找 / 自动保存与 Qt 版保持一致"
      }
      actions={
        <>
          <Button variant="ghost" size="small" onClick={refreshPorts} disabled={connected}>
            <RefreshCw size={14} />
            刷新端口
          </Button>
          <Button
            variant={connected ? "secondary" : "primary"}
            onClick={toggleConnection}
            loading={busy}
            loadingLabel={connected ? "关闭中…" : "打开中…"}
          >
            {connected ? (
              <>
                <Square size={14} />
                关闭串口
              </>
            ) : (
              <>
                <Play size={14} />
                {backend.mock ? "打开模拟串口" : "打开串口"}
              </>
            )}
          </Button>
        </>
      }
    >
      {backend.mock && (
        <div className="banner banner--warning">
          浏览器模拟模式：下面刷出来的日志是<b>假数据</b>，并没有连接任何串口。要接真实设备请用
          <span className="mono"> npm run dev </span>启动 Tauri 版本。
        </div>
      )}

      {showConfig ? (
        <Card
          title="连接"
          subtitle={
            generic
              ? "按行尾切包只认 CR/LF；如果设备不带分隔符（或只用 \\r），改用空闲超时或定长切包"
              : "默认只监听，不动 DTR/RTS；勾选「打开时复位」才会拉一次 EN 让设备重启"
          }
          actions={
            connected ? (
              <Button variant="ghost" size="small" onClick={() => setConfigOpen(false)}>
                <ChevronUp size={14} />
                收起配置
              </Button>
            ) : undefined
          }
        >
          <div className="toolbar">
            <div className="toolbar__group">
              <span className="field__label">数据源</span>
              <div className="segmented" role="group" aria-label="数据源">
                <button
                  type="button"
                  className={`segmented__item${generic ? "" : " is-active"}`}
                  disabled={connected}
                  onClick={() => changeMode("esp")}
                >
                  ESP-IDF 日志
                </button>
                <button
                  type="button"
                  className={`segmented__item${generic ? " is-active" : ""}`}
                  disabled={connected}
                  onClick={() => changeMode("generic")}
                >
                  通用串口
                </button>
              </div>
            </div>

            {generic && (
              <>
                <div className="toolbar__divider" />
                <div className="toolbar__group">
                  <span className="field__label">切包</span>
                  <select
                    className="select"
                    value={split}
                    disabled={connected}
                    onChange={(event) => setSplit(event.target.value as SplitMode)}
                  >
                    <option value="crlf">按行尾（CR / LF）</option>
                    <option value="idle">按空闲超时（50ms）</option>
                    <option value="fixed">按固定字节数</option>
                  </select>
                </div>
                {split === "fixed" && (
                  <div className="toolbar__group">
                    <span className="field__label">每包</span>
                    <input
                      className="input input--mono"
                      style={{ width: 78 }}
                      type="number"
                      min={1}
                      max={4096}
                      value={fixedSize}
                      disabled={connected}
                      onChange={(event) =>
                        setFixedSize(Math.min(4096, Math.max(1, Number(event.target.value) || 1)))
                      }
                    />
                    <span className="field__hint">字节</span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="toolbar">
            <div className="toolbar__group">
              <span className="field__label">串口</span>
              <select
                className="select"
                value={port}
                disabled={connected}
                onChange={(event) => setPort(event.target.value)}
              >
                {ports.length === 0 && <option value="">未检测到串口</option>}
                {ports.map((item) => (
                  <option key={item.port} value={item.port}>
                    {item.port} - {item.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="toolbar__group">
              <span className="field__label">波特率</span>
              {/* 普通设备常出现 4800 / 230400 / 460800 这类值，固定下拉框不够用 */}
              <input
                className="input input--mono"
                style={{ width: 104 }}
                list="esp-log-baud"
                value={baud}
                disabled={connected}
                onChange={(event) => setBaud(event.target.value)}
              />
              <datalist id="esp-log-baud">
                {BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate} />
                ))}
              </datalist>
            </div>

            <div className="toolbar__divider" />

            <Switch checked={autoSave} onChange={handleAutoSave} label="自动保存日志" />
            <Switch checked={resetOnOpen} onChange={setResetOnOpen} label="打开时复位设备" />
            {!generic && selected?.jtag && (
              <span className="field__hint">原生 USB 口：复位只拉 EN（USB-JTAG 标准时序）</span>
            )}
            {autoSave && autoSaveHint && (
              <span className="field__hint mono" title={autoSavePath ?? logDir}>
                → {autoSaveHint}
              </span>
            )}
          </div>

          <div className="toolbar">
            {!generic && (
              <>
                <LevelChips value={levels} onToggle={toggleLevel} />
                <div className="toolbar__divider" />
              </>
            )}
            <div className="toolbar__group" style={{ flex: 1 }}>
              <span className="field__label">{generic ? "包含关键字" : "过滤日志"}</span>
              <input
                className="input input--mono input--grow"
                placeholder={
                  generic
                    ? "只显示包含这些关键字的包，逗号分隔，如: ERROR,timeout"
                    : "日志名称，逗号分隔，如: EmojiConfig,Backlight"
                }
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
            </div>
          </div>
        </Card>
      ) : (
        <div className="conn-bar">
          <span className="dot dot--on" />
          <span className="conn-bar__port mono" title={portLabel}>
            {portLabel}
          </span>
          <span className="conn-bar__meta">
            {generic ? "通用串口" : "ESP-IDF"} · {baud} bps ·{" "}
            {resetOnOpen ? "打开时复位" : "不复位"} · {autoSave ? "自动保存" : "不保存"}
          </span>
          {autoSave && autoSaveHint && (
            <span className="field__hint mono" title={autoSavePath ?? logDir}>
              → {autoSaveHint}
            </span>
          )}
          <div className="toolbar__spacer" />
          <Button variant="ghost" size="small" onClick={() => setConfigOpen(true)}>
            <SlidersHorizontal size={14} />
            配置
          </Button>
        </div>
      )}

      {noData && (
        <div className="banner banner--warning">
          {generic ? (
            <>
              已连接，但 6 秒内没收到任何字节。先确认波特率对得上，再看 TX/RX 是否需要交叉；如果设备是
              “收到指令才回复”的，发一条命令再观察。
            </>
          ) : (
            <>
              已连接，但 6 秒内没收到任何数据。先确认「打开时复位设备」是勾上的（复位一次芯片才会
              重启输出）；如果还是不输出，给板子断电重上电，或改选 UART 桥对应的 COM 口。
            </>
          )}
        </div>
      )}

      {error && <div className="banner banner--error">{error}</div>}
      {notice && <div className="banner banner--info">{notice}</div>}

      <Card fill flush className="terminal-card">
        <div className="log-toolbar">
          <div className="toolbar__group">
            <input
              className="input"
              style={{ minWidth: 220 }}
              placeholder="在日志中查找关键字"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
                if (event.key === "Escape") closeSearch();
              }}
            />
            <Button variant="secondary" size="small" onClick={runSearch}>
              <Search size={14} />
              查找
            </Button>
            {hits.length > 0 && (
              <>
                <span className="field__hint mono">
                  {activeHit >= 0 ? activeHit + 1 : 0}/{hits.length}
                </span>
                <Button
                  variant="icon"
                  size="small"
                  aria-label="关闭查找结果"
                  onClick={closeSearch}
                >
                  <X size={15} />
                </Button>
              </>
            )}
          </div>

          <div className="toolbar__spacer" />

          {/* 显示选项：只影响渲染，不碰串口 */}
          <Switch checked={timestamp} onChange={setTimestamp} label="时间戳" />
          <Switch checked={hex} onChange={setHex} label="HEX" />
          <Switch checked={wrap} onChange={setWrap} label="自动换行" />
          <Button
            variant="icon"
            size="small"
            aria-label="日志颜色"
            title="日志颜色"
            onClick={() => setColorOpen(true)}
          >
            <Palette size={15} />
          </Button>
          <div className="toolbar__divider" />
          <Button variant="ghost" size="small" onClick={handleOpenDir}>
            <FolderOpen size={14} />
            日志目录
          </Button>
          <Button variant="ghost" size="small" onClick={handleSave} loading={busy}>
            <Save size={14} />
            保存日志
          </Button>
          <Button variant="ghost" size="small" onClick={handleClear}>
            <Trash2 size={14} />
            清空
          </Button>
        </div>

        <div className="log-layout">
          <LogTerminal
            lines={lines}
            version={version}
            query={activeQuery}
            activeIndex={activeHit >= 0 ? hits[activeHit].index : -1}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
            hex={hex}
            timestamp={timestamp}
            wrap={wrap}
            flatColor={flatColor}
            onClear={handleClear}
            onSaveRaw={handleSaveRaw}
          />
          {hits.length > 0 && (
            <SearchPanel
              query={activeQuery}
              hits={hits}
              active={activeHit}
              onPick={(position) => {
                setActiveHit(position);
                setAutoScroll(false);
              }}
              onClose={closeSearch}
            />
          )}
        </div>

        <div className="status-bar">
          <span className="status-bar__item">
            <span
              className={`dot${connected ? " dot--on" : conn.state === "error" ? " dot--err" : ""}`}
            />
            {connected ? `已连接 ${conn.port ?? ""}` : conn.state === "error" ? "连接异常" : backend.mock ? "未连接（模拟模式）" : "未连接"}
          </span>
          <span className="status-bar__item">
            行数 <span className="status-bar__value">{lines.length}/{MAX_LINES}</span>
          </span>
          <span className="status-bar__item">
            总计 <span className="status-bar__value">{formatSize(stats.bytes)}</span>
          </span>
          <span className="status-bar__item">
            速率 <span className="status-bar__value">{formatSize(stats.bytesPerSec)}/s</span>
          </span>
          <div className="status-bar__spacer" />
          <Switch checked={autoScroll} onChange={setAutoScroll} label="自动滚动" />
        </div>
      </Card>

      {colorOpen && (
        <ColorSettings
          fg={termFg}
          ts={termTs}
          flatColor={flatColor}
          onFgChange={setTermFg}
          onTsChange={setTermTs}
          onFlatColorChange={setFlatColor}
          onClose={() => setColorOpen(false)}
        />
      )}
    </PageShell>
  );
}
