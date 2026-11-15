import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 官方建议：固定端口 + 不清屏 + 关闭自动打开浏览器
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    // 必须忽略 Rust 产物：cargo 编译时 target/ 里的文件被独占，
    // Vite 的 watcher 碰到会直接 EBUSY 崩溃
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome105",
    sourcemap: false,
  },
});
