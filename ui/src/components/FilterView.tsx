import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { highlightText } from "../utils/highlight";

/** 搜索会话(Notepad++ Search Results 风格,多会话并存) */
export interface SearchSession {
  id: number; // 后端 search_id
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  hitCount: number;
  truncated: boolean;
  highlightMap: Record<number, [number, number][]>;
  running: boolean;
  progress: { scanned: number; total: number } | null;
}

interface Props {
  /** 会话列表(最新在前) */
  sessions: SearchSession[];
  activeId: number | null;
  onSelectSession: (id: number) => void;
  onCloseSession: (id: number) => void;
  onClearSessions: () => void;
  lineCache: Record<number, string>;
  /** 行号(1-based) → 匹配字节区间(仅激活会话需要) */
  highlightMap: Record<number, [number, number][]>;
  fetchLines: (start: number, count: number) => Promise<void>;
  onJump: (lineNo0: number) => void;
  /** 右键命中行(标记) */
  onContextMenu: (lineNo: number, x: number, y: number) => void;
  /** 激活会话命中数(头部展示用) */
  hitCount: number;
  truncated: boolean;
  /** 外部控制高度(主窗口拖拽);省略时用 CSS 默认值 */
  height?: number | string;
  /** 弹出为独立窗口按钮(仅主窗口内嵌版提供) */
  onPopout?: () => void;
  /** 收起内嵌面板按钮 */
  onCollapse?: () => void;
}

const ROW_HEIGHT = 22;
const BUFFER = 10;

export default function FilterView({
  sessions,
  activeId,
  onSelectSession,
  onCloseSession,
  onClearSessions,
  lineCache,
  highlightMap,
  fetchLines,
  onJump,
  onContextMenu,
  hitCount,
  truncated,
  height,
  onPopout,
  onCollapse,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewHeight(el.clientHeight);
    const ro = new ResizeObserver(([entry]) => setViewHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 激活会话(找不到 activeId 时回退到最新)
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;
  const hitLines = useMemo(() => {
    if (!active) return [];
    // V8 对整数键按升序迭代,Object.keys 天然有序,无需 sort
    return Object.keys(active.highlightMap).map(Number);
  }, [active]);

  const range = useMemo(() => {
    if (viewHeight === 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
    const count = Math.ceil(viewHeight / ROW_HEIGHT) + BUFFER * 2;
    return { start, end: Math.min(hitLines.length, start + count) };
  }, [scrollTop, viewHeight, hitLines.length]);

  const visibleHits = useMemo(
    () => hitLines.slice(range.start, range.end),
    [hitLines, range],
  );

  // 拉取可见命中行的文本
  const missing = useMemo(() => {
    const list: number[] = [];
    for (const ln of visibleHits) {
      if (!(ln - 1 in lineCache)) list.push(ln - 1);
    }
    return list;
  }, [visibleHits, lineCache]);

  const fetchVisible = useCallback(async () => {
    if (missing.length === 0) return;
    // 按连续段分组拉取
    let segStart = missing[0];
    for (let i = 1; i <= missing.length; i++) {
      if (i === missing.length || missing[i] !== missing[i - 1] + 1) {
        await fetchLines(segStart, missing[i - 1] - segStart + 1);
        if (i < missing.length) segStart = missing[i];
      }
    }
  }, [missing, fetchLines]);

  useEffect(() => {
    void fetchVisible();
  }, [fetchVisible]);

  return (
    <div className="filter-view" style={height !== undefined ? { height } : undefined}>
      <div className="filter-header">
        <span className="filter-title">FILTER</span>
        {/* 会话 chips:每次搜索一个,点击切换对比,× 关闭单个 */}
        <div className="filter-sessions">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-chip ${s.id === active?.id ? "active" : ""} ${s.running ? "running" : ""}`}
              title={s.query}
              onClick={() => onSelectSession(s.id)}
            >
              <span className="chip-q">{s.query}</span>
              <span className="chip-count">
                {`${s.hitCount.toLocaleString()}${s.truncated ? "+" : ""}`}
              </span>
              <button
                className="chip-close"
                title="关闭此会话"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSession(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <span className="filter-spacer" />
        <span className="filter-info">
          {hitCount.toLocaleString()}
          {truncated ? "+" : ""} 命中
        </span>
        <button
          className="panel-btn"
          onClick={onClearSessions}
          title="清空全部会话"
        >
          🗑
        </button>
        {onPopout && (
          <button
            className="panel-btn"
            onClick={onPopout}
            title="弹出为独立窗口"
          >
            ↗
          </button>
        )}
        {onCollapse && (
          <button
            className="panel-btn"
            onClick={onCollapse}
            title="收起面板"
          >
            ▾
          </button>
        )}
      </div>
      <div
        className="filter-body"
        ref={containerRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {active && hitLines.length > 0 ? (
          <div className="filter-canvas" style={{ height: hitLines.length * ROW_HEIGHT }}>
            {visibleHits.map((ln, idx) => {
              const lineNo0 = ln - 1;
              const text = lineCache[lineNo0] ?? "";
              return (
                <div
                  key={ln}
                  className="filter-row"
                  style={{ position: "absolute", top: (range.start + idx) * ROW_HEIGHT, height: ROW_HEIGHT }}
                  title={text}
                  onClick={() => onJump(lineNo0)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onContextMenu(ln, e.clientX, e.clientY);
                  }}
                >
                  <span className="filter-line-no">{String(ln).padStart(7, " ")}</span>
                  <span className="filter-text">
                    {text ? highlightText(text, highlightMap[ln] ?? [], `f-${ln}`) : text}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="filter-empty">
            {active ? "0 命中" : "无搜索会话"}
          </div>
        )}
      </div>
    </div>
  );
}
