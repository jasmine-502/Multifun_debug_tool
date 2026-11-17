import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Plug, Play, Square, Trash2, Unplug } from "lucide-react";
import Button from "../../shell/Button";
import Card from "../../shell/Card";
import PageShell from "../../shell/PageShell";
import Switch from "../../shell/Switch";
import { backend } from "../../lib/backend";
import type { Unlisten } from "../../lib/ipc";
import {
  COMM_MAX_ROWS,
  TCP_DEFAULT_HOST,
  TCP_DEFAULT_MAX_CLIENTS,
  TCP_DEFAULT_PORT,
  TCP_MAX_CLIENTS,
  UDP_DEFAULT_GROUP,
  UDP_DEFAULT_LOCAL_HOST,
  UDP_DEFAULT_PORT,
  UDP_DEFAULT_REMOTE_HOST,
  type CommFormat,
  type CommLinkState,
  type CommMode,
  type CommProtocol,
  type TcpChunk,
  type TcpPeerEvent,
  type TcpStatus,
  type UdpChunk,
  type UdpStatus,
} from "../../lib/types";
import {
  errText,
  formatSize,
  intervalOf,
  loadPrefs,
  portOf,
  pushHistory,
  restoreRows,
  savePrefs,
  stampOf,
  type CommEntry,
  type EntryLevel,
  type Prefs,
  type SendRow,
} from "./comm";

/** 醒目匹配：和 Qt 版一样按字面量切分，不区分大小写也不做正则 */
function renderHighlight(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && <mark className="comm-log__hit">{pattern}</mark>}
    </Fragment>
  ));
}

interface RowProps {
  entry: CommEntry;
  timestamp: boolean;
  hexView: boolean;
  highlight: string;
}

/**
 * 单行渲染。接收高频时每来一包都要 diff 整张表，
 * 用 memo 挡住未变化的行，2000 行上限下才不至于卡手。
 */
const CommLogRow = memo(function CommLogRow({ entry, timestamp, hexView, highlight }: RowProps) {
  const body = hexView && entry.hex ? entry.hex : entry.text;
  const line =
    entry.level === "tx"
      ? entry.peer
        ? `→ ${entry.peer} ${body}`
        : `→ ${body}`
      : entry.peer
        ? `来自 ${entry.peer}: ${body}`
        : body;
  return (
    <div className={`comm-log__row comm-log__row--${entry.level}`}>
      {timestamp && <span className="comm-log__ts">{stampOf(entry.ts)}</span>}
      <span className="comm-log__text">{renderHighlight(line, highlight)}</span>
    </div>
  );
});

export default function CommPage() {
  const prefs = useRef(loadPrefs()).current;

  /** 协议与模式：运行中禁用，切换协议前必须先停掉当前链路 */
  const [protocol, setProtocol] = useState<CommProtocol>(prefs.protocol === "udp" ? "udp" : "tcp");
  const [mode, setMode] = useState<CommMode>(prefs.mode === "server" ? "server" : "client");

  // TCP：客户端连服务器，服务端监听本机端口
  const [host, setHost] = useState(prefs.host ?? TCP_DEFAULT_HOST);
  const [port, setPort] = useState(prefs.port ?? TCP_DEFAULT_PORT);
  const [maxClients, setMaxClients] = useState(prefs.maxClients ?? TCP_DEFAULT_MAX_CLIENTS);
  const [hostHistory, setHostHistory] = useState<string[]>(prefs.hostHistory ?? []);
  const [portHistory, setPortHistory] = useState<string[]>(prefs.portHistory ?? []);
  /** 服务端在线客户端数：只有 accept / 断开事件能改变它 */
  const [clients, setClients] = useState(0);

  // UDP：先绑本地端口，客户端再发往远程地址
  const [localHost, setLocalHost] = useState(prefs.localHost ?? UDP_DEFAULT_LOCAL_HOST);
  const [localPort, setLocalPort] = useState(prefs.localPort ?? UDP_DEFAULT_PORT);
  const [localHostHistory, setLocalHostHistory] = useState<string[]>(
    prefs.localHostHistory ?? [],
  );
  const [localPortHistory, setLocalPortHistory] = useState<string[]>(
    prefs.localPortHistory ?? [],
  );
  const [remoteHost, setRemoteHost] = useState(prefs.remoteHost ?? UDP_DEFAULT_REMOTE_HOST);
  const [remotePort, setRemotePort] = useState(prefs.remotePort ?? UDP_DEFAULT_PORT);
  const [remoteHostHistory, setRemoteHostHistory] = useState<string[]>(
    prefs.remoteHostHistory ?? [],
  );
  const [remotePortHistory, setRemotePortHistory] = useState<string[]>(
    prefs.remotePortHistory ?? [],
  );
  const [broadcast, setBroadcast] = useState(prefs.broadcast ?? false);
  const [multicast, setMulticast] = useState(prefs.multicast ?? false);
  const [group, setGroup] = useState(prefs.group ?? UDP_DEFAULT_GROUP);

  // 两个协议共用
  const [rows, setRows] = useState<SendRow[]>(() => restoreRows(prefs.rows));
  const [link, setLink] = useState<CommLinkState>("idle");
  /** 已建立的端点：TCP 是服务器地址或监听地址，UDP 是实际绑定地址 */
  const [remote, setRemote] = useState<string | null>(null);
  const [entries, setEntries] = useState<CommEntry[]>([]);
  const [hexView, setHexView] = useState(prefs.hexView ?? false);
  const [timestamp, setTimestamp] = useState(prefs.timestamp ?? false);
  const [showRecv, setShowRecv] = useState(prefs.showRecv ?? true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [highlight, setHighlight] = useState(prefs.highlight ?? "");
  const [totalBytes, setTotalBytes] = useState(0);
  const [speed, setSpeed] = useState(0);

  const entrySeq = useRef(0);
  const totalRef = useRef(0);
  const viewRef = useRef<HTMLDivElement | null>(null);
  /** 一帧内的接收缓存：批量传输时一包一次 setState 会把渲染打爆 */
  const pendingRef = useRef<
    { ts: number; text: string; hex: string; from: string | null }[]
  >([]);
  const rafRef = useRef<number | null>(null);
  /** 主动停止的标记：状态事件晚到时不能重复记一条「连接已断开」 */
  const closingRef = useRef(false);
  const linkRef = useRef(link);
  const rowsRef = useRef(rows);
  const showRecvRef = useRef(showRecv);
  /** 每行下一次自动发送的时间戳（performance.now） */
  const dueRef = useRef<number[]>([]);
  const sendRowRef = useRef<(index: number, auto?: boolean) => void>(() => {});

  useEffect(() => {
    linkRef.current = link;
  }, [link]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    showRecvRef.current = showRecv;
  }, [showRecv]);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    const batch: CommEntry[] = pending.map((item) => {
      entrySeq.current += 1;
      return {
        id: entrySeq.current,
        ts: item.ts,
        level: "rx",
        text: item.text,
        hex: item.hex,
        peer: item.from ?? undefined,
      };
    });
    setEntries((prev) => {
      const merged = prev.concat(batch);
      // 满了从头丢，始终保留最新一屏（与 Qt 版 max_recv_lines 的效果一致）
      return merged.length > COMM_MAX_ROWS ? merged.slice(merged.length - COMM_MAX_ROWS) : merged;
    });
  }, []);

  const pushEntry = useCallback(
    (level: EntryLevel, text: string, hex?: string, peer?: string) => {
      // 先把攒着的接收数据刷出去，本地提示（连接/发送/错误）才能排在正确的时序上
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        flushPending();
      }
      entrySeq.current += 1;
      const entry: CommEntry = { id: entrySeq.current, ts: Date.now(), level, text, hex, peer };
      setEntries((prev) => {
        if (prev.length < COMM_MAX_ROWS) return [...prev, entry];
        // 满了从头丢，始终保留最新一屏（与 Qt 版 max_recv_lines 的效果一致）
        return [...prev.slice(prev.length - COMM_MAX_ROWS + 1), entry];
      });
    },
    [flushPending],
  );

  /** TCP 与 UDP 的接收都归到一处：字段形状相同，只有 from 的取值来源不同 */
  const ingest = useCallback(
    (item: { ts: number; len: number; text: string; hex: string; from: string | null }) => {
      totalRef.current += item.len;
      // 「显示接收」关掉时只停回显，字节统计照常累加（Qt 版会把统计一起停掉）
      if (!showRecvRef.current) return;
      const pending = pendingRef.current;
      pending.push({ ts: item.ts, text: item.text, hex: item.hex, from: item.from });
      // 窗口不可见时 rAF 会被节流，给缓存一个硬上限，宁可丢旧数据也不能吃内存
      if (pending.length > COMM_MAX_ROWS * 2) {
        pending.splice(0, pending.length - COMM_MAX_ROWS);
      }
      if (rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(flushPending);
      }
    },
    [flushPending],
  );

  const handleTcpChunk = useCallback((chunk: TcpChunk) => ingest(chunk), [ingest]);

  const handleUdpChunk = useCallback((chunk: UdpChunk) => ingest(chunk), [ingest]);

  const handleTcpStatus = useCallback(
    (status: TcpStatus) => {
      if (status.state === "open") {
        setRemote(status.remote);
        // 不清 clients：服务端可能在命令返回前就已经接了客户端，
        // 清零交给启动前的 setClients(0)，否则会把先到的接入事件盖掉
        setLink("open");
        return;
      }

      // 断开后目标地址已经无意义，地址栏留给用户改成下一个服务器
      setRemote(null);
      setClients(0);
      if (status.state === "closed") {
        setLink("idle");
        pushEntry("warn", status.message ?? "连接已断开");
      } else {
        setLink("error");
        pushEntry("error", status.message ?? "连接异常");
      }

      // 对端关闭 / 读线程出错：后端会话里只剩一个已经退出的线程，顺手收掉
      if (!closingRef.current) {
        void backend.tcpDisconnect().catch(() => undefined);
      }
    },
    [pushEntry],
  );

  /** 服务端客户端接入 / 断开：日志用与 Qt 版同样的口吻，状态栏只记数量 */
  const handleTcpPeer = useCallback(
    (event: TcpPeerEvent) => {
      setClients(event.count);
      if (event.kind === "connected") {
        pushEntry("info", `客户端连接: ${event.peer}`);
      } else if (event.kind === "disconnected") {
        pushEntry("warn", `客户端断开: ${event.peer}`);
      } else {
        pushEntry("error", `已达最大连接数（${event.count}），拒绝 ${event.peer}`);
      }
    },
    [pushEntry],
  );

  const handleUdpStatus = useCallback(
    (status: UdpStatus) => {
      if (status.state === "open") {
        setRemote(status.local);
        setLink("open");
        return;
      }

      // 读线程出错（例如网卡被停用）：socket 已经不可用，界面不能停在运行中
      setRemote(null);
      setLink("error");
      pushEntry("error", status.message ?? "UDP 接收异常");
      void backend.udpStop().catch(() => undefined);
    },
    [pushEntry],
  );

  useEffect(() => {
    const offs: Unlisten[] = [];
    let disposed = false;
    const track = (task: Promise<Unlisten>) => {
      void task.then((off) => {
        if (disposed) off();
        else offs.push(off);
      });
    };
    track(backend.onTcpData(handleTcpChunk));
    track(backend.onTcpStatus(handleTcpStatus));
    track(backend.onTcpPeer(handleTcpPeer));
    track(backend.onUdpData(handleUdpChunk));
    track(backend.onUdpStatus(handleUdpStatus));
    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [handleTcpChunk, handleTcpStatus, handleTcpPeer, handleUdpChunk, handleUdpStatus]);

  // 每秒结算一次速率：Qt 版也是独立定时器，不跟着收包刷新
  useEffect(() => {
    let last = totalRef.current;
    const timer = window.setInterval(() => {
      setSpeed(totalRef.current - last);
      last = totalRef.current;
      setTotalBytes(totalRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 卸载时把没刷出去的接收缓存取消掉，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = [];
    },
    [],
  );

  useEffect(() => {
    const element = viewRef.current;
    if (!element || !autoScroll) return;
    element.scrollTop = element.scrollHeight;
  }, [entries, autoScroll, showRecv]);

  useEffect(() => {
    const payload: Prefs = {
      protocol,
      mode,
      host,
      port,
      maxClients,
      hostHistory,
      portHistory,
      localHost,
      localPort,
      localHostHistory,
      localPortHistory,
      remoteHost,
      remotePort,
      remoteHostHistory,
      remotePortHistory,
      broadcast,
      multicast,
      group,
      rows,
      hexView,
      timestamp,
      showRecv,
      highlight,
    };
    savePrefs(payload);
  }, [
    protocol,
    mode,
    host,
    port,
    maxClients,
    hostHistory,
    portHistory,
    localHost,
    localPort,
    localHostHistory,
    localPortHistory,
    remoteHost,
    remotePort,
    remoteHostHistory,
    remotePortHistory,
    broadcast,
    multicast,
    group,
    rows,
    hexView,
    timestamp,
    showRecv,
    highlight,
  ]);

  /** 最大连接数：空值/非法值当 1，再多也只是把 accept 队列塞满 */
  const clampClients = (raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return 1;
    return Math.min(TCP_MAX_CLIENTS, value);
  };

  const startTcpClient = async () => {
    const target = host.trim();
    const portNumber = Number(port);
    if (!target || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      pushEntry("error", "请输入有效的服务器地址与端口");
      return;
    }

    setLink("starting");
    pushEntry("info", `正在连接到 ${target}:${portNumber} …`);
    try {
      const addr = await backend.tcpConnect(target, portNumber);
      setRemote(addr);
      setLink("open");
      setHostHistory((prev) => pushHistory(target, prev));
      setPortHistory((prev) => pushHistory(String(portNumber), prev));
      pushEntry("info", `已连接 ${addr}`);
    } catch (err) {
      setRemote(null);
      setLink("error");
      pushEntry("error", errText(err));
    }
  };

  /** TCP 服务端：监听本机端口，客户端接入后才能广播发送 */
  const startTcpServer = async () => {
    const target = host.trim();
    const portNumber = Number(port);
    if (!target || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      pushEntry("error", "请输入有效的监听地址与端口");
      return;
    }

    setLink("starting");
    setClients(0);
    pushEntry("info", `正在监听 ${target}:${portNumber} …`);
    try {
      const local = await backend.tcpListen(target, portNumber, clampClients(maxClients));
      setRemote(local);
      setLink("open");
      setHostHistory((prev) => pushHistory(target, prev));
      setPortHistory((prev) => pushHistory(String(portNumber), prev));
      pushEntry("info", `服务端已启动，正在监听 ${local}`);
    } catch (err) {
      setRemote(null);
      setLink("error");
      pushEntry("error", errText(err));
    }
  };

  const startUdp = async () => {
    const bindHost = localHost.trim();
    const portNumber = Number(localPort);
    if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
      pushEntry("error", "请输入有效的本地端口（0 表示由系统分配）");
      return;
    }
    if (mode === "client" && !remoteHost.trim()) {
      pushEntry("error", "客户端模式需要填写远程地址");
      return;
    }
    if (multicast && !group.trim()) {
      pushEntry("error", "请输入组播地址");
      return;
    }

    setLink("starting");
    pushEntry("info", `正在绑定 ${bindHost || "0.0.0.0"}:${portNumber} …`);
    try {
      const bound = await backend.udpStart(
        bindHost,
        portNumber,
        broadcast,
        multicast,
        group.trim(),
      );
      setRemote(bound);
      setLink("open");
      setLocalHostHistory((prev) => pushHistory(localHost, prev));
      setLocalPortHistory((prev) => pushHistory(localPort, prev));
      // 与 Qt 版一致：只有客户端模式才把远程目标记进历史
      if (mode === "client") {
        setRemoteHostHistory((prev) => pushHistory(remoteHost, prev));
        setRemotePortHistory((prev) => pushHistory(remotePort, prev));
      }
      pushEntry("info", `UDP ${mode === "client" ? "客户端" : "服务端"}已启动：${bound}`);
    } catch (err) {
      setRemote(null);
      setLink("error");
      pushEntry("error", errText(err));
    }
  };

  const start = () => {
    if (protocol === "udp") return startUdp();
    return mode === "server" ? startTcpServer() : startTcpClient();
  };

  const stop = async () => {
    if (protocol === "udp") {
      try {
        await backend.udpStop();
      } catch (err) {
        pushEntry("error", errText(err));
      }
    } else {
      closingRef.current = true;
      try {
        await backend.tcpDisconnect();
      } catch (err) {
        pushEntry("error", errText(err));
      } finally {
        closingRef.current = false;
      }
    }
    setLink("idle");
    setRemote(null);
    setClients(0);
    pushEntry(
      "info",
      protocol === "udp"
        ? "UDP 已停止"
        : mode === "server"
          ? "服务端已停止"
          : "连接已断开",
    );
  };

  const handleToggle = () => {
    if (link === "open") {
      void stop();
      return;
    }
    // 连接/启动中不提供取消：阻塞中的 connect 在 Windows 上中断不干净，最多只等 2 秒
    if (link === "starting") return;
    void start();
  };

  /** 切协议/模式只能在未运行时发生（下拉在运行中禁用），顺手清掉上一个链路的残留 */
  const changeProtocol = (next: CommProtocol) => {
    setProtocol(next);
    setClients(0);
    setRemote(null);
    setLink("idle");
  };

  const changeMode = (next: CommMode) => {
    setMode(next);
    setClients(0);
    setRemote(null);
    setLink("idle");
  };

  /**
   * UDP 发送目标：
   * - 组播发到组地址（收发在同一组端口上，服务端用实际绑定的端口）；
   * - 服务端模式把 host 留空，由后端回给最近一次收到报文的来源；
   * - 其余情况就是界面上填的远程地址。
   */
  const udpTargetOf = (): { host: string; port: number } => {
    if (multicast) {
      return {
        host: group.trim(),
        port: mode === "client" ? Number(remotePort) : (portOf(remote) ?? Number(localPort)),
      };
    }
    if (mode === "server") return { host: "", port: 0 };
    return { host: remoteHost.trim(), port: Number(remotePort) };
  };

  const stopAuto = (index: number) => {
    setRows((prev) => prev.map((item, i) => (i === index ? { ...item, auto: false } : item)));
  };

  const sendRow = async (index: number, auto = false) => {
    const row = rowsRef.current[index];
    if (!row) return;
    if (linkRef.current !== "open") {
      if (!auto) pushEntry("error", protocol === "udp" ? "UDP 未启动，无法发送" : "未连接，无法发送");
      return;
    }
    if (!row.data.trim()) {
      pushEntry("error", `第 ${index + 1} 行没有内容可发送`);
      if (auto) stopAuto(index);
      return;
    }

    try {
      if (protocol === "udp") {
        const target = udpTargetOf();
        if (multicast && !target.host) {
          pushEntry("error", "请输入组播地址");
          if (auto) stopAuto(index);
          return;
        }
        // host 为空是服务端模式的回复，端口由后端从来源地址里取
        if (
          target.host !== "" &&
          (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
        ) {
          pushEntry("error", multicast ? "组播端口无效（1-65535）" : "远程端口无效（1-65535）");
          if (auto) stopAuto(index);
          return;
        }
        const sent = await backend.udpSend(
          row.data,
          row.format === "hex",
          target.host,
          target.port,
        );
        if (showRecvRef.current) {
          pushEntry(
            "tx",
            row.format === "hex" ? sent.hex : sent.text,
            sent.hex,
            sent.to || undefined,
          );
        }
        return;
      }

      const sent = await backend.tcpSend(row.data, row.format === "hex");
      if (showRecvRef.current) {
        pushEntry(
          "tx",
          row.format === "hex" ? sent.hex : sent.text,
          sent.hex,
          mode === "server" ? `${sent.targets} 个客户端` : undefined,
        );
      }
    } catch (err) {
      pushEntry("error", errText(err));
      // 自动发送失败一次就停，否则每秒刷一条同样的错误
      if (auto) stopAuto(index);
    }
  };

  useEffect(() => {
    sendRowRef.current = (index, auto) => {
      void sendRow(index, auto);
    };
  });

  const autoActive = useMemo(() => rows.some((row) => row.auto), [rows]);

  // 50ms 滴答 + 每行各自的到期时间：
  // 改另一行的内容不会把正在跑的自动发送整体重置，只有勾选/停止才会
  useEffect(() => {
    if (link !== "open" || !autoActive) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      rowsRef.current.forEach((row, index) => {
        if (!row.auto) return;
        const due = dueRef.current[index];
        if (due !== undefined && now < due) return;
        dueRef.current[index] = now + intervalOf(row.interval);
        sendRowRef.current(index, true);
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [link, autoActive]);

  const toggleAuto = (index: number, checked: boolean) => {
    setRows((prev) => prev.map((item, i) => (i === index ? { ...item, auto: checked } : item)));
    if (checked) {
      // 勾上后等一个完整间隔再发第一包，与 Qt 版 QTimer.start(ms) 一致
      dueRef.current[index] = performance.now() + intervalOf(rows[index].interval);
    }
  };

  const updateRow = (index: number, patch: Partial<SendRow>) => {
    // 不动 dueRef：改间隔只影响下一拍的间隔，避免敲字过程中（例如刚敲下 "1"）
    // 把正在等待的自动发送提前到 10ms
    setRows((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  /** 广播与组播互斥：两者同时勾没有任何额外语义 */
  const toggleBroadcast = (checked: boolean) => {
    setBroadcast(checked);
    if (!checked) return;
    setMulticast(false);
    // 目标还是本机回环时，用户勾「广播」多半就是想把包发到广播地址去
    setRemoteHost((prev) =>
      prev.trim() === "" || prev.trim() === UDP_DEFAULT_REMOTE_HOST ? "255.255.255.255" : prev,
    );
  };

  const toggleMulticast = (checked: boolean) => {
    setMulticast(checked);
    if (checked) setBroadcast(false);
  };

  const handleScroll = () => {
    const element = viewRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  const clearEntries = () => {
    // 连攒在帧缓存里的接收数据一起丢掉，否则清空后马上又冒出一批
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current = [];
    setEntries([]);
    setAutoScroll(true);
  };

  const isTcp = protocol === "tcp";
  const isTcpClient = isTcp && mode === "client";
  const running = link === "open";
  const locked = link === "starting" || running;

  const busyText = isTcpClient ? "连接中…" : "启动中…";
  const idleText = isTcpClient ? "未连接" : "未启动";
  const linkText =
    link === "starting"
      ? busyText
      : link === "open"
        ? (remote ?? (isTcpClient ? "已连接" : isTcp ? "监听中" : "运行中"))
        : link === "error"
          ? isTcpClient
            ? "连接失败"
            : "启动失败"
          : idleText;
  const hint = isTcpClient ? "连接超时 2 秒" : isTcp ? "0.0.0.0 监听所有网卡" : "本地端口填 0 由系统分配";
  const sendSubtitle =
    isTcp && mode === "server" ? "广播给所有在线客户端" : "每行独立设置格式与间隔";
  const emptyText = running
    ? isTcp
      ? mode === "server"
        ? "正在监听，等待客户端接入…"
        : "已连接，等待数据…"
      : "已启动，等待数据…"
    : idleText;

  return (
    <PageShell
      title="TCP/UDP 通信"
      subtitle="TCP 连接服务器或监听端口，UDP 绑定本地端口收发数据报；两个协议共用一个终端，接收区保留最近 2000 行"
      fill
      className="page-shell--focus"
    >
      {backend.mock && (
        <div className="banner banner--warning">
          浏览器模拟模式：连接、监听与收发都是假数据（TCP 客户端原样回显，TCP 服务端会模拟客户端接入，UDP
          也回显并模拟来源地址）。端口填 1 可以预览连接超时 / 端口占用。要连真实设备请用
          <span className="mono"> npm run dev </span>启动 Tauri 版本。
        </div>
      )}

      <Card title="连接">
        <div className="comm-config">
          <div className="comm-config__row">
            <div className="toolbar__group">
              <span className="field__label">协议</span>
              <select
                className="select comm-config__proto"
                value={protocol}
                disabled={locked}
                onChange={(event) => changeProtocol(event.target.value === "udp" ? "udp" : "tcp")}
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </div>

            <div className="toolbar__group">
              <span className="field__label">工作模式</span>
              <select
                className="select comm-config__mode"
                value={mode}
                disabled={locked}
                onChange={(event) =>
                  changeMode(event.target.value === "server" ? "server" : "client")
                }
              >
                <option value="client">客户端</option>
                <option value="server">服务端</option>
              </select>
            </div>

            <Button
              variant={running ? "secondary" : "primary"}
              loading={link === "starting"}
              loadingLabel={busyText}
              onClick={handleToggle}
            >
              {running ? (
                isTcpClient ? (
                  <>
                    <Unplug size={14} />
                    断开
                  </>
                ) : (
                  <>
                    <Square size={14} />
                    停止
                  </>
                )
              ) : isTcpClient ? (
                <>
                  <Plug size={14} />
                  连接
                </>
              ) : (
                <>
                  <Play size={14} />
                  启动
                </>
              )}
            </Button>

            <span className={`comm-link comm-link--${link}`}>
              <span
                className={`dot${running ? " dot--on" : link === "error" ? " dot--err" : ""}`}
              />
              {linkText}
            </span>
            <span className="field__hint">{hint}</span>
          </div>

          {isTcp ? (
            <div className="comm-config__row">
              <div className="toolbar__group">
                <span className="field__label">
                  {mode === "server" ? "监听地址" : "服务器地址"}
                </span>
                <input
                  className="input input--mono comm-config__host"
                  list="comm-tcp-host"
                  value={host}
                  disabled={locked}
                  placeholder={mode === "server" ? "0.0.0.0 监听所有网卡" : "127.0.0.1 或域名"}
                  onChange={(event) => setHost(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleToggle();
                  }}
                />
                <datalist id="comm-tcp-host">
                  {hostHistory.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </div>

              <div className="toolbar__group">
                <span className="field__label">端口</span>
                <input
                  className="input input--mono comm-config__port"
                  list="comm-tcp-port"
                  inputMode="numeric"
                  value={port}
                  disabled={locked}
                  onChange={(event) => setPort(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleToggle();
                  }}
                />
                <datalist id="comm-tcp-port">
                  {portHistory.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </div>

              {mode === "server" && (
                <div className="toolbar__group">
                  <span className="field__label">最大连接</span>
                  <input
                    className="input input--mono comm-config__max"
                    type="number"
                    min={1}
                    max={TCP_MAX_CLIENTS}
                    value={maxClients}
                    disabled={locked}
                    onChange={(event) => setMaxClients(event.target.value)}
                  />
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="comm-config__row">
                <div className="toolbar__group">
                  <span className="field__label">本地地址</span>
                  <input
                    className="input input--mono comm-config__host"
                    list="comm-udp-local-host"
                    value={localHost}
                    disabled={locked}
                    placeholder="0.0.0.0"
                    onChange={(event) => setLocalHost(event.target.value)}
                  />
                  <datalist id="comm-udp-local-host">
                    {localHostHistory.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </div>

                <div className="toolbar__group">
                  <span className="field__label">本地端口</span>
                  <input
                    className="input input--mono comm-config__port"
                    list="comm-udp-local-port"
                    inputMode="numeric"
                    value={localPort}
                    disabled={locked}
                    onChange={(event) => setLocalPort(event.target.value)}
                  />
                  <datalist id="comm-udp-local-port">
                    {localPortHistory.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </div>

                {mode === "client" ? (
                  <>
                    <div className="toolbar__group">
                      <span className="field__label">远程地址</span>
                      <input
                        className="input input--mono comm-config__host"
                        list="comm-udp-remote-host"
                        value={remoteHost}
                        disabled={locked}
                        placeholder="127.0.0.1 或域名"
                        onChange={(event) => setRemoteHost(event.target.value)}
                      />
                      <datalist id="comm-udp-remote-host">
                        {remoteHostHistory.map((item) => (
                          <option key={item} value={item} />
                        ))}
                      </datalist>
                    </div>

                    <div className="toolbar__group">
                      <span className="field__label">远程端口</span>
                      <input
                        className="input input--mono comm-config__port"
                        list="comm-udp-remote-port"
                        inputMode="numeric"
                        value={remotePort}
                        disabled={locked}
                        onChange={(event) => setRemotePort(event.target.value)}
                      />
                      <datalist id="comm-udp-remote-port">
                        {remotePortHistory.map((item) => (
                          <option key={item} value={item} />
                        ))}
                      </datalist>
                    </div>
                  </>
                ) : (
                  <span className="field__hint">服务端模式：发送给最近一次收到报文的来源</span>
                )}
              </div>

              <div className="comm-config__row">
                <Switch checked={broadcast} onChange={toggleBroadcast} label="广播" />
                <Switch checked={multicast} onChange={toggleMulticast} label="组播" />
                <div className="toolbar__group">
                  <span className="field__label">组播地址</span>
                  <input
                    className="input input--mono comm-config__group"
                    value={group}
                    disabled={locked || !multicast}
                    placeholder="224.1.1.1"
                    onChange={(event) => setGroup(event.target.value)}
                  />
                </div>
                <span className="field__hint">
                  {multicast
                    ? "发送目标 = 组地址 : 远程端口（服务端用本地端口）"
                    : "广播目标通常是 255.255.255.255"}
                </span>
              </div>
            </>
          )}
        </div>
      </Card>

      <div className="comm-main">
        <Card title="发送" subtitle={sendSubtitle} className="comm-send">
          <div className="comm-send__rows">
            {rows.map((row, index) => (
              <div className="comm-send__row" key={index}>
                <div className="comm-send__line">
                  <span className="comm-send__no">[{index + 1}]</span>
                  <input
                    className="input input--mono comm-send__data"
                    placeholder={row.format === "hex" ? "AA 55 0D 0A" : "要发送的文本"}
                    value={row.data}
                    onChange={(event) => updateRow(index, { data: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void sendRow(index);
                    }}
                  />
                </div>
                <div className="comm-send__line">
                  <span className="comm-send__caption">间隔</span>
                  <input
                    className="input input--mono comm-send__interval"
                    type="number"
                    min={10}
                    step={100}
                    value={row.interval}
                    onChange={(event) => updateRow(index, { interval: event.target.value })}
                  />
                  <span className="comm-send__caption">ms</span>
                  <select
                    className="select comm-send__format"
                    value={row.format}
                    onChange={(event) =>
                      updateRow(index, { format: event.target.value as CommFormat })
                    }
                  >
                    <option value="ascii">ASCII</option>
                    <option value="hex">HEX</option>
                  </select>
                  <Switch
                    checked={row.auto}
                    onChange={(checked) => toggleAuto(index, checked)}
                    label="自动"
                  />
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={!running}
                    onClick={() => void sendRow(index)}
                  >
                    发送
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card fill flush className="terminal-card comm-terminal">
          <div className="log-toolbar">
            <div className="toolbar__group">
              <span className="field__label">醒目</span>
              <input
                className="input comm-highlight"
                placeholder="匹配内容"
                value={highlight}
                onChange={(event) => setHighlight(event.target.value)}
              />
            </div>
            <div className="toolbar__spacer" />
            {!showRecv && <span className="field__hint">接收已隐藏，统计仍在累计</span>}
            <Switch checked={showRecv} onChange={setShowRecv} label="显示接收" />
            <Switch checked={timestamp} onChange={setTimestamp} label="时间戳" />
            <Switch checked={hexView} onChange={setHexView} label="HEX" />
            <Button variant="ghost" size="small" onClick={clearEntries}>
              <Trash2 size={14} />
              清空
            </Button>
          </div>

          <div className="log-layout">
            <div className="comm-log" ref={viewRef} onScroll={handleScroll}>
              {entries.length === 0 ? (
                <p className="comm-log__empty">{emptyText}</p>
              ) : (
                entries.map((entry) => (
                  <CommLogRow
                    key={entry.id}
                    entry={entry}
                    timestamp={timestamp}
                    hexView={hexView}
                    highlight={highlight}
                  />
                ))
              )}
            </div>
          </div>

          <div className="status-bar">
            <span className="status-bar__item">
              <span
                className={`dot${running ? " dot--on" : link === "error" ? " dot--err" : ""}`}
              />
              {linkText}
            </span>
            <span className="status-bar__item">
              行数{" "}
              <span className="status-bar__value">
                {entries.length}/{COMM_MAX_ROWS}
              </span>
            </span>
            {isTcp && mode === "server" && (
              <span className="status-bar__item">
                客户端 <span className="status-bar__value">{clients}</span>
              </span>
            )}
            <span className="status-bar__item">
              总计 <span className="status-bar__value">{formatSize(totalBytes)}</span>
            </span>
            <span className="status-bar__item">
              速率 <span className="status-bar__value">{formatSize(speed)}/s</span>
            </span>
            <div className="status-bar__spacer" />
            <Switch checked={autoScroll} onChange={setAutoScroll} label="自动滚动" />
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
