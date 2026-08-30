import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle, memo } from "react";
import { highlightText } from "../utils/highlight";
import { measureLines } from "../utils/measure";
import { dbg } from "../utils/log";
import { paletteColor, type Mark } from "../utils/palette";
import { useSettings, getSettings, setSetting } from "../utils/settings";

interface Props {
  lineCount: number;
  /** 文件字节大小(行高索引按内存+读盘成本判定是否构建) */
  fileSize?: number;
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
  fetchLines: (start: number, count: number) => Promise<{ text: string; line_no: number }[]>;
  /** 仅测量用拉取(不写入 lineCache):行高索引在后台构建,避免大文件缓存膨胀 */
  measureFetch?: (start: number, count: number) => Promise<{ text: string; line_no: number }[]>;
  /** 是否显示备注注释(设置里完全屏蔽) */
  showNotes: boolean;
  /** 当前激活命中行(1-based),渲染 klogg 式光标条 */
  activeHitLine?: number | null;
  /** 全局折叠所有备注注释(状态栏开关;仍可单个点 📝 展开) */
  globalCollapsed: boolean;
  /** 右键备注注释行(复制/编辑/删除菜单) */
  onNoteContextMenu: (lineNo: number, x: number, y: number) => void;
}

export interface LogViewHandle {
  scrollToLine: (lineNo0: number) => void;
  /** 当前视口首行(0-based),供快照固定视图 */
  getFirstLine: () => number;
  /** 移动行光标(±delta 行,clamp 边界;滚出视口时自动跟随) */
  moveCursor: (delta: number) => void;
  /** 当前行光标(0-based) */
  getCursorLine: () => number;
}

const BUFFER = 10; // extra rows above/below viewport
const NOTE_H = 16;
/** 行高索引成本:内存 = 2×lineCount×4B(wraps+prefix 两个 Int32);构建需读全文件文本一次。
    按"内存预算"与"读盘大小"双维度判定,而不是拍脑袋的行数上限:
    超限则回退固定行高(不折行,不重叠,无乱码),只影响长行折行显示。 */
const INDEX_MEM_BYTES = 128 * 1024 * 1024; // 索引数组 ≤128MB
const INDEX_READ_BYTES = 800 * 1024 * 1024; // 读盘 ≤800MB
const INDEX_CAP_LINES = Math.floor(INDEX_MEM_BYTES / 8); // 8B/行 → 上限行数
/** Chromium 元素高度上限约 33.5M px:超过时 DOM 滚不动(被 clamp)。
    换算全走"逻辑坐标",DOM 只当滚动条 —— 大文件跳转/滚动零空白的关键。 */
const LIMIT_H = 33_000_000;

/** 每行折行数前缀索引:prefix[l+1] = prefix[l] + wraps[l],可 O(log n) 定位任意行 */
interface HeightIndex {
  wraps: Int32Array;
  prefix: Int32Array;
  lineCount: number;
}

function markRangeText(text: string, col: number, len: number, color: string): React.ReactNode {
  const s = Math.max(0, col);
  const e = Math.min(text.length, col + Math.max(0, len));
  if (e <= s) return text;
  return (
    <>
      {text.slice(0, s)}
      <span className="mark-range" style={{ background: `${color}55` }}>
        {text.slice(s, e)}
      </span>
      {text.slice(e)}
    </>
  );
}

const LogView = forwardRef<LogViewHandle, Props>(function LogView(
  { lineCount, fileSize, lineCache, highlightMap, marks, pins, followTail, onContextMenu, fetchLines, measureFetch, showNotes, globalCollapsed, onNoteContextMenu, activeHitLine }: Props,
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);

  // ── 行光标 ──
  const [cursorLine, setCursorLine] = useState(0);
  const cursorLineRef = useRef(0);
  const applyCursor = (n0: number) => {
    cursorLineRef.current = n0;
    setCursorLine(n0);
  };
  useEffect(() => {
    setCursorLine((c) => Math.max(0, Math.min(c, lineCount - 1)));
  }, [lineCount]);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const fetchingRef = useRef(false);
  const prevCountRef = useRef(lineCount);
  const [collapsedNotes, setCollapsedNotes] = useState<Set<number>>(new Set());
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const noteVisible = useCallback(
    (line1: number): boolean => {
      if (!showNotes) return false;
      if (globalCollapsed) return expandedNotes.has(line1);
      return !collapsedNotes.has(line1);
    },
    [showNotes, globalCollapsed, expandedNotes, collapsedNotes],
  );
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
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const rowHeight = useSettings((s) => s.fontSize + s.rowSpacing);

  // tail
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = lineCount;
    if (followTail && lineCount > prev && viewportRef.current) {
      const el = viewportRef.current;
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [lineCount, followTail, rowHeight]);

  // viewport size
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    setViewportWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
      setViewportWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 字号/行高变化瞬间保持视口顶部行不变
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

  // Ctrl+滚轮缩放
  useEffect(() => {
    const el = viewportRef.current;
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

  const flashAt = useCallback((lineNo0: number) => {
    setFlashLine(lineNo0);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashLine(null), 1600);
  }, []);

  const countNotesBefore = useCallback(
    (i0: number) => {
      let c = 0;
      for (const k in marks)
        if (marks[k]?.note && noteVisible(Number(k)) && Number(k) - 1 < i0) c++;
      return c;
    },
    [marks, noteVisible],
  );

  // ── 行高索引(换行精确高度,state 驱动 → 位置自动重算,不残留空白)──
  const [heightIndex, setHeightIndex] = useState<HeightIndex | null>(null);
  const buildingRef = useRef(false);
  const fontStr = `${getComputedStyle(document.body).fontSize} ${getComputedStyle(document.body).fontFamily}`;
  const availWidth = Math.max(60, (viewportWidth || viewportRef.current?.clientWidth || window.innerWidth) - 100);
  useEffect(() => {
    if (
      lineCount <= 0 ||
      lineCount > INDEX_CAP_LINES ||
      (fileSize ?? 0) > INDEX_READ_BYTES ||
      !measureFetch
    ) {
      setHeightIndex(null);
      return;
    }
    if (buildingRef.current) return;
    buildingRef.current = true;
    let cancelled = false;
    const w = new Int32Array(lineCount);
    (async () => {
      try {
        const CHUNK = 5000;
        for (let s = 0; s < lineCount; s += CHUNK) {
          if (cancelled) return;
          const c = Math.min(CHUNK, lineCount - s);
          const lines = await measureFetch(s, c); // 仅测量,不写入 lineCache
          if (cancelled) return;
          for (const l of lines) {
            const idx = l.line_no - 1;
            w[idx] = l.text ? Math.max(1, measureLines(l.text, availWidth, fontStr)) : 1;
          }
          await new Promise((r) => setTimeout(r, 0));
        }
        const prefix = new Int32Array(lineCount + 1);
        for (let i = 0; i < lineCount; i++) prefix[i + 1] = prefix[i] + w[i];
        if (!cancelled) setHeightIndex({ wraps: w, prefix, lineCount });
      } finally {
        buildingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lineCount, measureFetch, fontStr, availWidth]);

  // ── 逻辑坐标(换行精确)与 DOM 坐标(33M clamp)映射 ──
  const offsetOf = useCallback(
    (line: number): number => {
      // 行逻辑偏移 = prefix[line]×rowHeight(累计折行数) + 前面注释高度
      const base = (heightIndex ? heightIndex.prefix[line] : line) * rowHeight;
      return base + countNotesBefore(line) * NOTE_H;
    },
    [heightIndex, rowHeight, countNotesBefore],
  );
  const calcLogicalH = useCallback((): number => {
    const nc = (() => {
      let c = 0;
      for (const k in marks) if (marks[k]?.note && noteVisible(Number(k))) c++;
      return c;
    })();
    const base = (heightIndex ? heightIndex.prefix[lineCount] : lineCount) * rowHeight;
    return base + nc * NOTE_H;
  }, [heightIndex, lineCount, rowHeight, marks, noteVisible]);
  const domH = (logicalH: number): number => Math.min(logicalH, LIMIT_H);
  const domToS = (st: number, logicalH: number): number => {
    const dh = domH(logicalH);
    if (dh >= logicalH) return st;
    const domMax = Math.max(1, dh - viewportHeight);
    return (st * Math.max(0, logicalH - viewportHeight)) / domMax;
  };
  const sToDom = (s: number, logicalH: number): number => {
    const dh = domH(logicalH);
    if (dh >= logicalH) return s;
    const domMax = Math.max(1, dh - viewportHeight);
    return (s * domMax) / Math.max(1, logicalH - viewportHeight);
  };
  /** 逻辑滚动 px → 行号(0-based);有索引时二分精确 */
  const lineAt = useCallback(
    (s: number): number => {
      if (lineCount === 0) return 0;
      const px = Math.max(0, s);
      if (!heightIndex) {
        return Math.max(0, Math.min(lineCount - 1, Math.floor(px / rowHeight)));
      }
      const wrapTarget = px / rowHeight;
      const p = heightIndex.prefix;
      let lo = 0;
      let hi = lineCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (p[mid] <= wrapTarget) lo = mid + 1;
        else hi = mid;
      }
      let idx = Math.max(0, lo - 1);
      while (idx + 1 < lineCount && offsetOf(idx + 1) <= px) idx++;
      while (idx > 0 && offsetOf(idx) > px) idx--;
      return Math.max(0, Math.min(lineCount - 1, idx));
    },
    [heightIndex, rowHeight, lineCount, offsetOf],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(lineNo0: number) {
        const el = viewportRef.current;
        if (!el) return;
        applyCursor(lineNo0);
        const lh = calcLogicalH();
        const logicalTop = Math.max(
          0,
          offsetOf(lineNo0) + countNotesBefore(lineNo0) * NOTE_H - viewportHeight / 3,
        );
        const top = sToDom(logicalTop, lh);
        el.scrollTop = top;
        setScrollTop(top);
        const half = Math.ceil(viewportHeight / rowHeight) + 10;
        const start = Math.max(0, lineNo0 - half);
        const count = half * 2 + 1;
        void fetchLines(start, count);
        dbg(
          `scrollToLine L=${lineNo0} off=${Math.round(offsetOf(lineNo0))} logicalTop=${Math.round(logicalTop)} top=${Math.round(top)} actual=${Math.round(el.scrollTop)} max=${Math.round(el.scrollHeight - el.clientHeight)} logicalH=${Math.round(lh)} rowH=${rowHeight} lines=${lineCount} viewH=${Math.round(viewportHeight)} idx=${heightIndex ? 1 : 0}`,
        );
        flashAt(lineNo0);
      },
      getFirstLine() {
        return lineAt(domToS(viewportRef.current?.scrollTop ?? 0, calcLogicalH()));
      },
      moveCursor(delta: number) {
        const el = viewportRef.current;
        if (!el) return;
        const next = Math.max(0, Math.min(lineCount - 1, cursorLineRef.current + delta));
        if (next === cursorLineRef.current) return;
        applyCursor(next);
        const lh = calcLogicalH();
        const s = domToS(el.scrollTop, lh);
        const topL = offsetOf(next) + countNotesBefore(next) * NOTE_H;
        if (topL < s) {
          el.scrollTop = sToDom(Math.max(0, topL - rowHeight), lh);
        } else if (topL + rowHeight * 2 > s + viewportHeight) {
          el.scrollTop = sToDom(Math.max(0, topL - viewportHeight + rowHeight * 2), lh);
        }
        setScrollTop(el.scrollTop);
      },
      getCursorLine() {
        return cursorLineRef.current;
      },
    }),
    [viewportHeight, fetchLines, rowHeight, flashAt, countNotesBefore, offsetOf, lineAt, calcLogicalH, domToS, sToDom, lineCount, heightIndex],
  );

  const handleScroll = useCallback(() => {
    setScrollTop(viewportRef.current?.scrollTop ?? 0);
  }, []);

  // 可见范围(逻辑坐标精确换算;DOM clamp 映射后自洽)
  const visibleRange = useMemo(() => {
    if (viewportHeight === 0 || lineCount === 0) return { start: 0, end: 0 };
    const s = domToS(scrollTop, calcLogicalH());
    const start = Math.max(0, lineAt(s) - BUFFER);
    const count = Math.ceil(viewportHeight / rowHeight) + BUFFER * 2;
    const end = Math.min(lineCount, start + count);
    return { start, end };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, viewportHeight, lineCount, rowHeight, lineAt, calcLogicalH]);

  // 拉取缺失行(带预取边距)
  useEffect(() => {
    if (lineCount === 0 || fetchingRef.current) return;
    const EXTRA = Math.ceil(viewportHeight / rowHeight) + BUFFER;
    const fs = Math.max(0, visibleRange.start - EXTRA);
    const fe = Math.min(lineCount, visibleRange.end + EXTRA);
    const missing: number[] = [];
    for (let i = fs; i < fe; i++) {
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
  }, [visibleRange, lineCount, fetchLines, lineCache, viewportHeight, rowHeight]);

  // 渲染可见行
  const rows = useMemo(() => {
    const result: React.ReactNode[] = [];
    const lh = calcLogicalH();
    const st = scrollTop;
    const sLogical = domToS(st, lh);
    let y = Math.max(
      offsetOf(visibleRange.start) + countNotesBefore(visibleRange.start) * NOTE_H - sLogical + st,
      Math.floor(st) - rowHeight,
    );
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const note = marks[i + 1]?.note;
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
      const wraps = heightIndex ? heightIndex.wraps[i] : 1;
      const lineH = (wraps > 0 ? wraps : 1) * rowHeight;
      result.push(
        <div
          key={i}
          className={`log-line${heightIndex ? " wrap" : ""}${i === flashLine ? " flash-line" : ""}${
            activeHitLine != null && i === activeHitLine - 1 ? " hit-line" : ""
          }${i === cursorLine ? " cursor-line" : ""}`}
          style={{
            position: "absolute",
            top: y,
            height: lineH,
            borderLeftColor: markColor,
            backgroundColor: markColor ? `${markColor}22` : undefined,
          }}
          onClick={() => applyCursor(i)}
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
              if (mark?.note) {
                e.stopPropagation();
                toggleNote(i + 1);
              }
            }}
          >
            {mark?.note ? "📝" : ""}
          </span>
          <span className="line-text" title={text}>
            {text
              ? mark?.col != null && mark.len != null
                ? markRangeText(text, mark.col, mark.len, markColor!)
                : ranges
                  ? highlightText(text, ranges, `hl-${i + 1}`)
                  : text
              : ""}
          </span>
        </div>
      );
      y += lineH;
    }
    dbg(
      `render start=${visibleRange.start} end=${visibleRange.end} scrollTop=${Math.round(scrollTop)} y0=${Math.round(y)} logicalH=${Math.round(lh)} idx=${heightIndex ? 1 : 0}`,
    );
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRange, lineCache, highlightMap, marks, pins, onContextMenu, rowHeight, countNotesBefore, noteVisible, activeHitLine, flashLine, cursorLine, heightIndex, calcLogicalH, offsetOf, domToS]);

  return (
    <div className="log-viewport" ref={viewportRef} onScroll={handleScroll}>
      <div className="log-canvas" style={{ height: domH(calcLogicalH()) }}>
        {rows}
      </div>
    </div>
  );
});

export default memo(LogView);
