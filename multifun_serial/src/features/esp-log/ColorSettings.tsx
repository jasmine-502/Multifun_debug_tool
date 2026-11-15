import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import Button from "../../shell/Button";
import Switch from "../../shell/Switch";

/** 与 tokens.css 的 `--term-fg` / `--term-ts` 初始值保持一致 */
export const DEFAULT_TERM_FG = "#cccccc";
export const DEFAULT_TERM_TS = "#666666";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface ColorFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  onReset: () => void;
}

/**
 * 取色器 + 十六进制输入。
 * 输入框允许中途只敲出 `#12` 这种半成品，只有凑满 6 位才提交，
 * 否则每敲一个字符就把非法值写进 CSS 变量，页面会闪一下。
 */
function ColorField({ label, value, onCommit, onReset }: ColorFieldProps) {
  const [text, setText] = useState(value);

  // 取色器或「默认」改了值，输入框要跟着回显
  useEffect(() => setText(value), [value]);

  return (
    <div className="color-row">
      <span className="color-row__label">{label}</span>
      <input
        type="color"
        className="color-row__picker"
        value={value}
        aria-label={`${label}取色器`}
        onChange={(event) => onCommit(event.target.value.toUpperCase())}
      />
      <input
        className="input input--mono color-row__hex"
        value={text}
        spellCheck={false}
        aria-label={`${label}色值`}
        onChange={(event) => {
          const raw = event.target.value.trim();
          const next = raw.startsWith("#") ? raw : `#${raw}`;
          setText(next);
          if (HEX_RE.test(next)) onCommit(next.toUpperCase());
        }}
        // 没输完就失焦：回滚成当前生效的值，别留一个非法字符串在框里
        onBlur={() => setText(value)}
      />
      <Button variant="ghost" size="small" onClick={onReset}>
        默认
      </Button>
    </div>
  );
}

interface ColorSettingsProps {
  fg: string;
  ts: string;
  flatColor: boolean;
  onFgChange: (value: string) => void;
  onTsChange: (value: string) => void;
  onFlatColorChange: (value: boolean) => void;
  onClose: () => void;
}

/**
 * 日志颜色设置：直接改 :root 上的 `--term-fg` / `--term-ts`，
 * 所以改一个字符终端就变，不需要「应用」按钮。点遮罩、Esc、完成都只是关窗。
 */
export default function ColorSettings({
  fg,
  ts,
  flatColor,
  onFgChange,
  onTsChange,
  onFlatColorChange,
  onClose,
}: ColorSettingsProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-mask" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="日志颜色设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-panel__head">
          <span className="modal-panel__title">日志颜色</span>
          <Button variant="icon" size="small" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </Button>
        </div>

        <p className="modal-panel__hint">
          只影响屏幕显示，不改自动保存到文件的字节内容。
        </p>

        <div className="color-row-group">
          <ColorField
            label="时间戳"
            value={ts}
            onCommit={onTsChange}
            onReset={() => onTsChange(DEFAULT_TERM_TS)}
          />
          <ColorField
            label="正文"
            value={fg}
            onCommit={onFgChange}
            onReset={() => onFgChange(DEFAULT_TERM_FG)}
          />
        </div>

        <Switch
          checked={flatColor}
          onChange={onFlatColorChange}
          label="统一正文颜色（忽略 Error / Info 等各级别色）"
        />

        <div className="color-preview">
          <div className="color-preview__row">
            <span style={{ color: ts }}>12:34:56.789 </span>
            <span style={{ color: fg }}>01 03 00 86 00 02 25 E2</span>
          </div>
          <div className="color-preview__row">
            <span style={{ color: ts }}>12:34:56.812 </span>
            <span style={{ color: flatColor ? fg : "var(--lv-info)" }}>
              I (1234) app: ready
            </span>
          </div>
          <div className="color-preview__row">
            <span style={{ color: ts }}>12:34:56.845 </span>
            <span style={{ color: flatColor ? fg : "var(--lv-warning)" }}>
              W (1301) wifi: retry
            </span>
          </div>
        </div>

        <div className="modal-panel__foot">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              onFgChange(DEFAULT_TERM_FG);
              onTsChange(DEFAULT_TERM_TS);
            }}
          >
            <RotateCcw size={14} />
            恢复默认配色
          </Button>
          <Button variant="primary" size="small" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </div>
  );
}
