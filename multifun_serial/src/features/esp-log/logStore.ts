/**
 * 日志缓冲：环形数组 + rAF 合并通知。
 * 关键约束：一次批量 append 只触发一次 React 重渲染，DOM 由 LogTerminal 做窗口化渲染。
 */

import type { LogLine } from "../../lib/types";

export const MAX_LINES = 20000;

class LogStore {
  private lines: LogLine[] = [];
  private version = 0;
  private listeners = new Set<() => void>();
  private frame: number | null = null;
  private truncated = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this.version;

  getLines = (): LogLine[] => this.lines;

  getTruncated = (): number => this.truncated;

  append = (batch: LogLine[]): void => {
    if (batch.length === 0) return;
    for (const line of batch) this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      const drop = this.lines.length - MAX_LINES;
      this.lines.splice(0, drop);
      this.truncated += drop;
    }
    this.schedule();
  };

  appendMany = (batches: LogLine[][]): void => {
    let touched = false;
    for (const batch of batches) {
      for (const line of batch) this.lines.push(line);
      touched = touched || batch.length > 0;
    }
    if (this.lines.length > MAX_LINES) {
      const drop = this.lines.length - MAX_LINES;
      this.lines.splice(0, drop);
      this.truncated += drop;
    }
    if (touched) this.schedule();
  };

  clear = (): void => {
    this.lines = [];
    this.truncated = 0;
    this.version += 1;
    this.emitNow();
  };

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.version += 1;
      this.listeners.forEach((listener) => listener());
    });
  }

  private emitNow(): void {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.listeners.forEach((listener) => listener());
  }
}

export const logStore = new LogStore();
