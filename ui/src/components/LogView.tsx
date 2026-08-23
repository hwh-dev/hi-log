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
}

export interface LogViewHandle {
  scrollToLine: (lineNo0: number) => void;
  /** 当前视口首行(0-based),供快照固定视图 */
  getFirstLine: () => number;
}

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

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(lineNo0: number) {
        const el = viewportRef.current;
        if (!el) return;
        const top = Math.max(0, lineNo0 * rowHeight - viewportHeight / 3);
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
    [viewportHeight, fetchLines, rowHeight, flashAt],
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
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
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
            top: i * rowHeight,
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
          <span className="line-mark-icon">{mark?.note ? "📝" : ""}</span>
          <span className="line-text">
            {text ? (ranges ? highlightText(text, ranges, `hl-${i + 1}`) : text) : ""}
          </span>
        </div>
      );
    }
    return result;
  }, [visibleRange, lineCache, highlightMap, marks, pins, onContextMenu, rowHeight]);

  const totalHeight = lineCount * rowHeight;

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
