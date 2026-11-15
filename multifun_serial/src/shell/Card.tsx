import type { ReactNode } from "react";

interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** 内容区去掉内边距并占满剩余高度，用于终端这类"填满卡片"的区域 */
  flush?: boolean;
  /** 卡片自身撑满父级高度 */
  fill?: boolean;
  className?: string;
}

/** 统一分区卡片：一个任务一张卡，禁止卡片套卡片。 */
export default function Card({
  title,
  subtitle,
  actions,
  children,
  flush = false,
  fill = false,
  className = "",
}: CardProps) {
  const showHeader = Boolean(title || subtitle || actions);
  const classes = ["card", fill ? "card--flush" : "", className].filter(Boolean).join(" ");

  return (
    <section className={classes}>
      {showHeader && (
        <header className="card__header">
          <div className="card__title-block">
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "card__body card__body--flush" : "card__body"}>{children}</div>
    </section>
  );
}
