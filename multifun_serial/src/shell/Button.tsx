import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "icon";
type Size = "small" | "medium" | "large";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  loadingLabel?: string;
  children?: ReactNode;
}

const VARIANTS: Variant[] = ["primary", "secondary", "ghost", "danger", "icon"];
const SIZES: Size[] = ["small", "medium", "large"];

/**
 * 统一按钮原语：primary 一页只允许一个；loading 时保留原宽度并阻止重复提交。
 */
export default function Button({
  variant = "secondary",
  size = "medium",
  loading = false,
  loadingLabel = "处理中…",
  disabled = false,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const resolvedVariant = VARIANTS.includes(variant) ? variant : "secondary";
  const resolvedSize = SIZES.includes(size) ? size : "medium";
  const classes = [
    "button",
    `button--${resolvedVariant}`,
    `button--${resolvedSize}`,
    loading ? "is-loading" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      <span className="button__content" aria-hidden={loading || undefined}>
        {children}
      </span>
      {loading && (
        <span className="button__loading">
          <span className="button__spinner" aria-hidden="true" />
          {loadingLabel}
        </span>
      )}
    </button>
  );
}
