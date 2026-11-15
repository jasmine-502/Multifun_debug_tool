import { useEffect, useState } from "react";
import {
  Layers,
  Moon,
  Network,
  Radio,
  Sun,
  Terminal,
  Waves,
  Zap,
} from "lucide-react";
import EspLogPage from "./features/esp-log/EspLogPage";
import { backend } from "./lib/backend";

type ViewId = "esp-log" | "tcp" | "udp" | "flash" | "merge";

interface NavItem {
  id: ViewId;
  label: string;
  icon: typeof Radio;
  ready: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "esp-log", label: "ESP32 日志", icon: Radio, ready: true },
  { id: "tcp", label: "TCP 客户端", icon: Network, ready: false },
  { id: "udp", label: "UDP 通信", icon: Waves, ready: false },
  { id: "flash", label: "ESP32 烧录", icon: Zap, ready: false },
  { id: "merge", label: "固件合并", icon: Layers, ready: false },
];

const THEME_KEY = "esp-log-console.theme";

function Placeholder({ label }: { label: string }) {
  return (
    <div className="placeholder">
      <span className="placeholder__icon">
        <Terminal size={22} />
      </span>
      <h2 className="placeholder__title">{label}</h2>
      <p className="placeholder__text">
        该页面本轮不迁移，Qt 版 `debug_tool` 仍是它的唯一实现。
        这里先占位，等 ESP32 日志页稳定后再按同一套令牌逐个补齐。
      </p>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<ViewId>("esp-log");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const current = NAV_ITEMS.find((item) => item.id === view) ?? NAV_ITEMS[0];

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__mark" aria-hidden="true">
            <Terminal size={18} />
          </span>
          <span className="sidebar__brand-text">
            <span className="sidebar__brand-name">Multifun Serial</span>
            <span className="sidebar__brand-version">v0.1.0 · tauri</span>
          </span>
        </div>

        <div className="sidebar__nav">
          <div className="sidebar__section">工作区</div>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.id === view;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => setView(item.id)}
              >
                <Icon size={16} />
                <span>{item.label}</span>
                {!item.ready && <span className="nav-item__badge">待迁移</span>}
              </button>
            );
          })}
        </div>

        <div className="sidebar__spacer" />

        <div className="sidebar__footer">
          {backend.mock && (
            <span className="nav-item__badge" title="当前运行在浏览器中，日志为模拟数据">
              模拟数据
            </span>
          )}
          <button
            type="button"
            className="nav-item"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
            <span>{theme === "dark" ? "深色主题" : "浅色主题"}</span>
          </button>
        </div>
      </nav>

      <main className="workspace">
        {/* 常驻挂载：切页时不能卸载，否则连接状态、滚动位置和缓冲区都会丢 */}
        <div className="view-host" style={{ display: view === "esp-log" ? undefined : "none" }}>
          <EspLogPage />
        </div>
        {view !== "esp-log" && <Placeholder label={current.label} />}
      </main>
    </div>
  );
}
