import { useRef, useState, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from "react";
import { highlightText } from "../utils/highlight";
import { paletteColor, type Mark } from "../utils/palette";
import { useSettings, getSettings, setSetting, expandContext } from "../utils/settings";

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
  /** 行号(1-based) → 标记(命中行左侧色条) */
  marks: Record<number, Mark>;
  fetchLines: (start: number, count: number) => Promise<{ text: string; line_no: number }[]>;
  onJump: (lineNo0: number) => void;
  /** 右键命中行(标记) */
  onContextMenu: (lineNo: number, x: number, y: number) => void;
  /** 激活会话命中数(头部展示用) */
  hitCount: number;
  truncated: boolean;
  /** 外部控制高度(主窗口拖拽);省略时用 CSS 默认值 */
  height?: number | string;
  /** 文件总行数(上下文展开上限) */
  lineCount: number;
  /** 当前激活命中行(1-based):跳转时命中列表跟随滚动到该项 */
  activeHitLine?: number | null;
  /** 弹出为独立窗口按钮(仅主窗口内嵌版提供) */
  onPopout?: () => void;
  /** 收起内嵌面板按钮 */
  onCollapse?: () => void;
  /** 结果内二次搜索(filter in results):命中行子串 AND 过滤,不用正则 */
  refineActive?: boolean;
  refineQuery?: string;
  setRefineQuery?: (v: string) => void;
  /** 二次命中的行号(1-based,降序排序;App 已按 lineCache 过滤) */
  refineLines?: number[];
  /** 在二次命中里前/后跳转(面板 ‹ ›,与 F6/Shift+F6 同语义) */
  onRefinePrev?: () => void;
  onRefineNext?: () => void;
}

/** FilterView 对外句柄:Ctrl+F 唤起结果内过滤 */
export interface FilterViewHandle {
  openRefine: () => void;
}

const BUFFER = 18;
/** 稠密命中防御:开启上下文(±N>0)时最多展示的行数(虚拟滚动只渲染视口,截断仅影响可跳转性) */
const MAX_DISPLAY_LINES = 2_000_000;

/** 计算 query 在 text 中的所有匹配字节区间(供 highlightText 用,多次出现全部标出) */
function findByteRanges(text: string, query: string): [number, number][] {
  if (!query || !text) return [];
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const out: [number, number][] = [];
  let idx = 0;
  for (;;) {
    const pos = tl.indexOf(ql, idx);
    if (pos < 0) break;
    const before = new TextEncoder().encode(text.slice(0, pos)).length;
    const qBytes = new TextEncoder().encode(query).length;
    if (qBytes > 0) out.push([before, before + qBytes]);
    idx = pos + Math.max(1, ql.length);
  }
  return out;
}

export default forwardRef<FilterViewHandle, Props>(function FilterView(
  {
    sessions,
    activeId,
    onSelectSession,
    onCloseSession,
    onClearSessions,
    lineCache,
    highlightMap,
    marks,
    fetchLines,
    onJump,
    onContextMenu,
    hitCount,
    truncated,
    height,
    onPopout,
    onCollapse,
    lineCount,
    activeHitLine,
    refineActive = false,
    refineQuery = "",
    setRefineQuery,
    refineLines,
    onRefinePrev,
    onRefineNext,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(0);
  // 行高 = 字号 + 行距(设置层唯一公式,与 LogView 同步)
  const rowHeight = useSettings((s) => s.fontSize + s.rowSpacing);

  // 结果内过滤:默认隐藏,Ctrl+F / 面板右上角按钮唤起(openRefine)
  const [refineOpen, setRefineOpen] = useState(false);
  const refineInputRef = useRef<HTMLInputElement | null>(null);
  const toggleRefine = (open: boolean) => {
    setRefineOpen(open);
    if (open) {
      // 延迟到渲染后聚焦(输入框本轮才挂载)
      requestAnimationFrame(() => {
        refineInputRef.current?.focus();
        refineInputRef.current?.select();
      });
    } else {
      // 关闭时清空二次搜索:恢复完整结果(否则静默保持筛选状态)
      setRefineQuery?.("");
    }
  };
  useImperativeHandle(ref, () => ({ openRefine: () => toggleRefine(true) }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewHeight(el.clientHeight);
    const ro = new ResizeObserver(([entry]) => setViewHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 字号/行高变化瞬间:保持"视口顶部所在行"不变,滚动位置按新旧比例换算
  const prevRowRef = useRef(rowHeight);
  useEffect(() => {
    const prev = prevRowRef.current;
    prevRowRef.current = rowHeight;
    if (prev === rowHeight || !containerRef.current) return;
    const el = containerRef.current;
    const lineF = el.scrollTop / prev;
    el.scrollTop = lineF * rowHeight;
    setScrollTop(el.scrollTop);
  }, [rowHeight]);

  // Ctrl+滚轮缩放字号(原生监听:React onWheel 是 passive,无法 preventDefault)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const fs = getSettings().fontSize;
      setSetting("fontSize", Math.min(16, Math.max(11, fs + (e.deltaY < 0 ? 1 : -1))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 激活会话(找不到 activeId 时回退到最新)
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;
  const hitLines = useMemo(() => {
    if (!active) return [];
    // V8 对整数键按升序迭代,Object.keys 天然有序,无需 sort
    return Object.keys(active.highlightMap).map(Number);
  }, [active]);

  // 上下文 ±N 行:命中行展开为显示行(上下文行调暗,一眼区分);稠密命中截断防御
  const contextLines = useSettings((s) => s.contextLines);
  // 二次搜索激活:展示区改用二次命中集合(否则全部命中)
  const navLines = refineActive && refineLines ? refineLines : hitLines;
  const displayLines = useMemo(() => {
    if (contextLines <= 0) return navLines;
    const expanded = expandContext(navLines, contextLines, lineCount);
    return expanded.length > MAX_DISPLAY_LINES ? expanded.slice(0, MAX_DISPLAY_LINES) : expanded;
  }, [navLines, contextLines, lineCount]);
  // 二次命中集合(Fast 判定行是否为二次命中)
  const refineSet = useMemo(
    () => (refineActive ? new Set(refineLines ?? []) : new Set<number>()),
    [refineActive, refineLines],
  );


  // 搜索跳转(‹›):命中列表跟随滚动到当前激活命中行(与文档视口联动)。
  // 固定行高:idx * rowHeight 直接换算,无换行累计,天然无空白。
  useEffect(() => {
    if (activeHitLine == null) return;
    const idx = displayLines.indexOf(activeHitLine);
    if (idx < 0 || !containerRef.current) return;
    const el = containerRef.current;
    const top = Math.max(0, idx * rowHeight - el.clientHeight / 2);
    el.scrollTop = top;
    setScrollTop(top);
  }, [activeHitLine, displayLines, rowHeight]);

  const range = useMemo(() => {
    if (viewHeight === 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - BUFFER);
    const count = Math.ceil(viewHeight / rowHeight) + BUFFER * 2;
    return { start, end: Math.min(displayLines.length, start + count) };
  }, [scrollTop, viewHeight, displayLines.length, rowHeight]);

  const visibleLines = useMemo(
    () => displayLines.slice(range.start, range.end),
    [displayLines, range],
  );

  // 拉取可见显示行(命中+上下文)的文本
  const missing = useMemo(() => {
    const list: number[] = [];
    for (const ln of visibleLines) {
      if (!(ln - 1 in lineCache)) list.push(ln - 1);
    }
    return list;
  }, [visibleLines, lineCache]);

  const fetchingRef = useRef(false);
  const fetchVisible = useCallback(async () => {
    if (missing.length === 0 || fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      // 一次拉整块(first..last,含中间行):减少 IPC 往返与滚动空窗
      const first = missing[0];
      const last = missing[missing.length - 1];
      await fetchLines(first, last - first + 1);
    } finally {
      fetchingRef.current = false;
    }
  }, [missing, fetchLines]);

  useEffect(() => {
    void fetchVisible();
  }, [fetchVisible]);

  // 行定位:固定行高,首行贴视口顶(起始 top 由 range.start 直接换算)
  let y = range.start * rowHeight;
  const rowNodes = visibleLines.map((ln) => {
    const lineNo0 = ln - 1;
    const text = lineCache[lineNo0] ?? "";
    // 二次搜索激活:二次命中行左缘强调 + 命中词黄色高亮;上下文行恢复调暗
    const isRefineHit = refineActive && refineSet.has(ln);
    const isHit = refineActive ? isRefineHit : ln in highlightMap;
    const mark = marks[ln];
    const markColor = mark ? paletteColor(mark.color) : undefined;
    // 正文高亮:二次搜索 → 命中子串;否则 → 主搜索命中区间
    const bodyText = text
      ? isRefineHit && refineQuery.trim()
        ? highlightText(text, findByteRanges(text, refineQuery.trim()), `rf-${ln}`)
        : isHit
          ? highlightText(text, highlightMap[ln] ?? [], `f-${ln}`)
          : text
      : text;
    const node = (
      <div
        key={ln}
        className={`filter-row ${isHit ? "" : "ctx"}`}
        style={{
          position: "absolute",
          top: y,
          height: rowHeight,
          borderLeftColor: markColor,
          backgroundColor: markColor ? `${markColor}22` : undefined,
        }}
        title={text}
        onClick={() => onJump(lineNo0)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(ln, e.clientX, e.clientY);
        }}
      >
        <span className="filter-line-no">{String(ln).padStart(7, " ")}</span>
        <span className="line-mark-icon">{mark?.note ? "📝" : ""}</span>
        <span className="filter-text">{bodyText}</span>
      </div>
    );
    y += rowHeight;
    return node;
  });
  const canvasH = displayLines.length * rowHeight;

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
          {contextLines > 0 && <span className="ctx-badge">±{contextLines}</span>}
        </span>
        {setRefineQuery && (
          <>
            <button
              className={`panel-btn refine-toggle${refineOpen ? " active" : ""}`}
              title="在结果内过滤 (Ctrl+F)"
              onClick={() => toggleRefine(!refineOpen)}
            >
              🔍
            </button>
            {refineOpen && (
              <span className="refine-bar">
                <input
                  ref={refineInputRef}
                  className="refine-input"
                  value={refineQuery}
                  placeholder="在结果中过滤…"
                  title="在当前命中行里做子串二次过滤(不用正则),Enter 跳转首个"
                  spellCheck={false}
                  onChange={(e) => setRefineQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setRefineQuery("");
                    } else if (e.key === "Enter" && refineLines && refineLines.length > 0) {
                      e.preventDefault();
                      onJump(refineLines[0] - 1); // 跳到第一个二次命中
                    }
                  }}
                />
                <button
                  className="panel-btn refine-nav"
                  title="上一个二次命中 (Shift+Enter)"
                  disabled={!onRefinePrev || !refineActive || (refineLines?.length ?? 0) === 0}
                  onClick={onRefinePrev}
                >
                  ‹
                </button>
                <button
                  className="panel-btn refine-nav"
                  title="下一个二次命中 (Enter)"
                  disabled={!onRefineNext || !refineActive || (refineLines?.length ?? 0) === 0}
                  onClick={onRefineNext}
                >
                  ›
                </button>
                {refineActive && (
                  <span className="refine-count">
                    <em className="refine-num">{(refineLines ?? []).length.toLocaleString()}</em>
                    <em className="refine-total">/{hitCount.toLocaleString()}</em>
                  </span>
                )}
              </span>
            )}
          </>
        )}
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
        {active && displayLines.length > 0 ? (
          <div className="filter-canvas" style={{ height: canvasH }}>
            {rowNodes}
          </div>
        ) : (
          <div className="filter-empty">
            {active ? "0 命中" : "无搜索会话"}
          </div>
        )}
      </div>
    </div>
  );
});
