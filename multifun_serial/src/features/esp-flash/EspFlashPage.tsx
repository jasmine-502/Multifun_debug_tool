import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Eraser, FolderOpen, Play, RefreshCw, Trash2 } from "lucide-react";
import Button from "../../shell/Button";
import Card from "../../shell/Card";
import PageShell from "../../shell/PageShell";
import Switch from "../../shell/Switch";
import { backend } from "../../lib/backend";
import {
  FLASH_BAUD_RATES,
  FLASH_CHIPS,
  type ChipInfo,
  type FlashEntryInput,
  type FlashLogLevel,
  type FlashLogLine,
  type PortInfo,
} from "../../lib/types";

/**
 * ESP32 烧录页：对齐 Qt 版 `app/esp32_flash_tab.py`。
 * 烧录、擦除、检测全部在 Rust 侧通过 espflash 直连串口完成，
 * 这里只负责参数编排、进度条与日志展示。
 */

const PREFS_KEY = "multifun-serial.flash.prefs.v1";
/** 与旧版一致：固定 4 行任务，第一行默认勾选 */
const ROW_COUNT = 4;
/** 日志只保留最近若干行，反复重试不会把页面拖慢 */
const MAX_LOGS = 500;
const DEFAULT_BAUD = 460800;

/**
 * 连接失败时补一行提示：后端已经自己试过各种复位方式、切速失败会降速，
 * stub 没跑起来还会退回 ROM 模式重试，剩下的只能是硬件侧的动作。
 */
const CONNECT_HINT =
  "已自动尝试各种复位方式、切速失败自动降速、stub 失败自动改用 ROM 模式：仍失败请按住 BOOT 再点一次，或把波特率改成 115200";

const EMPTY_INFO: ChipInfo = {
  chip: "—",
  crystal: "—",
  usb: "—",
  mac: "—",
  flashSize: "—",
  flashMode: "—",
  flashId: "—",
  flashVoltage: "—",
  features: "—",
};

/** 芯片信息卡的字段顺序，与旧版网格一致 */
const CHIP_FIELDS: Array<{ key: Exclude<keyof ChipInfo, "features">; label: string }> = [
  { key: "chip", label: "芯片型号" },
  { key: "crystal", label: "晶振频率" },
  { key: "usb", label: "USB 模式" },
  { key: "mac", label: "MAC 地址" },
  { key: "flashSize", label: "Flash 容量" },
  { key: "flashMode", label: "Flash 模式" },
  { key: "flashId", label: "厂商/器件 ID" },
  { key: "flashVoltage", label: "Flash 电压" },
];

interface TaskRow {
  checked: boolean;
  addr: string;
  path: string;
}

interface FlashPrefs {
  port?: string;
  baud?: number;
  chip?: string;
  rows?: TaskRow[];
}

interface LogRow extends FlashLogLine {
  id: number;
  ts: string;
}

type Phase = "flash" | "erase" | "detect" | null;

type StatusTone = "idle" | "busy" | "ok" | "error";

const loadPrefs = (): FlashPrefs => {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as FlashPrefs) : {};
  } catch {
    return {};
  }
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 日志时间前缀 `HH:MM:SS`，与旧版 LogView 一致 */
const clockStamp = (date = new Date()): string =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

/** 写入速度：串口也就几十到几百 KB/s，用 KB/s 为主单位最好读 */
const formatSpeed = (bytesPerSec: number): string => {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 端口显示成 `COM7 - CP2102 USB to UART Bridge`，没有描述时只留端口名 */
const portLabel = (info: PortInfo): string =>
  info.description ? `${info.port} - ${info.description}` : info.port;

export default function EspFlashPage() {
  const prefs = useRef(loadPrefs()).current;

  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState(prefs.port ?? "");
  const [baud, setBaud] = useState(prefs.baud ?? DEFAULT_BAUD);
  const [chip, setChip] = useState(prefs.chip ?? "auto");

  const [rows, setRows] = useState<TaskRow[]>(() => {
    const saved = prefs.rows ?? [];
    return Array.from({ length: ROW_COUNT }, (_, index) => {
      const item = saved[index];
      const path = item?.path ?? "";
      return {
        checked: item?.checked ?? index === 0,
        // 只有确实选过 bin 的行才沿用旧地址，空行统一回到默认 0x0
        addr: item?.addr && path ? item.addr : "0x0",
        path,
      };
    });
  });

  const [status, setStatus] = useState<{ text: string; tone: StatusTone }>({
    text: "就绪",
    tone: "idle",
  });
  const [progress, setProgress] = useState(0);
  // 后端随进度推的平均写入速度（字节/秒），0 表示还没开始写
  const [speed, setSpeed] = useState(0);
  const [phase, setPhase] = useState<Phase>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [info, setInfo] = useState<ChipInfo>(EMPTY_INFO);
  const [infoHint, setInfoHint] = useState("点击「检测芯片」读取芯片与 Flash 信息");

  const [logs, setLogs] = useState<LogRow[]>(() =>
    backend.mock
      ? [
          {
            id: 0,
            ts: clockStamp(),
            text: "浏览器模拟模式：烧录、擦除与检测都返回假数据，不会真正打开串口",
            level: "warn",
          },
        ]
      : [],
  );

  const logSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  /** 烧录期间不刷新端口列表，避免把正被本页占用的口从下拉里抹掉 */
  const phaseRef = useRef<Phase>(null);
  /** 端口事件每 500ms 广播一次，签名没变就不落状态，避免整页重渲染 */
  const portsSig = useRef("");

  const busy = phase !== null;

  const appendLog = useCallback((text: string, level: FlashLogLevel = "info") => {
    logSeq.current += 1;
    const line: LogRow = { id: logSeq.current, ts: clockStamp(), text, level };
    setLogs((prev) =>
      prev.length >= MAX_LOGS ? [...prev.slice(prev.length - MAX_LOGS + 1), line] : [...prev, line],
    );
  }, []);

  const applyPorts = useCallback((list: PortInfo[]) => {
    setPorts(list);
    // 选中的端口还在就保留；原生 USB 复位瞬间列表可能短暂为空，这时不要丢掉选择
    setPort((prev) => {
      if (prev && (list.length === 0 || list.some((item) => item.port === prev))) return prev;
      return list[0]?.port ?? "";
    });
  }, []);

  const refreshPorts = useCallback(
    async (quiet = false) => {
      if (phaseRef.current !== null) return;
      if (!quiet) setRefreshing(true);
      try {
        const list = await backend.listPorts();
        portsSig.current = list.map((item) => item.port).join("|");
        applyPorts(list);
      } catch (error) {
        if (!quiet) appendLog(`刷新串口失败: ${errorText(error)}`, "error");
      } finally {
        if (!quiet) setRefreshing(false);
      }
    },
    [appendLog, applyPorts],
  );

  /* ---------------- 事件订阅 ---------------- */

  useEffect(() => {
    let cancelled = false;
    const stops: Array<() => void> = [];
    void (async () => {
      try {
        const listeners = await Promise.all([
          backend.onFlashLog((line) => appendLog(line.text, line.level)),
          backend.onFlashProgress((payload) => {
            setProgress(payload.percent);
            setSpeed(payload.bytesPerSec);
          }),
          backend.onPorts((list) => {
            if (phaseRef.current !== null) return;
            const signature = list.map((item) => item.port).join("|");
            if (signature === portsSig.current) return;
            portsSig.current = signature;
            applyPorts(list);
          }),
        ]);
        if (cancelled) listeners.forEach((stop) => stop());
        else stops.push(...listeners);
      } catch (error) {
        appendLog(`订阅设备事件失败: ${errorText(error)}`, "error");
      }
    })();
    void refreshPorts();
    return () => {
      cancelled = true;
      stops.forEach((stop) => stop());
    };
  }, [appendLog, applyPorts, refreshPorts]);

  // 配置持久化：与旧版的 get_config / load_config 对应
  useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ port, baud, chip, rows }));
    } catch {
      /* 隐私模式下写不进去，不影响使用 */
    }
  }, [port, baud, chip, rows]);

  // 日志只增不减，始终贴底
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  /* ---------------- 行操作 ---------------- */

  const patchRow = (index: number, patch: Partial<TaskRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const handleBrowse = async (index: number) => {
    const picked = await backend.chooseBinFile();
    if (!picked) return;
    patchRow(index, { path: picked });
    appendLog(`第 ${index + 1} 行已选择: ${picked}`);
  };

  /* ---------------- 烧录 / 擦除 / 检测 ---------------- */

  const finishPhase = () => {
    phaseRef.current = null;
    setPhase(null);
    void refreshPorts(true);
  };

  const handleFlash = async () => {
    if (phaseRef.current !== null) return;
    if (port === "") {
      setStatus({ text: "未选择串口", tone: "error" });
      appendLog("请先选择串口", "error");
      return;
    }

    // 只收勾选的行；行号用表格里的真实行号，报错文案才对得上用户看到的那一行
    const entries: FlashEntryInput[] = [];
    rows.forEach((row, index) => {
      if (row.checked) entries.push({ row: index + 1, addr: row.addr, path: row.path });
    });
    if (entries.length === 0) {
      setStatus({ text: "请至少选择一个烧录任务", tone: "error" });
      appendLog("请至少选择一个烧录任务", "error");
      return;
    }

    phaseRef.current = "flash";
    setPhase("flash");
    setProgress(0);
    setSpeed(0);
    setStatus({ text: "烧录中…", tone: "busy" });
    try {
      const report = await backend.espFlash(port, baud, chip, entries);
      setProgress(100);
      setStatus({ text: "烧录完成", tone: "ok" });
      // 后端已按结构化日志推送过明细与平均速度，这里只补一行回执口径的大小
      appendLog(
        `本次共写入 ${formatBytes(report.bytes)}，实际芯片 ${report.chip}`,
        "ok",
      );
    } catch (error) {
      setStatus({ text: "烧录失败", tone: "error" });
      appendLog(errorText(error), "error");
      appendLog(CONNECT_HINT, "warn");
    } finally {
      finishPhase();
    }
  };

  const handleErase = async () => {
    if (phaseRef.current !== null) return;
    if (port === "") {
      setStatus({ text: "未选择串口", tone: "error" });
      appendLog("请先选择串口", "error");
      return;
    }
    const agreed = await backend.confirmErase();
    if (!agreed) return;

    phaseRef.current = "erase";
    setPhase("erase");
    setProgress(0);
    setSpeed(0);
    setStatus({ text: "擦除中…", tone: "busy" });
    try {
      await backend.espErase(port, baud, chip);
      setProgress(100);
      setStatus({ text: "擦除完成", tone: "ok" });
    } catch (error) {
      setStatus({ text: "擦除失败", tone: "error" });
      appendLog(errorText(error), "error");
      appendLog(
        "若已经连上并开始擦除，芯片里可能已有部分区域被清空，重新烧录一次即可恢复；进入不了 stub 模式时则什么都没改动。直接烧录本身会按扇区自动擦除，不必先整片擦",
        "warn",
      );
    } finally {
      finishPhase();
    }
  };

  const handleDetect = async () => {
    if (phaseRef.current !== null) return;
    if (port === "") {
      setStatus({ text: "未选择串口", tone: "error" });
      appendLog("请先选择串口", "error");
      return;
    }

    phaseRef.current = "detect";
    setPhase("detect");
    setStatus({ text: "检测中…", tone: "busy" });
    setInfoHint("正在读取芯片与 Flash 信息…");
    try {
      const result = await backend.espDetect(port, baud, chip);
      setInfo(result);
      const filled = Object.values(result).filter(
        (value) => value !== "" && value !== "—",
      ).length;
      setInfoHint(
        filled > 0
          ? `检测成功，共读取 ${filled} 项信息`
          : "未读取到芯片信息，请确认端口与芯片型号",
      );
      setStatus({ text: "检测完成", tone: "ok" });
    } catch (error) {
      setInfoHint("检测失败，请检查串口后重试");
      setStatus({ text: "检测失败", tone: "error" });
      appendLog(errorText(error), "error");
      appendLog(CONNECT_HINT, "warn");
    } finally {
      finishPhase();
    }
  };

  return (
    <PageShell
      title="ESP32 烧录"
      subtitle="直接驱动串口完成烧录、擦除与芯片检测，结束后自动复位，不依赖外部 esptool。"
      actions={
        <>
          <Button
            variant="secondary"
            onClick={() => void handleErase()}
            loading={phase === "erase"}
            disabled={busy || port === ""}
            title="擦除整片 Flash"
          >
            <Eraser size={15} />
            擦除 Flash
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleFlash()}
            loading={phase === "flash"}
            disabled={busy || port === ""}
            title="烧录勾选的固件文件"
          >
            <Play size={15} />
            开始烧录
          </Button>
        </>
      }
    >
      <Card title="串口设置" subtitle="烧录时独占端口，结束后自动释放；握手固定 115200，连上后再切到所选档位">
        <div className="fx-config">
          <div className="fx-row">
            <span className="fx-row__label">端口号</span>
            <div className="fx-row__controls">
              <select
                className="select"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                disabled={busy}
                aria-label="烧录串口"
              >
                {ports.length === 0 && <option value="">未发现串口</option>}
                {ports.map((item) => (
                  <option key={item.port} value={item.port}>
                    {portLabel(item)}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                size="small"
                onClick={() => void refreshPorts()}
                loading={refreshing}
                disabled={busy}
              >
                <RefreshCw size={14} />
                刷新
              </Button>
              <span className={`fx-status fx-status--${status.tone}`} role="status">
                {status.text}
              </span>
            </div>
          </div>

          <div className="fx-row">
            <span className="fx-row__label">通信参数</span>
            <div className="fx-row__controls">
              <span className="fx-inline-label">波特率</span>
              <select
                className="select fx-select--narrow"
                value={String(baud)}
                onChange={(event) => setBaud(Number(event.target.value))}
                disabled={busy}
                aria-label="烧录波特率"
              >
                {FLASH_BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}
                  </option>
                ))}
              </select>
              <span className="fx-inline-label">芯片型号</span>
              <select
                className="select fx-select--narrow"
                value={chip}
                onChange={(event) => setChip(event.target.value)}
                disabled={busy}
                aria-label="目标芯片型号"
              >
                {FLASH_CHIPS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="field__hint">不确定型号时用「自动检测」</span>
            </div>
          </div>
        </div>
      </Card>

      <Card title="下载内容" subtitle="勾选要写入的行；地址一律按十六进制解释，0x10000 与 10000 等价">
        <div className="fx-tasks">
          {rows.map((row, index) => (
            <div key={index} className={`fx-task${row.checked ? " is-on" : ""}`}>
              <Switch
                checked={row.checked}
                onChange={(checked) => patchRow(index, { checked })}
                ariaLabel={`第 ${index + 1} 行参与烧录`}
              />
              <span className="fx-task__no">{index + 1}</span>
              <span className="fx-inline-label">烧录地址</span>
              <input
                className="input input--mono fx-task__addr"
                value={row.addr}
                placeholder="0x0"
                aria-label={`第 ${index + 1} 行烧录地址`}
                onChange={(event) => patchRow(index, { addr: event.target.value })}
                disabled={busy}
              />
              <span className="fx-inline-label">Bin 文件</span>
              <input
                className="input input--mono input--grow fx-task__path"
                value={row.path}
                placeholder="选择 bin 文件路径"
                title={row.path}
                aria-label={`第 ${index + 1} 行 Bin 文件`}
                onChange={(event) => patchRow(index, { path: event.target.value })}
                disabled={busy}
              />
              <Button
                variant="icon"
                size="small"
                title="选择 Bin 文件"
                aria-label={`选择第 ${index + 1} 行的 Bin 文件`}
                onClick={() => void handleBrowse(index)}
                disabled={busy}
              >
                <FolderOpen size={14} />
              </Button>
            </div>
          ))}
        </div>

        <div className="fx-progress">
          <span className="fx-progress__label">进度</span>
          <div
            className="fx-progress__track"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="fx-progress__fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="fx-progress__value">{progress}%</span>
          {speed > 0 && (
            <span className="fx-progress__speed mono" title="从开始写入到现在的平均速度">
              {formatSpeed(speed)}
            </span>
          )}
        </div>
      </Card>

      <Card
        title="芯片信息"
        subtitle={infoHint}
        actions={
          <Button
            variant="secondary"
            size="small"
            onClick={() => void handleDetect()}
            loading={phase === "detect"}
            disabled={busy || port === ""}
          >
            <Cpu size={14} />
            检测芯片
          </Button>
        }
      >
        <div className="fx-chips">
          {CHIP_FIELDS.map(({ key, label }) => (
            <div className="fx-chip-field" key={key}>
              <span className="fx-chip-field__label">{label}</span>
              <span className="fx-chip-field__value mono" title={info[key]}>
                {info[key]}
              </span>
            </div>
          ))}
          <div className="fx-chip-field fx-chip-field--wide">
            <span className="fx-chip-field__label">功能特性</span>
            <span className="fx-chip-field__value mono">{info.features}</span>
          </div>
        </div>
      </Card>

      <Card
        title="操作日志"
        actions={
          <Button
            variant="ghost"
            size="small"
            onClick={() => setLogs([])}
            disabled={logs.length === 0}
          >
            <Trash2 size={14} />
            清空
          </Button>
        }
      >
        <div className="fx-log" ref={logRef} role="log">
          {logs.length === 0 ? (
            <p className="fx-log__empty">烧录、擦除与检测的过程会出现在这里。</p>
          ) : (
            logs.map((line) => (
              <div key={line.id} className={`fx-log__row fx-log--${line.level}`}>
                <span className="fx-log__ts">[{line.ts}]</span>
                <span className="fx-log__text">{line.text}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </PageShell>
  );
}
