import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle, memo } from "react";
import { highlightText, byteToCharTables, byteRangeToChars } from "../utils/highlight";
import { measureLines, fontCharWidth } from "../utils/measure";
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
  /** 后端算折行数(cols = 每视觉行可容纳列数):不必把文本拉到前端,大文件索引快一个量级 */
  measureWraps?: (start: number, count: number, cols: number) => Promise<number[]>;
  /** 是否显示备注注释(设置里完全屏蔽) */
  showNotes: boolean;
  /** 当前激活命中行(1-based),渲染 klogg 式光标条 */
  activeHitLine?: number | null;
  /** 全局折叠所有备注注释(状态栏开关;仍可单个点 📝 展开) */
  globalCollapsed: boolean;
  /** 右键备注注释行(复制/编辑/删除菜单) */
  onNoteContextMenu: (lineNo: number, x: number, y: number) => void;
  /** 行光标移动(0-based)时上报,供状态栏显示 */
  onCursorLine?: (line0: number) => void;
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
/** 行高索引重建的防抖:宽度/字号稳定这么久之后才开建 */
const BUILD_DEBOUNCE_MS = 300;
/** Ctrl+滚轮缩放手势的静默窗口:窗口内不动索引(重建一次 1-3s/366 万行,实测) */
const ZOOM_SETTLE_MS = 350;
/** 缩放步进阈值:滚轮事件累积到这个位移才走一步(一次滚轮手势会发几十个事件) */
const ZOOM_STEP_PX = 40;
/** 行高索引成本:内存 = 2×lineCount×4B(wraps+prefix 两个 Int32);构建需读全文件文本一次。
    按"内存预算"与"读盘大小"双维度判定,而不是拍脑袋的行数上限:
    超限则回退固定行高(不折行,不重叠,无乱码),只影响长行折行显示。 */
const INDEX_MEM_BYTES = 128 * 1024 * 1024; // 索引数组 ≤128MB
const INDEX_READ_BYTES = 800 * 1024 * 1024; // 读盘 ≤800MB
const INDEX_CAP_LINES = Math.floor(INDEX_MEM_BYTES / 8); // 8B/行 → 上限行数
/** Chromium 元素高度上限约 33.5M px:超过时 DOM 滚不动(被 clamp)。
    换算全走"逻辑坐标",DOM 只当滚动条 —— 大文件跳转/滚动零空白的关键。 */
const LIMIT_H = 33_000_000;
/** 行块位移拆分量:每 1M px 由精确的布局 top 承担,余量才交给 transform
    (大数值 transform 在 f32 下会丢精度,33M 处 ulp≈4px → 滚动抖动) */
const ROWS_BASE_UNIT = 1_000_000;

/** 每行折行数前缀索引:prefix[l+1] = prefix[l] + wraps[l],可 O(log n) 定位任意行 */
interface HeightIndex {
  wraps: Int32Array;
  prefix: Int32Array;
  lineCount: number;
}

/** 部分标记:col/len 是 **UTF-8 字节偏移**(与搜索命中同一坐标系),
    必须先换算成 UTF-16 码元下标再 slice,否则含 CJK/emoji 的行会切错位置 */
function markRangeText(text: string, col: number, len: number, color: string): React.ReactNode {
  const [s, e] = byteRangeToChars(byteToCharTables(text), col, col + Math.max(0, len));
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
  { lineCount, fileSize, lineCache, highlightMap, marks, pins, followTail, onContextMenu, fetchLines, measureFetch, measureWraps, showNotes, globalCollapsed, onNoteContextMenu, activeHitLine, onCursorLine }: Props,
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);

  // ── 行光标 ──
  const [cursorLine, setCursorLine] = useState(0);
  const cursorLineRef = useRef(0);
  const applyCursor = (n0: number) => {
    cursorLineRef.current = n0;
    setCursorLine(n0);
    onCursorLine?.(n0); // 上报给状态栏显示
  };
  useEffect(() => {
    setCursorLine((c) => Math.max(0, Math.min(c, lineCount - 1)));
  }, [lineCount]);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  /** 行块容器:滚动时**同步**写 transform(不经 React),保证内容与滚动同帧 */
  const rowsRef = useRef<HTMLDivElement>(null);
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
  // 字体测量串:从设置派生,避免每次渲染 getComputedStyle(document.body) 触发布局读取
  const fontSize = useSettings((s) => s.fontSize);
  const fontFamily = useSettings((s) => s.fontFamily);
  const fontStr = `${fontSize}px ${fontFamily}`;
  // 文本可用宽度:由视口宽度(state,ResizeObserver 更新)推得,不再读 clientWidth/innerWidth。
  // 扣除行内固定占位:border-left 3 + padding 16 + 行号 48 + 行号间距 10 + 标记位 18 = 95
  const availWidth = Math.max(60, viewportWidth - 95);
  // 行高索引进度(0..1),构建中用于进度提示;空闲为 null
  const [indexProgress, setIndexProgress] = useState<number | null>(null);

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

  /** 缩放手势静默窗口的截止时刻(performance.now 基准) */
  const zoomUntilRef = useRef(0);

  // Ctrl+滚轮缩放
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // 累积到位才走一步:一次触控板/高频滚轮手势会发几十个事件,逐个改字号
      // 会让每次设置写入都伴随一次整篇重排
      acc += e.deltaY;
      if (Math.abs(acc) < ZOOM_STEP_PX) return;
      const dir = acc < 0 ? 1 : -1; // 上滚放大
      acc = 0;
      const fs = getSettings().fontSize;
      const next = Math.min(16, Math.max(11, fs + dir));
      if (next === fs) return; // 已到上下限:不写设置,避免空转
      // 手势期间不重建行高索引:重建一次 1.2-3.6s(366 万行实测),插在中间必卡
      zoomUntilRef.current = performance.now() + ZOOM_SETTLE_MS;
      setSetting("fontSize", next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const flashAt = useCallback((lineNo0: number) => {
    setFlashLine(lineNo0);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashLine(null), 1600);
  }, []);

  // 可见备注行号(1-based,升序):二分定位,避免 countNotesBefore 每次 O(marks)
  const visibleNoteLines = useMemo(() => {
    const arr: number[] = [];
    for (const k in marks) if (marks[k]?.note && noteVisible(Number(k))) arr.push(Number(k));
    arr.sort((a, b) => a - b);
    return arr;
  }, [marks, noteVisible]);

  const countNotesBefore = useCallback(
    (i0: number) => {
      // 原语义:行号(1-based) line-1 < i0,即 line <= i0;统计可见备注行
      const arr = visibleNoteLines;
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= i0) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [visibleNoteLines],
  );

  // ── 行高索引(换行精确高度,state 驱动 → 位置自动重算,不残留空白)──
  const [heightIndex, setHeightIndex] = useState<HeightIndex | null>(null);
  const buildingRef = useRef(false);
  const buildTimerRef = useRef<number | null>(null);
  // 等宽字体时把可用宽度换算成"每视觉行可容纳列数",交给后端算折行数;
  // 非等宽字体返回 0 → 回退到前端按文本逐个测量。
  const cols = useMemo(() => {
    const cw = fontCharWidth(fontStr);
    return cw > 0 ? Math.max(1, Math.floor(availWidth / cw)) : 0;
  }, [fontStr, availWidth]);
  const useBackendWraps = cols > 0 && !!measureWraps;
  // 构建参数用 Ref 保存,定时回调读最新值(闭包可能持有旧值)。
  // key 用 cols 而非原始像素宽度:宽度微调只要每行容纳列数不变就不重建
  // (实测视口 706→2066px 触发过一次无谓的全量重建,26.6s + 17.7s)。
  const buildKey =
    cols > 0 ? `c${cols}|${lineCount}` : `w${Math.round(availWidth)}|${fontStr}|${lineCount}`;
  const latestKeyRef = useRef("");
  latestKeyRef.current = buildKey;
  /** 当前 heightIndex 是按哪个 key 建出来的(参数变了要清掉,否则行高与当前宽度不匹配) */
  const builtKeyRef = useRef("");
  /** 当前 heightIndex 是按多少列建出来的(判断宽度变化幅度用) */
  const builtColsRef = useRef(0);
  /** heightIndex 的镜像:判断"这次构建是首建还是宽度变化后的重算" */
  const hasIndexRef = useRef(false);
  hasIndexRef.current = heightIndex != null;

  /**
   * 排一轮索引重建:防抖 + 给缩放手势让路。重复调用只保留最后一次 ——
   * 这是"缩放不丝滑"的关键:重建一次 1.2-3.6s(366 万行),手势中间插一次必卡,
   * 而且旧代码在构建结束时会**立刻**再排一轮,连续缩放就成了排队等重建。
   */
  const scheduleBuild = useCallback(() => {
    if (buildTimerRef.current !== null) window.clearTimeout(buildTimerRef.current);
    const zoomLeft = zoomUntilRef.current - performance.now();
    const delay = Math.max(BUILD_DEBOUNCE_MS, zoomLeft + 60);
    buildTimerRef.current = window.setTimeout(() => {
      buildTimerRef.current = null;
      void doBuildRef.current();
    }, delay);
  }, []);

  const doBuild = useCallback(async () => {
    // 防重入;新参数由已完成轮次的 key 比对触发重建
    if (buildingRef.current || (!measureWraps && !measureFetch)) return;
    buildingRef.current = true;
    // 已有索引却重新构建(拖动侧栏/改字号)→ 静默重算:不弹进度条、不清空旧索引,
    // 避免"整体折行展开一下 + 进度条闪现"的观感
    const silent = hasIndexRef.current;
    const key = latestKeyRef.current;
    const w = new Int32Array(lineCount);
    let lastPct = -1;
    const t0 = Date.now();
    try {
      const CHUNK = 5000;
      let done = 0;
      let lastYield = performance.now();
      for (let s = 0; s < lineCount; s += CHUNK) {
        const c = Math.min(CHUNK, lineCount - s);
        if (useBackendWraps && measureWraps) {
          // 后端算折行数:只回传每行一个数字,不传文本(465MB 文件实测省 ~17s)
          const wraps = await measureWraps(s, c, cols);
          for (let k = 0; k < wraps.length; k++) w[s + k] = Math.max(1, wraps[k]);
        } else if (measureFetch) {
          const lines = await measureFetch(s, c); // 仅测量,不写入 lineCache
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const idx = l.line_no - 1;
            w[idx] = l.text ? Math.max(1, measureLines(l.text, availWidth, fontStr)) : 1;
            // 时间预算让出:只在真的阻塞够久时才让出主线程。
            // (固定行数让出会被浏览器 ~4ms 的嵌套定时器下限放大成巨大开销)
            if ((i & 63) === 0 && performance.now() - lastYield > 8) {
              lastYield = performance.now();
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
        done += c;
        // 仅整数百分比变化才 setState,避免大文件每 chunk 都重渲染 LogView;
        // 静默重算(已有索引)不报进度,避免进度条闪现
        if (!silent) {
          const pct = Math.round((done / lineCount) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            setIndexProgress(pct / 100);
          }
        }
      }
      // 兜底:任何未填到的行(如后端命令不可用返回空数组)按 1 个视觉行算,
      // 否则行高会变成 0 导致布局错乱
      for (let i = 0; i < lineCount; i++) if (w[i] < 1) w[i] = 1;
      const prefix = new Int32Array(lineCount + 1);
      for (let i = 0; i < lineCount; i++) prefix[i + 1] = prefix[i] + w[i];
      setHeightIndex({ wraps: w, prefix, lineCount });
      builtKeyRef.current = key;
      builtColsRef.current = cols;
      // 耗时埋点:用于定位"索引构建慢"到底是拉取(IPC)还是测量(CPU)
      dbg(
        `index built lines=${lineCount} ms=${Date.now() - t0} cols=${cols} backend=${useBackendWraps ? 1 : 0} wrapped=${prefix[lineCount] - lineCount}`,
      );
    } finally {
      buildingRef.current = false;
      setIndexProgress(null);
      // 构建期间尺寸/字号/行数已变 → 用最新参数再排一轮。
      // 走 scheduleBuild(防抖 + 让开缩放):连续缩放时不再"构建完立刻接着构建"
      if (latestKeyRef.current !== key) scheduleBuild();
    }
  }, [lineCount, measureFetch, measureWraps, availWidth, fontStr, cols, useBackendWraps, scheduleBuild]);

  const doBuildRef = useRef(doBuild);
  doBuildRef.current = doBuild;

  useEffect(() => {
    if (
      lineCount <= 0 ||
      viewportWidth <= 0 ||
      lineCount > INDEX_CAP_LINES ||
      (fileSize ?? 0) > INDEX_READ_BYTES ||
      (!measureWraps && !measureFetch)
    ) {
      setHeightIndex(null);
      setIndexProgress(null);
      builtKeyRef.current = "";
      return;
    }
    // 宽度/字号/行数变了 → 旧索引的行高不再适用,需重算。处理分两档:
    //  · 宽度**大幅**变化(如 706→2066px):旧行高偏差太大,保留会出现"行高偏高但
    //    文本不折行"的空白观感 → 先清空回统一行高;
    //  · 宽度**小幅**变化(拖动侧栏常见):旧行高近似仍可用 → **保留旧索引静默重算**,
    //    避免"整体折行展开一下 + 进度条闪现"。新索引建好后自动替换。
    if (builtKeyRef.current && builtKeyRef.current !== buildKey) {
      const prev = builtColsRef.current;
      const bigChange =
        cols > 0 && prev > 0 ? cols > prev * 1.5 || cols < prev / 1.5 : true;
      if (bigChange) {
        setHeightIndex(null);
        setIndexProgress(null);
        builtKeyRef.current = "";
        builtColsRef.current = 0;
      }
    }
    // 防抖:宽度/字号稳定后才启动,避免拖动分隔条/缩放触发高频重建
    scheduleBuild();
    return () => {
      if (buildTimerRef.current !== null) {
        window.clearTimeout(buildTimerRef.current);
        buildTimerRef.current = null;
      }
    };
  }, [lineCount, measureFetch, measureWraps, fontStr, availWidth, viewportWidth, fileSize, cols, scheduleBuild]);

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
    const base = (heightIndex ? heightIndex.prefix[lineCount] : lineCount) * rowHeight;
    return base + visibleNoteLines.length * NOTE_H;
  }, [heightIndex, lineCount, rowHeight, visibleNoteLines]);
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

  // 字号/行高变化瞬间保持视口顶部行不变。
  //
  // 未压缩:DOM 位置就是逻辑位置,行高变大要让 scrollTop 跟着放大,同一行才留在视口顶。
  // 压缩后(大文件 33M clamp):映射本身已随 logicalH 缩放,同一 DOM 位置自动对应新行高下
  // 的同一行 —— 再乘一次行高比就成了平方放大。366 万行实测:缩一档会把内容推走约 1.6 万行。
  const prevRowRef = useRef(rowHeight);
  useEffect(() => {
    const prev = prevRowRef.current;
    prevRowRef.current = rowHeight;
    const el = viewportRef.current;
    if (prev === rowHeight || !el) return;
    const lh = calcLogicalH();
    if (domH(lh) < lh) return; // 压缩:什么都不做才是"留在原地"
    el.scrollTop = (el.scrollTop / prev) * rowHeight;
    setScrollTop(el.scrollTop);
  }, [rowHeight, calcLogicalH]);
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
        // 目标行已在视口里就不动:点一条就在眼前的固定/命中行时,整篇内容从鼠标底下
        // 移走(强行落到 1/3 处)是"跳转不自然"的来源。光标框 + flash 已有反馈。
        //
        // 判定必须用**与渲染同一套**的锚定映射:行块内部是 1:1 布局,只在视口顶锚定
        // (rowsShift = offsetOf(start) − domToS(scrollTop) + scrollTop),所以某行在屏幕上
        // 距视口顶的距离 = 逻辑偏移 − domToS(scrollTop)。用 sToDom(...) 比 scrollTop 是
        // 那套整体压缩映射(0→33M 均匀缩放),大文件下会把屏幕外的行判成"可见"→ 点击没反应。
        const viewTopLogical = domToS(el.scrollTop, lh);
        const relTop = offsetOf(lineNo0) - viewTopLogical;
        const relBottom = offsetOf(lineNo0 + 1) - viewTopLogical;
        if (relTop >= 0 && relBottom <= el.clientHeight) {
          flashAt(lineNo0);
          return;
        }
        // offsetOf 已含"上方注释高度",这里不能再加一次(67b58c8 提取 offsetOf 时的重复项)
        const logicalTop = Math.max(0, offsetOf(lineNo0) - viewportHeight / 3);
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
        const topL = offsetOf(next); // 同上:注释高度已含在 offsetOf 里
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

  // 滚动:①同步写行块 transform(不经 React → 与滚动同帧,消除滚轮"掉帧"感);
  // ②再 setScrollTop,让 React 只在可见区间变化时重建行(低频)。
  // 位移用"当前已渲染的行块起点"(visibleRange.start),与 DOM 中的行一一对应。
  const rangeStartRef = useRef(visibleRange.start);
  rangeStartRef.current = visibleRange.start;
  const shiftFnsRef = useRef({ calcLogicalH, offsetOf, countNotesBefore, domToS });
  shiftFnsRef.current = { calcLogicalH, offsetOf, countNotesBefore, domToS };
  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const st = el.scrollTop;
    const rows = rowsRef.current;
    if (rows) {
      const { calcLogicalH: clh, offsetOf: off, countNotesBefore: cnt, domToS: d2s } = shiftFnsRef.current;
      const lh = clh();
      const s = rangeStartRef.current;
      const shift = off(s) + cnt(s) * NOTE_H - d2s(st, lh) + st;
      const base = Math.floor(shift / ROWS_BASE_UNIT) * ROWS_BASE_UNIT;
      const basePx = `${base}px`;
      if (rows.style.top !== basePx) rows.style.top = basePx;
      rows.style.transform = `translateY(${shift - base}px)`;
    }
    setScrollTop(st);
  }, []);

  // 拉取缺失行(带预取边距)
  useEffect(() => {
    if (lineCount === 0 || fetchingRef.current) return;
    // 预取约 2 个视口,降低快速甩动滚动条时的空白窗口
    const EXTRA = Math.ceil(viewportHeight / rowHeight) * 2 + BUFFER;
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
  // 可见行:采用相对 visibleRange.start 的**局部坐标**(不含 scrollTop)。
  // 整体滚动偏移(含大文件 33M 压缩换算)由外层 .log-rows 的单次 transform 承担:
  // 滚动时可见区间不变则 rows 引用不变 → 不重建 JSX、不逐行改 top,消除滚轮掉帧。
  const rows = useMemo(() => {
    const result: React.ReactNode[] = [];
    let y = 0;
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
          className={`log-line${heightIndex ? " wrap" : ""}${pins.has(i + 1) ? " pinned" : ""}${
            i === flashLine ? " flash-line" : ""
          }${activeHitLine != null && i === activeHitLine - 1 ? " hit-line" : ""}${
            i === cursorLine ? " cursor-line" : ""
          }`}
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
              : text == null
                ? <span className="log-skeleton" aria-hidden="true" />
                : ""}
          </span>
        </div>
      );
      y += lineH;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRange, lineCache, highlightMap, marks, pins, onContextMenu, rowHeight, noteVisible, showNotes, activeHitLine, flashLine, cursorLine, heightIndex]);

  // 把局部坐标的行块整体移到正确的屏幕位置(大文件走 33M 压缩映射;非压缩时恒定)。
  // 拆成「布局 top(精确,每 1M px 才变一次)+ transform 余量(每帧变,数值小故 f32 精度足够)」:
  // 单个 33M 量级的 transform 会因 f32 精度(~4px)抖动。
  const logicalH = calcLogicalH();
  // 行块的局部 y 从**首行的注释(若有)顶部**开始,故要减掉它;offsetOf 已含上方注释高度,
  // 再加一次会让内容随"滚出视口的备注条数"逐条下移 16px。
  const startNoteH =
    showNotes && marks[visibleRange.start + 1]?.note && noteVisible(visibleRange.start + 1)
      ? NOTE_H
      : 0;
  const rowsShift =
    offsetOf(visibleRange.start) - startNoteH - domToS(scrollTop, logicalH) + scrollTop;
  const rowsBase = Math.floor(rowsShift / ROWS_BASE_UNIT) * ROWS_BASE_UNIT;
  const rowsResidual = rowsShift - rowsBase;

  return (
    <div className="log-viewport" ref={viewportRef} onScroll={handleScroll}>
      {indexProgress != null && (
        <div
          className="log-index-progress"
          role="progressbar"
          aria-valuenow={Math.round(indexProgress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          建立行高索引… {Math.round(indexProgress * 100)}%
        </div>
      )}
      <div className="log-canvas" style={{ height: domH(logicalH) }}>
        {/* 行块整体位移:滚动时只改这一个元素(布局 top 精确 + 小 transform 走合成层),
            不再逐行改 top(滚轮连续滚动不掉帧的关键) */}
        <div
          className="log-rows"
          ref={rowsRef}
          style={{ top: rowsBase, transform: `translateY(${rowsResidual}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  );
});

export default memo(LogView);
