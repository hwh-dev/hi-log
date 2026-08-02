import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle, memo } from "react";
import { highlightText } from "../utils/highlight";
import { paletteColor, type Mark } from "../utils/palette";

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
}

export interface LogViewHandle {
  scrollToLine: (lineNo0: number) => void;
  /** 当前视口首行(0-based),供快照固定视图 */
  getFirstLine: () => number;
}

const ROW_HEIGHT = 22; // px, monospace 13px + 9px padding
const BUFFER = 10; // extra rows above/below viewport

const LogView = forwardRef<LogViewHandle, Props>(function LogView(
  { lineCount, lineCache, highlightMap, marks, pins, followTail, onContextMenu, fetchLines }: Props,
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const fetchingRef = useRef(false);
  const prevCountRef = useRef(lineCount);

  // tail 模式:行数增长时自动跟随底部
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = lineCount;
    if (followTail && lineCount > prev && viewportRef.current) {
      const el = viewportRef.current;
      const top = lineCount * ROW_HEIGHT;
      el.scrollTop = top;
      setScrollTop(top);
    }
  }, [lineCount, followTail]);

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

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(lineNo0: number) {
        const el = viewportRef.current;
        if (!el) return;
        const top = Math.max(0, lineNo0 * ROW_HEIGHT - viewportHeight / 3);
        el.scrollTop = top; // 同步赋值,避免 scrollTo 异步时序
        setScrollTop(top);
        // 预取目标行附近,避免跳转后屏幕空白等待 fetch
        void fetchLines(Math.max(0, lineNo0 - 20), 41);
      },
      getFirstLine() {
        return Math.floor((viewportRef.current?.scrollTop ?? 0) / ROW_HEIGHT);
      },
    }),
    [viewportHeight, fetchLines],
  );

  // Update scroll position
  const handleScroll = useCallback(() => {
    setScrollTop(viewportRef.current?.scrollTop ?? 0);
  }, []);

  // Calculate visible range
  const visibleRange = useMemo(() => {
    if (viewportHeight === 0 || lineCount === 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
    const count = Math.ceil(viewportHeight / ROW_HEIGHT) + BUFFER * 2;
    const end = Math.min(lineCount, start + count);
    return { start, end };
  }, [scrollTop, viewportHeight, lineCount]);

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
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const text = lineCache[i];
      const ranges = highlightMap[i + 1];
      const mark = marks[i + 1];
      const markColor = mark ? paletteColor(mark.color) : undefined;
      result.push(
        <div
          key={i}
          className="log-line"
          style={{
            position: "absolute",
            top: i * ROW_HEIGHT,
            height: ROW_HEIGHT,
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
          <span className="line-mark-icon">{mark?.note ? "📝" : ""}</span>
          <span className="line-text">
            {text ? (ranges ? highlightText(text, ranges, `hl-${i + 1}`) : text) : ""}
          </span>
        </div>
      );
    }
    return result;
  }, [visibleRange, lineCache, highlightMap, marks, pins, onContextMenu]);

  const totalHeight = lineCount * ROW_HEIGHT;

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
