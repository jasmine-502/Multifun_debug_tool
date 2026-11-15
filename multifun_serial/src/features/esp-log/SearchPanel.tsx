import { X } from "lucide-react";
import Button from "../../shell/Button";

export interface SearchHit {
  index: number;
  lineText: string;
}

interface SearchPanelProps {
  query: string;
  hits: SearchHit[];
  active: number;
  onPick: (position: number) => void;
  onClose: () => void;
}

/** 查找结果面板：与 Qt 版一致，右侧分栏展示并支持点击跳转。 */
export default function SearchPanel({ query, hits, active, onPick, onClose }: SearchPanelProps) {
  return (
    <aside className="search-panel">
      <div className="search-panel__header">
        <span className="search-panel__title" title={`查找结果: ${query}`}>
          查找结果: {query} ({hits.length})
        </span>
        <Button variant="icon" size="small" aria-label="关闭查找结果" onClick={onClose}>
          <X size={15} />
        </Button>
      </div>
      <div className="search-panel__list">
        {hits.length === 0 && (
          <div className="search-panel__empty">未找到匹配项</div>
        )}
        {hits.map((hit, position) => (
          <button
            key={`${hit.index}-${position}`}
            type="button"
            className={`search-hit${position === active ? " is-active" : ""}`}
            onClick={() => onPick(position)}
          >
            <span className="search-hit__line">第 {hit.index + 1} 行</span>
            <span className="search-hit__text">{hit.lineText}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
