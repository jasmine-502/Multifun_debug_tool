import { LOG_LEVELS, type LevelFilter, type LogLevel } from "../../lib/types";

const CHIP_CLASS: Record<string, string> = {
  Error: "chip--error",
  Warning: "chip--warning",
  Info: "chip--info",
  Debug: "chip--debug",
  Verbose: "chip--verbose",
};

interface LevelChipsProps {
  value: LevelFilter;
  onToggle: (level: LogLevel) => void;
  disabled?: boolean;
}

/** 日志级别过滤：用 chip 替代 Qt 版的一排 QCheckBox，点击即时生效。 */
export default function LevelChips({ value, onToggle, disabled = false }: LevelChipsProps) {
  return (
    <div className="chips" role="group" aria-label="日志级别过滤">
      {LOG_LEVELS.map((level) => {
        const on = value[level] !== false;
        return (
          <button
            key={level}
            type="button"
            className={`chip ${CHIP_CLASS[level] ?? ""}${on ? " is-on" : ""}`}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(level)}
          >
            <span className="chip__dot" aria-hidden="true" />
            {level}
          </button>
        );
      })}
    </div>
  );
}
