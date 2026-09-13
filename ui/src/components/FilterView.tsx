import { useRef, useState, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle, memo } from "react";
import { highlightText } from "../utils/highlight";
import { paletteColor, type Mark } from "../utils/palette";
import { useSettings, getSettings, setSetting, expandContext } from "../utils/settings";
import { searchFlagsLabel, type SearchSpec } from "../utils/search";

/** 搜索会话(Notepad++ Search Results 风格,多会话并存) */
export interface SearchSession extends SearchSpec {
  id: number; // 后端 search_id
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
  /** 已固定的行号集合(1-based):命中面板也要显示固定标记,与主视图一致 */
  pins?: ReadonlySet<number>;
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
  /** 把激活会话的命中行导出到文件;缺省不显示按钮 */
  onExport?: (session: SearchSession) => void;
}

/** FilterView 对外句柄:Ctrl+F 唤起结果内过滤 */
export interface FilterViewHandle {
  openRefine: () => void;
}

const BUFFER = 18;
/** 稠密命中防御:开启上下文(±N>0)时最多展示的行数(虚拟滚动只渲染视口,截断仅影响可跳转性) */
const MAX_DISPLAY_LINES = 2_000_000;
/** Chromium 元素高度上限约 33.5M px:超过时 DOM 滚不动(被 clamp)。固定行高
    命中面板同样受此限制,换算走"逻辑坐标",DOM 只当滚动条 —— 稠密命中不出空白/滚动失效。 */
const LIMIT_H = 33_000_000;
/** 行块位移拆分量(与 LogView 一致):大数值 transform 在 f32 下会丢精度 */
const ROWS_BASE_UNIT = 1_000_000;

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

const FilterView = forwardRef<FilterViewHandle, Props>(function FilterView(
  {
    sessions,
    activeId,
    onSelectSession,
    onCloseSession,
    onClearSessions,
    lineCache,
    highlightMap,
    marks,
    pins,
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
    onExport,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(0);
  // 行高 = 字号 + 行距(设置层唯一公式,与 LogView 同步)
  const rowHeight = useSettings((s) => s.fontSize + s.rowSpacing);
  /** 行块容器:滚动时同步写 transform(不经 React),与滚动同帧 */
  const rowsRef = useRef<HTMLDivElement>(null);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

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


  // ── 逻辑坐标 ↔ DOM 坐标(33M clamp):固定行高,无换行累计 ──
  const logicalH = displayLines.length * rowHeight;
  const domH = Math.min(logicalH, LIMIT_H);
  const domToS = useCallback(
    (st: number): number => {
      if (domH >= logicalH) return st;
      const domMax = Math.max(1, domH - viewHeight);
      return (st * Math.max(0, logicalH - viewHeight)) / domMax;
    },
    [domH, logicalH, viewHeight],
  );
  const sToDom = useCallback(
    (s: number): number => {
      if (domH >= logicalH) return s;
      const domMax = Math.max(1, domH - viewHeight);
      return (s * domMax) / Math.max(1, logicalH - viewHeight);
    },
    [domH, logicalH, viewHeight],
  );

  // 搜索跳转(‹›):命中列表跟随滚动到当前激活命中行(与文档视口联动)。
  // 固定行高:idx * rowHeight 直接换算,无换行累计,天然无空白。
  //
  // 只在目标行**不在视口内**时才滚(且落到 1/3 处,留出上下文):点击一条已经在
  // 眼前的结果时也强制居中,会让整块列表从鼠标底下移走,手感像是点错了。
  useEffect(() => {
    if (activeHitLine == null) return;
    const idx = displayLines.indexOf(activeHitLine);
    const el = containerRef.current;
    if (idx < 0 || !el) return;
    // 可见性判定要用**与渲染同一套**的锚定映射:行块局部是 1:1 布局,只在视口顶锚定
    // (rowsShift = start*rowHeight − domToS(scrollTop) + scrollTop),所以屏幕上距视口顶的
    // 距离 = 行逻辑偏移 − domToS(scrollTop)。拿 sToDom(...) 去比 scrollTop 是另一套整体
    // 压缩映射,大文件下会把屏幕外的行判成"可见",于是点了不滚。
    const viewTopLogical = domToS(el.scrollTop);
    const relTop = idx * rowHeight - viewTopLogical;
    if (relTop >= 0 && relTop + rowHeight <= el.clientHeight) return;
    const top = Math.max(0, idx * rowHeight - el.clientHeight / 3);
    el.scrollTop = sToDom(top);
    setScrollTop(el.scrollTop);
  }, [activeHitLine, displayLines, rowHeight, sToDom]);

  const range = useMemo(() => {
    if (viewHeight === 0) return { start: 0, end: 0 };
    const logicalS = domToS(scrollTop);
    const start = Math.max(0, Math.floor(logicalS / rowHeight) - BUFFER);
    const count = Math.ceil(viewHeight / rowHeight) + BUFFER * 2;
    return { start, end: Math.min(displayLines.length, start + count) };
  }, [scrollTop, viewHeight, displayLines.length, rowHeight, domToS]);

  // 滚动:①同步写行块 transform(不经 React → 与滚动同帧,消除滚轮"掉帧"感);
  // ②再 setScrollTop,让 React 只在可见区间变化时重建行(低频)。
  const rangeStartRef = useRef(range.start);
  rangeStartRef.current = range.start;
  const domToSRef = useRef(domToS);
  domToSRef.current = domToS;
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const st = el.scrollTop;
    const rows = rowsRef.current;
    if (rows) {
      const shift = rangeStartRef.current * rowHeightRef.current - domToSRef.current(st) + st;
      const base = Math.floor(shift / ROWS_BASE_UNIT) * ROWS_BASE_UNIT;
      const basePx = `${base}px`;
      if (rows.style.top !== basePx) rows.style.top = basePx;
      rows.style.transform = `translateY(${shift - base}px)`;
    }
    setScrollTop(st);
  }, []);

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

  // 行块:局部坐标(相对 range.start)+ 外层 .filter-rows 单次 transform 承担滚动偏移。
  // 既让滚动时不重建行,也保证大结果集(33M 压缩)下行的位置与画布一致。
  const rowNodes = useMemo(() => {
  let y = 0;
  return visibleLines.map((ln) => {
    const lineNo0 = ln - 1;
    const text = lineCache[lineNo0] ?? "";
    // 二次搜索激活:二次命中行左缘强调 + 命中词黄色高亮;上下文行恢复调暗
    const isRefineHit = refineActive && refineSet.has(ln);
    const isHit = refineActive ? isRefineHit : ln in highlightMap;
    const mark = marks[ln];
    const markColor = mark ? paletteColor(mark.color) : undefined;
    // 固定标记与主视图一致:左侧圆点 + 整行淡色底(见 .filter-row.pinned)
    const pinned = pins?.has(ln) ?? false;
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
        className={`filter-row ${isHit ? "" : "ctx"}${pinned ? " pinned" : ""}${
          ln === activeHitLine ? " hit-cursor" : ""
        }`}
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
        {pinned && <span className="pin-dot" title="已固定" />}
        <span className="line-mark-icon">{mark?.note ? "📝" : ""}</span>
        <span className="filter-text">{bodyText}</span>
      </div>
    );
    y += rowHeight;
    return node;
  });
  }, [visibleLines, lineCache, refineActive, refineSet, highlightMap, marks, pins, refineQuery, rowHeight, onJump, onContextMenu, activeHitLine]);

  // 行块整体位移(含 33M 压缩映射):布局 top 承担 1M 的整数倍(精确),
  // 余量交 transform(数值小,f32 精度足够),避免大数值 transform 抖动
  const rowsShift = range.start * rowHeight - domToS(scrollTop) + scrollTop;
  const rowsBase = Math.floor(rowsShift / ROWS_BASE_UNIT) * ROWS_BASE_UNIT;
  const rowsResidual = rowsShift - rowsBase;

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
              title={[s.query, searchFlagsLabel(s)].filter(Boolean).join("  ")}
              onClick={() => onSelectSession(s.id)}
            >
              <span className="chip-q">{s.query}</span>
              {/* 选项旗标:带排除/整词的会话命中数天生更少,不写出来用户无从解释 */}
              {searchFlagsLabel(s) && (
                <span className="chip-flags">{searchFlagsLabel(s)}</span>
              )}
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
        {onExport && active && (
          <button
            className="panel-btn"
            title={`把「${[active.query, searchFlagsLabel(active)].filter(Boolean).join("  ")}」的命中行导出为文本文件`}
            onClick={() => onExport(active)}
          >
            导出
          </button>
        )}
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
        onScroll={handleScroll}
      >
        {active && displayLines.length > 0 ? (
          <div className="filter-canvas" style={{ height: domH }}>
            {/* 行块整体位移:滚动时只改这一个元素(布局 top 精确 + 小 transform 走合成层) */}
            <div
              className="filter-rows"
              ref={rowsRef}
              style={{ top: rowsBase, transform: `translateY(${rowsResidual}px)` }}
            >
              {rowNodes}
            </div>
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

// memo:回调已稳定化,App 因其它状态(侧栏聚合/tab/布局)重渲染时,命中面板不随之重渲染
export default memo(FilterView);
