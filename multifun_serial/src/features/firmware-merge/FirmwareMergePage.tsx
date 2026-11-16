import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import Button from "../../shell/Button";
import Card from "../../shell/Card";
import PageShell from "../../shell/PageShell";
import Switch from "../../shell/Switch";
import { backend } from "../../lib/backend";
import type { FwEntry, FwLogLevel, FwMergeEntryInput } from "../../lib/types";

/**
 * 固件合并页：对齐 Qt 版 `app/firmware_merge_tab.py`。
 * 扫描、解析、合并全部在 Rust 侧完成，这里只负责编排状态与展示。
 */

const PREFS_KEY = "multifun-serial.firmware.prefs.v1";
/** 日志只保留最近若干行，长时间反复扫描不会把页面拖慢 */
const MAX_LOGS = 500;

interface Prefs {
  rootDir?: string;
  outputDir?: string;
  addDate?: boolean;
  addVersion?: boolean;
  addProject?: boolean;
}

const loadPrefs = (): Prefs => {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch {
    return {};
  }
};

interface Row {
  id: number;
  offset: string;
  path: string;
  /** 扫描时是相对 build 的路径，手选时是文件名 */
  name: string;
  size: number;
}

interface FwLine {
  id: number;
  ts: string;
  text: string;
  level: FwLogLevel;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `YYYYMMDD_HHMMSS`，与旧版 `get_datetime_sec_str()` 一致 */
const stampName = (date = new Date()): string =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_` +
  `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;

/** 日志时间前缀 `HH:MM:SS` */
const clockStamp = (date = new Date()): string =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

/** `YYYY-MM-DD HH:MM:SS`，给「扫描于」用：只显示时分秒分不清是哪天的快照 */
const fullStamp = (date = new Date()): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface NameOptions {
  project: boolean;
  version: boolean;
  date: boolean;
}

/**
 * `merged_firmware[-项目名][-V版本][-时间].bin`。
 * 预览用 `X.Y.Z` 占位，真正合并时用 `unknown`，与旧版 `_update_output_name_preview`
 * / `_get_output_filename` 的差别保持一致。
 */
const makeFilename = (
  options: NameOptions,
  projectName: string | null,
  version: string | null,
  live: boolean,
): string => {
  const parts = ["merged_firmware"];
  if (options.project) parts.push(projectName ?? "project");
  if (options.version) parts.push(`V${version ?? (live ? "unknown" : "X.Y.Z")}`);
  if (options.date) parts.push(stampName());
  return `${parts.join("-")}.bin`;
};

interface FirmwareMergePageProps {
  /** 页面常驻挂载，切走时只隐藏：拖放监听要靠它判断是否该接管事件 */
  active: boolean;
}

export default function FirmwareMergePage({ active }: FirmwareMergePageProps) {
  const prefs = useRef(loadPrefs()).current;

  const [rootDir, setRootDir] = useState(prefs.rootDir ?? "");
  const [outputDir, setOutputDir] = useState(prefs.outputDir ?? "");
  const [addDate, setAddDate] = useState(prefs.addDate ?? true);
  const [addVersion, setAddVersion] = useState(prefs.addVersion ?? true);
  const [addProject, setAddProject] = useState(prefs.addProject ?? false);

  const [buildDir, setBuildDir] = useState("");
  /** 上一次扫描完成的时刻；扫描失败时保留旧值，因为表里的还是旧快照 */
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [chip, setChip] = useState("未知");
  const [flashSize, setFlashSize] = useState("未知");
  const [flashFreq, setFlashFreq] = useState("未知");
  const [version, setVersion] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);

  const rowSeq = useRef(0);
  const logSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  /** 恢复上次目录后的首次扫描只做一次，之后由用户显式触发 */
  const autoScanned = useRef(false);

  const nextRowId = (): number => {
    rowSeq.current += 1;
    return rowSeq.current;
  };

  const makeRow = (offset: string, path: string, name: string, size = 0): Row => ({
    id: nextRowId(),
    offset,
    path,
    name,
    size,
  });

  const [rows, setRows] = useState<Row[]>(() => [makeRow("0x0", "", "")]);
  const [logs, setLogs] = useState<FwLine[]>([]);
  const [scanning, setScanning] = useState(false);
  const [merging, setMerging] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const appendLog = useCallback((text: string, level: FwLogLevel = "info") => {
    logSeq.current += 1;
    const line: FwLine = { id: logSeq.current, ts: clockStamp(), text, level };
    setLogs((prev) =>
      prev.length >= MAX_LOGS ? [...prev.slice(prev.length - MAX_LOGS + 1), line] : [...prev, line],
    );
  }, []);

  const patchRow = (id: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  /* ---------------- 扫描 ---------------- */

  const handleScan = useCallback(
    async (dir: string) => {
      const root = dir.trim();
      if (root === "") {
        appendLog("请先选择项目目录", "error");
        return;
      }
      setScanning(true);
      try {
        const result = await backend.scanFirmware(root);
        setBuildDir(result.buildDir);
        setChip(result.chip);
        setFlashSize(result.flashSize);
        setFlashFreq(result.flashFreq);
        setVersion(result.version);
        setProjectName(result.projectName);
        setRows(
          result.entries.map((entry: FwEntry) =>
            makeRow(entry.offset, entry.path, entry.name, entry.size),
          ),
        );
        // 每次扫描都重开一段日志，和旧版清表后重新记录的行为一致
        setLogs([]);
        logSeq.current = 0;
        result.logs.forEach((line) => appendLog(line.text, line.level));
        setScannedAt(fullStamp());
      } catch (error) {
        appendLog(`扫描失败: ${errorText(error)}`, "error");
        appendLog("请确认选中的是 ESP-IDF 项目根目录，且已经编译生成 build 目录", "warn");
      } finally {
        setScanning(false);
      }
    },
    [appendLog],
  );

  const handleDropPath = useCallback(
    (path: string) => {
      setRootDir(path);
      appendLog(`已拖入目录: ${path}`);
      void handleScan(path);
    },
    [appendLog, handleScan],
  );

  const handleBrowseRoot = async () => {
    const picked = await backend.chooseDirectory("选择项目根目录");
    if (!picked) return;
    setRootDir(picked);
    void handleScan(picked);
  };

  const handleBrowseOutput = async () => {
    const picked = await backend.chooseDirectory("选择输出目录");
    if (picked) setOutputDir(picked);
  };

  /* ---------------- 列表操作 ---------------- */

  const handlePickFile = async (row: Row) => {
    const picked = await backend.chooseBinFile();
    if (!picked) return;
    patchRow(row.id, { path: picked, name: basename(picked) });
  };

  const handleAddRow = () => setRows((prev) => [...prev, makeRow("", "", "")]);

  const handleClearRows = () => {
    setRows([]);
    // 表清空了，扫描快照也随之作废，留着时间会误导
    setScannedAt(null);
    appendLog("已清空 Bin 列表");
  };

  /* ---------------- 合并 ---------------- */

  const handleMerge = async () => {
    const usable: FwMergeEntryInput[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const path = row.path.trim();
      const offset = row.offset.trim();
      // 与旧版一致：偏移或文件留空的行直接跳过，不算错误；偏移是否合法交给 Rust 判
      if (path === "" || offset === "") {
        const label = row.name || (path === "" ? "空行" : basename(path));
        skipped.push(`${label}（${path === "" ? "未选文件" : "缺偏移"}）`);
        continue;
      }
      usable.push({ offset, path });
    }

    if (usable.length === 0) {
      appendLog("没有有效的合并项：偏移地址和文件都不能为空", "error");
      return;
    }
    if (skipped.length > 0) {
      // 点名是哪几行：只写「跳过 1 行」会让人以为额外文件也进去了
      appendLog(
        `已跳过 ${skipped.length} 个未填完整的条目：${skipped.join("、")}`,
        "warn",
      );
    }

    const filename = makeFilename(
      { project: addProject, version: addVersion, date: addDate },
      projectName,
      version,
      true,
    );
    appendLog(`开始合并，共 ${usable.length} 个文件`);
    appendLog(
      `文件名包含: 项目名=${addProject ? "是" : "否"}, 版本号=${addVersion ? "是" : "否"}, ` +
        `日期=${addDate ? "是" : "否"}`,
    );

    setMerging(true);
    try {
      const result = await backend.mergeFirmware(
        usable,
        rootDir.trim(),
        outputDir.trim(),
        filename,
      );
      appendLog(`合并成功！文件已保存到: ${result.output}`, "ok");
      appendLog(
        `文件大小: ${result.size.toLocaleString()} bytes (${(result.size / 1024 / 1024).toFixed(2)} MB)，` +
          `共合并 ${result.count} 个条目` +
          (skipped.length > 0 ? `（另有 ${skipped.length} 个缺偏移的未参与）` : ""),
        "ok",
      );
      result.overlaps.forEach((text) => appendLog(text, "warn"));
    } catch (error) {
      appendLog(`合并失败: ${errorText(error)}`, "error");
    } finally {
      setMerging(false);
    }
  };

  /* ---------------- 副作用 ---------------- */

  // 配置持久化：与 Qt 版的 get_config / load_config 对应
  useEffect(() => {
    try {
      window.localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ rootDir, outputDir, addDate, addVersion, addProject }),
      );
    } catch {
      /* 隐私模式下写不进去，不影响使用 */
    }
  }, [rootDir, outputDir, addDate, addVersion, addProject]);

  // 首次进入页面时，如果恢复出了上次的目录就直接扫描一遍
  useEffect(() => {
    if (!active || autoScanned.current) return;
    autoScanned.current = true;
    if (rootDir.trim() !== "") void handleScan(rootDir.trim());
  }, [active, rootDir, handleScan]);

  // 拖放目录：Tauri 的拖放事件是全局的，必须用 active 门控，避免和日志页串扰
  useEffect(() => {
    if (!active || backend.mock) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDragOver(true);
          } else if (payload.type === "drop") {
            setDragOver(false);
            const first = payload.paths[0];
            if (first) handleDropPath(first);
          } else {
            setDragOver(false);
          }
        });
        if (cancelled) unlisten();
        else stop = unlisten;
      } catch {
        /* 浏览器或旧运行时不支持拖放，静默降级为手动选择 */
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [active, handleDropPath]);

  // 日志只增不减，始终贴底
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  const previewName = useMemo(
    () =>
      makeFilename({ project: addProject, version: addVersion, date: addDate }, projectName, version, false),
    [addDate, addVersion, addProject, projectName, version],
  );

  return (
    <PageShell
      title="固件合并"
      subtitle="扫描 ESP-IDF build 目录，按偏移地址把多个 bin 拼成一整片，从 0x0 一次烧录。"
      actions={
        <Button variant="primary" onClick={handleMerge} loading={merging}>
          <Play size={15} />
          合并固件
        </Button>
      }
    >
      <Card title="合并配置" subtitle="选择项目根目录后会自动扫描 build 目录，也可以直接把它拖进窗口">
        <div className={`fw-drop${dragOver ? " is-over" : ""}`}>
          {dragOver
            ? "松开鼠标：把该目录填入项目根目录并立即扫描"
            : "把 ESP-IDF 项目目录拖进窗口即可自动填入并扫描"}
        </div>

        <div className="fw-config">
          <div className="fw-row">
            <span className="fw-row__label">项目根目录</span>
            <div className="fw-row__controls">
              <input
                className="input input--mono input--grow"
                placeholder="选择或拖放 ESP-IDF 项目目录，也可直接选 build 目录"
                value={rootDir}
                onChange={(event) => setRootDir(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleScan(rootDir);
                }}
              />
              <Button variant="secondary" size="small" onClick={handleBrowseRoot}>
                <FolderOpen size={14} />
                浏览
              </Button>
              <Button
                variant="secondary"
                size="small"
                onClick={() => void handleScan(rootDir)}
                loading={scanning}
              >
                <RefreshCw size={14} />
                扫描
              </Button>
            </div>
          </div>

          {buildDir !== "" && (
            <p className="fw-note mono" title={buildDir}>
              扫描目录：{buildDir}
            </p>
          )}

          <div className="fw-row">
            <span className="fw-row__label">输出目录</span>
            <div className="fw-row__controls">
              <input
                className="input input--mono input--grow"
                placeholder="留空则保存到项目根目录"
                value={outputDir}
                onChange={(event) => setOutputDir(event.target.value)}
              />
              <Button variant="secondary" size="small" onClick={handleBrowseOutput}>
                <FolderOpen size={14} />
                浏览
              </Button>
            </div>
          </div>

          <div className="fw-row">
            <span className="fw-row__label">文件名格式</span>
            <div className="fw-row__controls">
              <Switch checked={addDate} onChange={setAddDate} label="添加日期时间" />
              <Switch checked={addVersion} onChange={setAddVersion} label="添加版本号" />
              <Switch checked={addProject} onChange={setAddProject} label="添加项目名称" />
            </div>
          </div>

          <div className="fw-row">
            <span className="fw-row__label">文件名预览</span>
            <div className="fw-row__controls">
              <span className="fw-preview">{previewName}</span>
              <span className="field__hint">时间戳在合并那一刻生成</span>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Bin 文件列表"
        subtitle="按偏移地址升序合并，后写的覆盖先写的；偏移或文件留空的行会被跳过"
        actions={
          <>
            {scannedAt && (
              <span className="fw-scanned mono" title="表格是这次扫描得到的快照">
                扫描于 {scannedAt}
              </span>
            )}
            <Button variant="ghost" size="small" onClick={handleAddRow}>
              <Plus size={14} />
              添加行
            </Button>
            <Button variant="ghost" size="small" onClick={handleClearRows} disabled={rows.length === 0}>
              <Trash2 size={14} />
              清空列表
            </Button>
          </>
        }
      >
        <div className="fw-table-wrap">
          <table className="fw-table">
            <thead>
              <tr>
                <th className="fw-table__col-offset">偏移地址</th>
                <th>Bin 文件</th>
                <th className="fw-table__col-size">大小</th>
                <th className="fw-table__col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="fw-empty" colSpan={4}>
                    列表为空：先扫描项目，或点「添加行」手动指定偏移与文件
                  </td>
                </tr>
              ) : (
                rows.map((row, index) => (
                  <tr key={row.id}>
                    <td>
                      <input
                        className="input input--mono fw-offset"
                        placeholder="0x10000"
                        aria-label={`第 ${index + 1} 行偏移地址`}
                        value={row.offset}
                        onChange={(event) => patchRow(row.id, { offset: event.target.value })}
                      />
                    </td>
                    <td>
                      <div className="fw-file">
                        <span className="fw-file__name" title={row.path}>
                          {row.name || (row.path ? basename(row.path) : "未选择文件")}
                        </span>
                        {row.path !== "" && row.offset.trim() === "" && (
                          <span className="fw-file__tag">待填偏移</span>
                        )}
                        <span className="fw-file__path mono" title={row.path}>
                          {row.path === "" ? "" : row.path}
                        </span>
                        <Button
                          variant="icon"
                          size="small"
                          title="选择 Bin 文件"
                          aria-label="选择 Bin 文件"
                          onClick={() => void handlePickFile(row)}
                        >
                          <FolderOpen size={14} />
                        </Button>
                      </div>
                    </td>
                    <td className="fw-size">{formatBytes(row.size)}</td>
                    <td>
                      <div className="fw-actions">
                        <Button
                          variant="icon"
                          size="small"
                          title="删除这一行"
                          aria-label={`删除第 ${index + 1} 行`}
                          onClick={() => setRows((prev) => prev.filter((item) => item.id !== row.id))}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="fw-info">
          <span className="fw-info__item">
            芯片 <span className="fw-info__value">{chip}</span>
          </span>
          <span className="fw-info__item">
            Flash <span className="fw-info__value">{flashSize}</span>
          </span>
          <span className="fw-info__item">
            频率 <span className="fw-info__value">{flashFreq}</span>
          </span>
          {version && (
            <span className="fw-info__item">
              版本 <span className="fw-info__value">V{version}</span>
            </span>
          )}
          <span className="fw-info__item">
            条目 <span className="fw-info__value">{rows.length}</span>
          </span>
        </div>
      </Card>

      <Card
        title="执行日志"
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
        <div className="fw-log" ref={logRef} role="log">
          {logs.length === 0 ? (
            <p className="fw-log__empty">扫描和合并的操作记录会出现在这里。</p>
          ) : (
            logs.map((line) => (
              <div key={line.id} className={`fw-log__row fw-log--${line.level}`}>
                <span className="fw-log__ts">[{line.ts}]</span>
                <span className="fw-log__text">{line.text}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </PageShell>
  );
}
