import type { ReactNode } from "react";

interface PageShellProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** 让页面撑满可用高度（终端类页面需要） */
  fill?: boolean;
  /** 额外的状态修饰类，例如连接后收紧留白 */
  className?: string;
}

/** 页面骨架：一个明确标题 + 一句说明 + 不超过两个右侧动作。 */
export default function PageShell({
  title,
  subtitle,
  actions,
  children,
  fill = false,
  className,
}: PageShellProps) {
  const classes = ["page-shell", fill ? "page-shell--fill" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <header className="page-shell__header">
        <div className="page-shell__title-block">
          <h1 className="page-shell__title">{title}</h1>
          {subtitle && <p className="page-shell__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-shell__actions">{actions}</div>}
      </header>
      <div className="page-shell__body">{children}</div>
    </div>
  );
}
