import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle, memo } from "react";
import { highlightText } from "../utils/highlight";
import { paletteColor, type Mark } from "../utils/palette";
import { useSettings, getSettings, setSetting } from "../utils/settings";

interface Props {
  lineCount: number;
  lineCache: Record<number, string>;
  /** 行号(1-based) → 匹配字节区间 */
  highlightMap: Record<number, [number, number][]>;
  /** 行号(1-based) → 标记 */
  marks: Record<number, Mark>;
  /** 已固定的行号集合(1-based),渲染书签圆点 */
  pins: ReadonlySet<number>;
  /** tail 模式:行数增加时自动滚动到底部 */
  followTail: boolean;
  /** 右键某行日志 */
  onContextMenu: (lineNo: number, x: number, y: number) => void;
  fetchLines: (start: number, count: number) => Promise<void>;
  /** 是否显示备注注释(设置里完全屏蔽) */
  showNotes: boolean;
  /** 全局折叠所有备注注释(状态栏开关;仍可单个点 📝 展开) */
  globalCollapsed: boolean;
  /** 右键备注注释行(复制/编辑/删除菜单) */
  onNoteContextMenu: (lineNo: number, x: number, y: number) => void;
}

export interface LogViewHandle {
  scrollToLine: (lineNo0: number) => void;
  /** 当前视口首行(0-based),供快照固定视图 */
  getFirstLine: () => number;
}

const BUFFER = 10; // extra rows above/below viewport

// 备注注释行高度(在日志行上方渲染的"代码注释"样式,不写入文件)
const NOTE_H = 16;

const LogView = forwardRef<LogViewHandle, Props>(function LogView(
  { lineCount, lineCache, highlightMap, marks, pins, followTail, onContextMenu, fetchLines, showNotes, globalCollapsed, onNoteContextMenu }: Props,
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const fetchingRef = useRef(false);
  const prevCountRef = useRef(lineCount);
  // 折叠状态(1-based line_no):
  // 非全局折叠:collapsedNotes 记录被单条折叠的行;
  // 全局折叠(globalCollapsed):expandedNotes 记录被单条展开的行(默认都收起)。
  const [collapsedNotes, setCollapsedNotes] = useState<Set<number>>(new Set());
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  /** 该行注释是否显示(设置屏蔽 / 全局折叠与单条覆盖共同决定) */
  const noteVisible = useCallback(
    (line1: number): boolean => {
      if (!showNotes) return false;
      if (globalCollapsed) return expandedNotes.has(line1);
      return !collapsedNotes.has(line1);
    },
    [showNotes, globalCollapsed, expandedNotes, collapsedNotes],
  );
  /** 行内 📝 双向切换:折叠 ↔ 展开(折叠交互只走图标,避免与选中文本冲突) */
  const toggleNote = (line1: number) => {
    if (globalCollapsed) {
      setExpandedNotes((prev) => {
        const next = new Set(prev);
        if (next.has(line1)) next.delete(line1);
        else next.add(line1);
        return next;
      });
    } else {
      setCollapsedNotes((prev) => {
        const next = new Set(prev);
        if (next.has(line1)) next.delete(line1);
        else next.add(line1);
        return next;
      });
    }
  };
  // 跳转高亮(标记/快照/固定点击跳转后,目标行短暂高亮提示)
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  // 行高 = 字号 + 行距(设置层唯一公式);字号/行距变化 → 组件重渲 + 滚动换算同步
  const rowHeight = useSettings((s) => s.fontSize + s.rowSpacing);

  // tail 模式:行数增长时自动跟随底部
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = lineCount;
    if (followTail && lineCount > prev && viewportRef.current) {
      const el = viewportRef.current;
      const top = lineCount * rowHeight;
      el.scrollTop = top;
      setScrollTop(top);
    }
  }, [lineCount, followTail, rowHeight]);

  // Track viewport size
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 字号/行高变化瞬间:保持"视口顶部所在行"不变,滚动位置按新旧比例换算,避免跳动
  const prevRowRef = useRef(rowHeight);
  useEffect(() => {
    const prev = prevRowRef.current;
    prevRowRef.current = rowHeight;
    if (prev === rowHeight || !viewportRef.current) return;
    const el = viewportRef.current;
    const lineF = el.scrollTop / prev;
    el.scrollTop = lineF * rowHeight;
    setScrollTop(el.scrollTop);
  }, [rowHeight]);

  // Ctrl+滚轮缩放字号(原生监听:React onWheel 是 passive,无法 preventDefault 拦截页面缩放)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // 普通滚动完全放行
      e.preventDefault();
      const fs = getSettings().fontSize;
      setSetting("fontSize", Math.min(16, Math.max(11, fs + (e.deltaY < 0 ? 1 : -1))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 高亮指定行(0-based):短暂高亮后自动复位,提示跳转落点
  const flashAt = useCallback((lineNo0: number) => {
    setFlashLine(lineNo0);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashLine(null), 1600);
  }, []);

  // 统计某行(0-based i0)之前"可见"的备注行数,用于虚拟滚动叠加注释行高度。
  // 折叠的注释行高度为 0(真折叠:行紧贴),不计入。
  const countNotesBefore = useCallback(
    (i0: number) => {
      let c = 0;
      for (const k in marks)
        if (marks[k]?.note && noteVisible(Number(k)) && Number(k) - 1 < i0) c++;
      return c;
    },
    [marks, noteVisible],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(lineNo0: number) {
        const el = viewportRef.current;
        if (!el) return;
        // 叠加目标行之前的注释行高度,跳转定位更准
        const top = Math.max(
          0,
          lineNo0 * rowHeight + countNotesBefore(lineNo0) * NOTE_H - viewportHeight / 3,
        );
        el.scrollTop = top; // 同步赋值,避免 scrollTo 异步时序
        setScrollTop(top);
        // 预取目标行附近,避免跳转后屏幕空白等待 fetch
        void fetchLines(Math.max(0, lineNo0 - 20), 41);
        flashAt(lineNo0); // 跳转落点高亮提示
      },
      getFirstLine() {
        return Math.floor((viewportRef.current?.scrollTop ?? 0) / rowHeight);
      },
    }),
    [viewportHeight, fetchLines, rowHeight, flashAt, countNotesBefore],
  );

  // Update scroll position
  const handleScroll = useCallback(() => {
    setScrollTop(viewportRef.current?.scrollTop ?? 0);
  }, []);

  // Calculate visible range
  const visibleRange = useMemo(() => {
    if (viewportHeight === 0 || lineCount === 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - BUFFER);
    const count = Math.ceil(viewportHeight / rowHeight) + BUFFER * 2;
    const end = Math.min(lineCount, start + count);
    return { start, end };
  }, [scrollTop, viewportHeight, lineCount, rowHeight]);

  // Fetch missing lines in visible range
  useEffect(() => {
    if (lineCount === 0 || fetchingRef.current) return;

    const missing: number[] = [];
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      if (!(i in lineCache)) missing.push(i);
    }
    if (missing.length === 0) return;

    const groups: [number, number][] = [];
    let rs = missing[0];
    for (let j = 1; j <= missing.length; j++) {
      if (j === missing.length || missing[j] !== missing[j - 1] + 1) {
        groups.push([rs, missing[j - 1] - rs + 1]);
        if (j < missing.length) rs = missing[j];
      }
    }

    fetchingRef.current = true;
    Promise.all(groups.map(([s, c]) => fetchLines(s, c))).finally(() => {
      fetchingRef.current = false;
    });
  }, [visibleRange, lineCount, fetchLines, lineCache]);

  // Build visible rows
  const rows = useMemo(() => {
    const result: React.ReactNode[] = [];
    // 游标定位:起始 top 叠加前面注释行高度,带注释的行在行上方插一条注释
    let y = visibleRange.start * rowHeight + countNotesBefore(visibleRange.start) * NOTE_H;
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const note = marks[i + 1]?.note;
      // 真折叠:折叠的注释行不渲染(高度为 0,上下行紧贴);
      // 折叠/展开只走行内 📝 图标(toggleNote),避免与选中文本冲突
      if (showNotes && note && noteVisible(i + 1)) {
        result.push(
          <div
            key={`note-${i}`}
            className="log-note"
            style={{ position: "absolute", top: y, height: NOTE_H }}
            onContextMenu={(e) => {
              e.preventDefault();
              onNoteContextMenu(i + 1, e.clientX, e.clientY);
            }}
            title="右键复制/编辑/删除,点击行内 📝 折叠"
          >
            {note}
          </div>,
        );
        y += NOTE_H;
      }
      const text = lineCache[i];
      const ranges = highlightMap[i + 1];
      const mark = marks[i + 1];
      const markColor = mark ? paletteColor(mark.color) : undefined;
      result.push(
        <div
          key={i}
          className={`log-line${i === flashLine ? " flash-line" : ""}`}
          style={{
            position: "absolute",
            top: y,
            height: rowHeight,
            borderLeftColor: markColor,
            // 标记行整行着色(8 位 hex alpha ≈ 13%),一眼可辨
            backgroundColor: markColor ? `${markColor}22` : undefined,
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(i + 1, e.clientX, e.clientY);
          }}
        >
          {pins.has(i + 1) && <span className="pin-dot" title="已固定" />}
          <span className="line-no">{String(i + 1).padStart(7, " ")}</span>
          <span
            className="line-mark-icon"
            title={
              mark?.note
                ? noteVisible(i + 1)
                  ? "点击折叠该条备注"
                  : `${mark.note}(点击展开)`
                : undefined
            }
            onClick={(e) => {
              // 行内 📝 双向切换:折叠时点击展开,展开时点击折叠(唯一折叠入口,避免与选中冲突)
              if (mark?.note) {
                e.stopPropagation();
                toggleNote(i + 1);
              }
            }}
          >
            {mark?.note ? "📝" : ""}
          </span>
          <span className="line-text">
            {text ? (ranges ? highlightText(text, ranges, `hl-${i + 1}`) : text) : ""}
          </span>
        </div>
      );
      y += rowHeight;
    }
    return result;
  }, [visibleRange, lineCache, highlightMap, marks, pins, onContextMenu, rowHeight, countNotesBefore, noteVisible]);

  const totalNotes = useMemo(() => {
    let c = 0;
    for (const k in marks) if (marks[k]?.note && noteVisible(Number(k))) c++;
    return c;
  }, [marks, noteVisible]);
  const totalHeight = lineCount * rowHeight + totalNotes * NOTE_H;

  return (
    <div className="log-viewport" ref={viewportRef} onScroll={handleScroll}>
      <div className="log-canvas" style={{ height: totalHeight }}>
        {rows}
      </div>
    </div>
  );
});

// memo:搜索进度/计数等高频 App 重渲染不再连带重绘日志视图(虚拟列表渲染最重)。
// 注意:所有传给它的回调必须在父组件稳定化(useCallback),否则 memo 失效
export default memo(LogView);
