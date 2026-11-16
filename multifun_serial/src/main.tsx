import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import tauriConfig from "../src-tauri/tauri.conf.json";
import "./styles/tokens.css";
import "./styles/app.css";

// 浏览器预览（npm run dev:web）没有 Tauri 窗口，标签页标题在这里补版本号；
// 桌面窗口的标题由 Rust 侧 setup 设置，两边读的是同一个 tauri.conf.json
document.title = `Multifun Serial 串口工具 v${tauriConfig.version}`;

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
