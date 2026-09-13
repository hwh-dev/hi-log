import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import LogView, { LogViewHandle } from "./components/LogView";
import SearchBar from "./components/SearchBar";
import FilterView, { type FilterViewHandle } from "./components/FilterView";
import Welcome from "./components/Welcome";
import type { Pin, PinGroup } from "./utils/types";
import PinsAggregate, { type FilePinsBlock } from "./components/PinsAggregate";
import NotesPanel, { type FileNotesBlock } from "./components/NotesPanel";
import ContextMenu from "./components/ContextMenu";
import PromptModal, { type PromptConfig } from "./components/PromptModal";
import ConfirmModal from "./components/ConfirmModal";
import SettingsModal from "./components/SettingsModal";
import { registerCommand, initCommandDispatcher } from "./utils/commands";
import type { Update } from "@tauri-apps/plugin-updater";
import type { Mark } from "./utils/palette";
import { buildSearchOpts, sameSearchSpec, type SearchSpec } from "./utils/search";
import {
  getSettings,
  setSetting,
  useSettings,
  resolveTheme,
  systemDarkMQ,
  loadRecentFiles,
  recordRecentFile,
  removeRecentFile,
  saveLastFile,
  loadLastFile,
  clearLastFile,
} from "./utils/settings";

interface FileMeta {
  id: string;
  size: number;
  lines: number;
  encoding: string;
}

interface LinePayload {
  text: string;
  line_no: number;
}

interface HitPayload {
  line_no: number;
  ranges: [number, number][];
  /** 命中行文本(后端随事件下发),前端直接缓存进 lineCache */
  content?: string;
}

/** 后端事件统一带 search_id:过期搜索的残留事件据此丢弃 */
interface SearchChunkPayload {
  search_id: number;
  hits: HitPayload[];
}

interface SearchProgressPayload {
  search_id: number;
  scanned: number;
  total: number;
}

interface SearchDonePayload {
  search_id: number;
  hits: number;
  cancelled: boolean;
  truncated: boolean;
}

/** 一次搜索的完整结果会话(Notepad++ Search Results 风格,多会话并存可对比) */
interface SearchSession extends SearchSpec {
  id: number; // 即后端 search_id
  hitCount: number;
  truncated: boolean;
  /** 该会话的命中高亮(LogView/FilterView 渲染用) */
  highlightMap: HighlightMap;
  running: boolean;
  progress: { scanned: number; total: number } | null;
}

type LineCache = Record<number, string>;
type HighlightMap = Record<number, [number, number][]>;
type MarkMap = Record<number, Mark>;

interface CtxMenuState {
  x: number;
  y: number;
  /** 1-based 行号 */
  lineNo: number;
  /** 右键发生在哪个文件(主 tab 或分屏右栏),菜单数据按此取 */
  fileId: string;
  /** 部分标记:选中文本偏移/长度(有选区单行时) */
  selCol?: number;
  selLen?: number;
  /** 多行选中:起止行(1-based) */
  lineStart?: number;
  lineEnd?: number;
  /** contextmenu 时抓取的选区原文(有选区时存在;菜单点击时 mousedown 已清选区) */
  selText?: string;
}

/** 从当前页面选区提取标记信息:单行选中 → 文本偏移;跨行 → 起止行;均带回选区原文 */
function readSelection(text: string | undefined): { selCol?: number; selLen?: number; lineStart?: number; lineEnd?: number; selText?: string } {
  const sel = window.getSelection();
  const t = sel?.toString() ?? "";
  if (!t) return {};
  const getLineNo = (node: Node | null): number | null => {
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    const logLine = el?.closest(".log-line");
    const noEl = logLine?.querySelector<HTMLElement>(".line-no");
    if (!noEl) return null;
    const n = parseInt(noEl.textContent ?? "", 10);
    return Number.isFinite(n) ? n : null;
  };
  const r = sel?.rangeCount ? sel.getRangeAt(0) : null;
  if (!r) return {};
  const a = getLineNo(r.startContainer);
  const b = getLineNo(r.endContainer);
  if (a != null && b != null && a !== b) {
    return { lineStart: Math.min(a, b), lineEnd: Math.max(a, b), selText: t };
  }
  // 单行:量出选区在行文本内的真实偏移 —— 不能用 text.indexOf(t)(只取首次出现,
  // 同行有重复子串时会标错位置),改用 DOM Range 数出选区前后的字符数。
  if (a != null && text) {
    const precise = selectionByteOffsets(r, text);
    if (precise) return { selCol: precise.col, selLen: precise.len, selText: t };
    const idx = text.indexOf(t);
    if (idx >= 0) {
      // 兜底:拿不到精确 Range(选区跨了行号列等)时退回首次出现,并按字节计
      const enc = new TextEncoder();
      return {
        selCol: enc.encode(text.slice(0, idx)).length,
        selLen: enc.encode(t).length,
        selText: t,
      };
    }
  }
  return {};
}

/** 选区在单行文本内的字节偏移:DOM Range 量字符偏移 → 再换算成 UTF-8 字节
    (col/len 存库与搜索命中共用同一套字节坐标系) */
function selectionByteOffsets(
  range: Range,
  text: string,
): { col: number; len: number } | null {
  const node = range.startContainer;
  const el = (node instanceof Element ? node : node.parentElement)?.closest(".log-line");
  const lineTextEl = el?.querySelector<HTMLElement>(".line-text") ?? null;
  if (!lineTextEl) return null;
  if (!lineTextEl.contains(range.startContainer) || !lineTextEl.contains(range.endContainer)) {
    return null;
  }
  // 从行首量到指定位置:Range.toString() 只取文本,<mark>/<span> 不贡献字符
  const offsetOf = (c: Node, o: number): number => {
    const r = document.createRange();
    r.setStart(lineTextEl, 0);
    r.setEnd(c, o);
    return r.toString().length;
  };
  const s = offsetOf(range.startContainer, range.startOffset);
  const e = offsetOf(range.endContainer, range.endOffset);
  if (!(e > s)) return null;
  const enc = new TextEncoder();
  return {
    col: enc.encode(text.slice(0, s)).length,
    len: enc.encode(text.slice(s, e)).length,
  };
}

const appWindow = getCurrentWindow();
const webviewWindow = getCurrentWebviewWindow();

/** 并存会话上限(超限丢弃最旧;高命中会话各占数十 MB,必须设上限) */
const MAX_SESSIONS = 8;

/** 每个打开文件的完整状态(多文件 workspace:files[fileId]) */
interface FileState {
  meta: FileMeta;
  path: string;
  lineCache: LineCache;
  sessions: SearchSession[];
  /** 该文件当前激活会话 id */
  searchActiveId: number | null;
  marks: MarkMap;
  pinGroups: PinGroup[];
  pins: Pin[];
  pinLines: LineCache;
}

export default function App() {
  // ── 多文件 workspace:files[fileId] 每文件状态,activeFileId 当前激活 ──
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const file = activeFileId ? files[activeFileId] : null;
  // 派生别名(渲染代码沿用原变量名,无需逐处改)
  const fileMeta = file?.meta ?? null;
  const filePath = file?.path ?? "";
  /** 文件摘要由 meta 派生而非存进 statusText —— 否则切 tab 后状态栏还显示上一个文件的行数/大小 */
  const fileSummary = fileMeta
    ? `${fileMeta.lines.toLocaleString()} lines · ${(fileMeta.size / 1024 / 1024).toFixed(1)} MB · ${fileMeta.encoding}`
    : "";
  const lineCache = file?.lineCache ?? {};
  const sessions = file?.sessions ?? [];
  const activeId = file?.searchActiveId ?? null;
  const marks = file?.marks ?? {};
  const pinGroups = file?.pinGroups ?? [];
  const pins = file?.pins ?? [];
  const pinLines = file?.pinLines ?? {};
  /** 固定行号集合(1-based),LogView 书签圆点指示 */
  const pinSet = useMemo(() => new Set(pins.map((p) => p.line_no)), [pins]);

  const [statusText, setStatusText] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);
  /** 欢迎页路径输入框(独立于已打开文件) */
  const [welcomePath, setWelcomePath] = useState("");
  /** 点「+」新增文件时显示欢迎页(已开 tab 保留,点 tab 切回) */
  const [welcomeVisible, setWelcomeVisible] = useState(false);

  // ── theme(设置层管理;状态栏按钮只做快捷切换,可设"跟随系统")──
  const theme = useSettings((s) => s.theme);
  const effectiveTheme = resolveTheme(theme, systemDarkMQ?.matches ?? false);

  // ── search state(全局词/选项;会话/命中存于各 FileState)──
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(() => getSettings().regexDefault);
  const [caseSensitive, setCaseSensitive] = useState(() => getSettings().caseDefault);
  const [wholeWord, setWholeWord] = useState(() => getSettings().wholeWordDefault);
  /** 排除词(NOT):命中的行里再滤掉含它的 */
  const [exclude, setExclude] = useState("");
  /** tail 模式:文件追加自动加载 + 视口跟随 + 激活搜索自动重扫 */
  const [tailMode, setTailMode] = useState(false);
  /** 备注注释:是否显示(设置里完全屏蔽);状态栏按钮是"全局折叠"开关 */
  const showNotes = useSettings((s) => s.showNotes);
  /** 状态栏按钮:全局折叠所有备注注释(仍可单个展开) */
  const [globalCollapsed, setGlobalCollapsed] = useState(false);
  /** 分屏:右栏显示的文件 id(null = 未分屏) */
  const [splitFileId, setSplitFileId] = useState<string | null>(null);
  /** 搜索跳转的当前激活命中行(1-based):文档光标 + 命中列表联动 */
  const [activeHitLine, setActiveHitLine] = useState<number | null>(null);
  /** 命中面板**自己**的光标(1-based)。与上面的文档光标分开:
      用 F6 / 搜索框 ‹› 在正文里继续翻找时,面板光标留在你刚才看的那条结果上,
      不会因为你移动了正文就丢失"刚看到哪条"的参照。 */
  const [filterHitLine, setFilterHitLine] = useState<number | null>(null);
  /** 正文行光标(0-based,-1 = 未定位),仅用于状态栏显示;切文件时复位 */
  const [cursorLine, setCursorLine] = useState(-1);
  // 切文件时两个命中光标都要清掉:它们指向的是上一个文件的命中行,
  // 留着会在新文件的同一行号上画出无意义的光标条。
  useEffect(() => {
    setActiveHitLine(null);
    setFilterHitLine(null);
    setCursorLine(-1);
  }, [activeFileId]);
  const searchIdRef = useRef<number | null>(null);
  /** tail 重搜的被替换会话 id(search_done 后并入并删除新会话) */
  const tailReplaceRef = useRef<number | null>(null);
  /** 当前搜索是否在跑(running 的 ref 镜像,runSearch 幂等判断用) */
  const runningRef = useRef(false);
  /** 最近一次发起的搜索(幂等判断用)。存整份 spec 而不是逐字段的 ref:
      每加一个选项就要多一个 ref、多一处比较,漏一个就会误判为"同一次搜索" */
  const lastSpecRef = useRef<SearchSpec | null>(null);
  // 搜索命中累积缓冲:80ms 节流合并 setState,避免高命中时 O(n) 拷贝撑爆主线程
  const pendingHitsRef = useRef<{ search_id: number; line_no: number; ranges: [number, number][] }[]>([]);
  // 命中行文本缓存缓冲:与高亮/计数一起由 flushHits 合并,避免每 chunk 触发整树重渲染
  const pendingLineCacheRef = useRef<Record<number, string>>({});
  // 搜索进度缓冲:仅保留最新一次,由 flushHits 合并,避免每 progress 事件重渲染
  const pendingProgressRef = useRef<SearchProgressPayload | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  /** 当前搜索归属文件:全局单扫描,事件按此路由到对应的 FileState */
  const searchFileRef = useRef<string | null>(null);

  // 最新快照值镜像(refs):popout 窗口打开时响应 panel_ready 用,
  // 监听只注册一次,避免状态依赖导致重注册窗口期丢事件
  const fileMetaRef = useRef<FileMeta | null>(fileMeta);
  fileMetaRef.current = fileMeta;
  const snapshotRef = useRef({ sessions, activeId });
  snapshotRef.current = { sessions, activeId };
  // 会话列表镜像:selectSession 等稳定回调无需把 sessions 放进依赖
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  /** 弹窗是否打开(ref 镜像;监听闭包据此门控 popout 事件转发,见 openPanel) */
  const popoutOpenRef = useRef<{ filter: boolean; sidebar: boolean }>({
    filter: false,
    sidebar: false,
  });

  // ── 派生:激活会话 / 运行中会话(驱动 LogView 高亮与 SearchBar 状态)──
  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;
  const runningSession = sessions.find((s) => s.running) ?? null;
  const hitCount = activeSession?.hitCount ?? 0;
  const truncated = activeSession?.truncated ?? false;
  const searchRunning = runningSession != null;
  const searchProgress = runningSession?.progress ?? null;
  const activeHighlightMap = activeSession?.highlightMap ?? {};
  const hitLines = useMemo(
    // V8 对整数键按升序迭代,Object.keys 天然有序,无需 sort(高命中时省 O(n log n))
    () => Object.keys(activeHighlightMap).map(Number),
    [activeHighlightMap],
  );
  // 命中行镜像(F6/Shift+F6 跳转用,稳定回调无需把 hitLines 放进依赖)
  const hitLinesRef = useRef(hitLines);
  hitLinesRef.current = hitLines;

  // ── 焦点栏(点击哪栏,搜索就作用于该栏):main=主视图,split=分屏右栏 ──
  const [focusPane, setFocusPane] = useState<"main" | "split">("main");
  const focusFileId = focusPane === "split" && splitFileId ? splitFileId : activeFileId;
  const focusFile = focusFileId ? files[focusFileId] : null;
  const focusSessions = focusFile?.sessions ?? [];
  const focusActiveId = focusFile?.searchActiveId ?? null;
  const focusActiveSession =
    focusSessions.find((s) => s.id === focusActiveId) ?? focusSessions[0] ?? null;
  const focusHitCount = focusActiveSession?.hitCount ?? 0;
  const focusTruncated = focusActiveSession?.truncated ?? false;
  const focusSearchRunning = focusSessions.some((s) => s.running);
  const focusSearchProgress = focusSessions.find((s) => s.running)?.progress ?? null;
  const focusHighlightMap = focusActiveSession?.highlightMap ?? {};
  /** 焦点栏文件的固定行集合:命中面板与主视图都要显示固定标记 */
  const focusPinSet = useMemo(
    () => new Set((focusFile?.pins ?? []).map((p) => p.line_no)),
    [focusFile],
  );
  const focusHitLines = useMemo(
    () => Object.keys(focusHighlightMap).map(Number),
    [focusHighlightMap],
  );
  const focusHitLinesRef = useRef(focusHitLines);
  focusHitLinesRef.current = focusHitLines;

  // ── 结果内二次搜索(filter in results):在当前会话命中行里做子串 AND 过滤,
  // 不用正则。纯前端:搜索时后端已随命中流缓存行文本进 lineCache,故直接按
  // lineCache 过滤即可全量精确。结果为 navLines(导航集,F6/‹› 与展示共用)。
  const [refineQuery, setRefineQuery] = useState("");
  // 切换会话/切换文件时清空二次搜索(行号与旧内容不再对应)
  const prevRefineSessionRef = useRef<number | null>(null);
  useEffect(() => {
    const focusActive = focusActiveId;
    if (prevRefineSessionRef.current !== focusActive) {
      prevRefineSessionRef.current = focusActive;
      setRefineQuery("");
    }
  }, [focusActiveId, activeFileId, splitFileId]);
  const refineActive = refineQuery.trim().length > 0;
  /** 二搜后的命中间导航列表(F6/‹› 与 FilterView 展示共用) */
  const focusNavLines = useMemo(() => {
    if (!refineActive) return focusHitLines;
    const q = refineQuery.trim().toLowerCase();
    const lc = focusFile?.lineCache ?? {};
    return focusHitLines.filter((ln) => (lc[ln - 1] ?? "").toLowerCase().includes(q));
  }, [refineActive, refineQuery, focusHitLines, focusFile?.lineCache]);
  const focusNavLinesRef = useRef(focusNavLines);
  focusNavLinesRef.current = focusNavLines;
  /** 焦点栏会话数镜像(Ctrl+F 唤起 refine 的稳定判断,避免高频重注册命令) */
  const focusSessionsLenRef = useRef(focusSessions.length);
  focusSessionsLenRef.current = focusSessions.length;
  /** Ctrl+F 唤起 refine:若面板刚被展开(FilterView 未挂载),挂载后再唤起 */
  const refineOpenPendingRef = useRef(false);
  // 面板挂载/可见后补唤起 refine(Ctrl+F 时面板可能刚从隐藏展开,FilterView 未挂载)
  useEffect(() => {
    if (refineOpenPendingRef.current && filterViewRef.current) {
      filterViewRef.current.openRefine();
      refineOpenPendingRef.current = false;
    }
  });

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  /** 备注注释行右键菜单(复制/编辑/删除);fileId 标记所在文件 */
  const [noteCtx, setNoteCtx] = useState<{ lineNo: number; x: number; y: number; fileId: string } | null>(null);
  /** tab 右键菜单(VS Code 式:拆分编辑器/关闭) */
  const [tabCtx, setTabCtx] = useState<{ fileId: string; x: number; y: number } | null>(null);
  /** 自绘输入弹窗(备注/命名等,替换原生 prompt) */
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null);
  /** 自绘确认弹窗(自动更新,替换原生 confirm) */
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  /** files 镜像(监听闭包遍历所有打开文件用,避免重注册效果) */
  const filesRef = useRef(files);
  filesRef.current = files;

  /** 不可变更新某文件状态(多文件核心 helper) */
  const mutateFile = useCallback((fileId: string, fn: (cur: FileState) => FileState) => {
    setFiles((prev) => {
      const cur = prev[fileId];
      if (!cur) return prev;
      return { ...prev, [fileId]: fn(cur) };
    });
  }, []);

  /** 更新"搜索归属文件"的会话(事件/后台路由用:searchFileRef 记录发起文件) */
  const mutateSearchSessions = useCallback(
    (fn: (sessions: SearchSession[]) => SearchSession[]) => {
      const fileId = searchFileRef.current;
      if (!fileId) return;
      mutateFile(fileId, (cur) => ({ ...cur, sessions: fn(cur.sessions) }));
    },
    [mutateFile],
  );
  const setSearchActiveId = useCallback(
    (id: number | null) => {
      const fileId = searchFileRef.current;
      if (!fileId) return;
      mutateFile(fileId, (cur) => ({ ...cur, searchActiveId: id }));
    },
    [mutateFile],
  );

  const logViewRef = useRef<LogViewHandle>(null);
  /** 搜索输入框引用(Ctrl+F 聚焦用) */
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** 分屏右栏 LogView 引用(独立滚动) */
  const splitLogRef = useRef<LogViewHandle>(null);
  /** 焦点栏的 LogView ref(搜索命中跳转滚到对应栏) */
  const focusLogRef = focusPane === "split" ? splitLogRef : logViewRef;
  /** FILTER 命中面板 ref(Ctrl+F 唤出"结果内过滤"用) */
  const filterViewRef = useRef<FilterViewHandle>(null);

  // ── 侧栏聚合数据(所有打开文件的固定/注释,按打开顺序)──
  // 仅当固定/注释/分组/固定文案真正变化时(contentRev)才重算;搜索/滚动只改 lineCache/sessions,
  // 不触发重算 —— 避免搜索期间侧栏聚合面板随 80ms flush 反复全量重渲染。
  const [contentRev, setContentRev] = useState(0);
  const pinAggFiles = useMemo<FilePinsBlock[]>(
    () =>
      Object.entries(filesRef.current).map(([fid, f]) => ({
        fileId: fid,
        path: f.path,
        groups: f.pinGroups,
        pins: f.pins,
        lineText: f.pinLines,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentRev],
  );
  const notesAggFiles = useMemo<FileNotesBlock[]>(
    () =>
      Object.entries(filesRef.current).map(([fid, f]) => ({
        fileId: fid,
        path: f.path,
        items: Object.entries(f.marks)
          .filter(([, m]) => m.note)
          .map(([ln, m]) => ({ lineNo: Number(ln), note: m.note as string }))
          .sort((a, b) => a.lineNo - b.lineNo),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentRev],
  );

  // 侧栏聚合点击跳转:目标=当前文件直接滚;否则先切 tab(done 兜底轮询)
  const pendingJumpRef = useRef<{ fileId: string; line0: number } | null>(null);
  const jumpToFileLine = useCallback(
    (fileId: string, line0: number) => {
      // 目标文件在右栏(分屏)→ 跳右栏,不动主 tab
      if (fileId === splitFileId) {
        splitLogRef.current?.scrollToLine(line0);
        return;
      }
      if (fileId === activeFileId) {
        logViewRef.current?.scrollToLine(line0);
        return;
      }
      setActiveFileId(fileId);
      setStatusText("");
      pendingJumpRef.current = { fileId, line0 };
    },
    [activeFileId, splitFileId],
  );
  useEffect(() => {
    if (pendingJumpRef.current?.fileId === activeFileId) {
      logViewRef.current?.scrollToLine(pendingJumpRef.current.line0);
      pendingJumpRef.current = null;
    }
  }, [activeFileId]);

  // 稳定引用(useCallback):LogView 已 memo,内联箭头会让 memo 失效
  // 主/右栏各自带 fileId 的右键回调:菜单数据按"所在栏文件"取;
  // 同时读取当前选区(有选中文本 → 标记该部分/多行)
  const mainCtxMenu = useCallback(
    (lineNo: number, x: number, y: number) => {
      if (!fileMeta) return;
      const text = filesRef.current[fileMeta.id]?.lineCache[lineNo - 1];
      setCtxMenu({ lineNo, x, y, fileId: fileMeta.id, ...readSelection(text) });
    },
    [fileMeta],
  );
  const splitCtxMenu = useCallback(
    (lineNo: number, x: number, y: number) => {
      if (!splitFileId) return;
      const text = filesRef.current[splitFileId]?.lineCache[lineNo - 1];
      setCtxMenu({ lineNo, x, y, fileId: splitFileId, ...readSelection(text) });
    },
    [splitFileId],
  );

  // ── 面板尺寸(拖拽调整,设置层持久化;静默写不广播)──
  const filterHeight = useSettings((s) => s.filterHeight);
  const sidebarWidth = useSettings((s) => s.sidebarWidth);
  const sidebarSections = useSettings((s) => s.sidebarSections);
  /** 侧栏区段头一键切换:按文件分节 ⇄ 合并 */
  const togglePinsView = useCallback(
    () => setSetting("sidebarSections", { ...sidebarSections, pinsByFile: !sidebarSections.pinsByFile }),
    [sidebarSections],
  );
  const toggleNotesView = useCallback(
    () => setSetting("sidebarSections", { ...sidebarSections, notesByFile: !sidebarSections.notesByFile }),
    [sidebarSections],
  );
  const filterHeightRef = useRef(filterHeight);
  filterHeightRef.current = filterHeight;
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  // ── 面板显示控制 ──
  const [filterHidden, setFilterHidden] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [popoutOpen, setPopoutOpen] = useState<{ filter: boolean; sidebar: boolean }>({
    filter: false,
    sidebar: false,
  });
  popoutOpenRef.current = popoutOpen;
  /** 设置弹窗(标题栏 ⚙ / Ctrl+K 打开) */
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 拖拽分隔条调整面板尺寸;双击复位
  const startResize = useCallback(
    (e: React.PointerEvent, kind: "height" | "width") => {
      e.preventDefault();
      const startPos = kind === "height" ? e.clientY : e.clientX;
      const startVal = kind === "height" ? filterHeightRef.current : sidebarWidthRef.current;
      const onMove = (ev: PointerEvent) => {
        if (kind === "height") {
          // 向上拖(顶部边框上移) → 面板变高
          const h = Math.min(
            Math.max(startVal + (startPos - ev.clientY), 60),
            Math.round(window.innerHeight * 0.7),
          );
          setSetting("filterHeight", h, { silent: true });
        } else {
          const w = Math.min(Math.max(startVal + (ev.clientX - startPos), 160), 480);
          setSetting("sidebarWidth", w, { silent: true });
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  // 打开/聚焦独立面板窗口(搜索命中 / 快照+标记)
  const openPanel = useCallback((kind: "filter" | "sidebar") => {
    // 先同步置 ref(事件门控立即生效,避免 invoke 与渲染之间的转发空洞)
    popoutOpenRef.current = { ...popoutOpenRef.current, [kind]: true };
    void (async () => {
      await invoke("open_panel", { kind });
      setPopoutOpen((p) => ({ ...p, [kind]: true }));
      // 侧栏弹出:主窗口侧栏收起(内容移至独立窗口,避免两处重复)
      if (kind === "sidebar") setSidebarVisible(false);
      // 打开即重发完整快照:Linux 弹窗是新窗口(初始状态靠快照),
      // Windows 是常驻隐藏窗口(关闭期间错过的事件由快照补齐)
      if (kind === "filter") {
        const meta = fileMetaRef.current;
        if (meta) {
          const snap = snapshotRef.current;
          void appWindow
            .emitTo("filter-popout", "filter_snapshot", {
              fileId: meta.id,
              lines: meta.lines,
              sessions: snap.sessions,
              activeId: snap.activeId,
            })
            .catch(() => {});
        }
      }
      if (kind === "sidebar") {
        // 发全部打开文件概览:Windows 常驻弹窗挂载时主窗口可能尚未打开文件,
        // panel_ready 的 sidebar_snapshot 被跳过;此处补齐,弹窗据此加载聚合
        const overview = Object.entries(filesRef.current).map(([fid, f]) => ({
          fileId: fid,
          path: f.path,
        }));
        if (overview.length > 0) {
          void appWindow
            .emitTo("sidebar-popout", "sidebar_snapshot", { files: overview, activeFileId })
            .catch(() => {});
        }
      }
    })();
  }, [activeFileId]);

  // 弹窗窗口销毁(原生关闭)→ 恢复主窗口内嵌面板。
  // 不用 onCloseRequested:JS 监听会让关闭被包装器接管走 destroy() invoke,
  // 在 WebView2 异常环境下销毁会卡死整个应用;原生关闭 + Rust 广播更稳。
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    listen<string>("panel_closed", (e) => {
      const kind =
        e.payload === "filter-popout" ? "filter" : e.payload === "sidebar-popout" ? "sidebar" : null;
      if (kind) {
        popoutOpenRef.current = { ...popoutOpenRef.current, [kind]: false };
        setPopoutOpen((p) => ({ ...p, [kind]: false }));
        // 侧栏弹窗关闭:主窗口侧栏恢复内嵌
        if (kind === "sidebar") setSidebarVisible(true);
      }
    }).then((fn) => unlisteners.push(fn));
    return () => {
      for (const fn of unlisteners) fn();
    };
  }, []);

  const loadMarks = useCallback(
    async (fileId: string) => {
      try {
        const list = await invoke<Mark[]>("list_marks", { fileId });
        const map: MarkMap = {};
        for (const m of list) map[m.line_no] = m;
        mutateFile(fileId, (cur) => ({ ...cur, marks: map }));
        setContentRev((r) => r + 1); // 备注内容变化 → 侧栏注释聚合需重算
      } catch (e) {
        console.error("list_marks failed", e);
      }
    },
    [mutateFile],
  );

  // ── 固定(pin)数据加载与操作 ──

  const loadPins = useCallback(
    async (fileId: string) => {
      try {
        const data = await invoke<{ groups: PinGroup[]; pins: Pin[] }>("list_pins", { fileId });
        mutateFile(fileId, (cur) => ({
          ...cur,
          pinGroups: data.groups,
          pins: data.pins,
          pinLines: {},
        }));
        setContentRev((r) => r + 1); // 固定列表变化 → 侧栏固定聚合需重算
        // 拉取固定行的文本,供面板展示内容预览
        const lineNos = data.pins.map((p) => p.line_no);
        const groups2: [number, number][] = [];
        for (const n of lineNos) {
          if (groups2.length === 0 || n !== groups2[groups2.length - 1][0] + groups2[groups2.length - 1][1]) {
            groups2.push([n, 1]);
          } else {
            groups2[groups2.length - 1][1]++;
          }
        }
        for (const [start, count] of groups2) {
          invoke<LinePayload[]>("get_lines", { fileId, start: start - 1, count })
            .then((lines) => {
              mutateFile(fileId, (cur) => {
                const next = { ...cur.pinLines };
                for (const l of lines) next[l.line_no] = l.text;
                return { ...cur, pinLines: next };
              });
              setContentRev((r) => r + 1); // 固定文案填充 → 聚合预览更新
            })
            .catch((e) => console.error("get_lines failed", e));
        }
      } catch (e) {
        console.error("list_pins failed", e);
      }
    },
    [mutateFile],
  );

  /** 固定/取消固定:一次点击零输入(默认组+无名称;改名去侧栏 hover) */
  const pinLineAction = useCallback((fileId: string, lineNo: number) => {
    setCtxMenu(null);
    void invoke("add_pin", { fileId, lineNo, groupId: null, name: "" }).catch((e) =>
      console.error("add_pin failed", e),
    );
  }, []);

  const unpinAction = useCallback(async (pinId: number) => {
    await invoke("remove_pin", { pinId }).catch((e) => console.error("remove_pin failed", e));
  }, []);

  /** 删除指定文件某行的注释(仅清备注,保留颜色标记)—— 侧栏注释项用 */
  const clearNoteAction = useCallback((fileId: string, lineNo: number) => {
    const m = filesRef.current[fileId]?.marks[lineNo];
    if (!m) return;
    void invoke("add_mark", { fileId, lineNo, color: m.color, note: "" }).catch((e) =>
      console.error("clear note failed", e),
    );
  }, []);

  const renamePinAction = useCallback((pinId: number) => {
    // pinId 全局唯一,跨文件查找名称(右键可能发生在右栏)
    let current = "";
    for (const fid of Object.keys(filesRef.current)) {
      const p = filesRef.current[fid].pins.find((x) => x.id === pinId);
      if (p) {
        current = p.name ?? "";
        break;
      }
    }
    setCtxMenu(null);
    setPromptCfg({
      title: "重命名固定",
      initial: current,
      placeholder: "固定名称(可留空)",
      okLabel: "保存",
      onSubmit: (name) => {
        void invoke("rename_pin", { pinId, name }).catch((e) =>
          console.error("rename_pin failed", e),
        );
      },
    });
  }, []);

  /** 手动拖拽重排:ids 为新顺序。UI 已撤销分组,固定全部在默认组,取首个 pin 的组 id */
  /** 拖拽重排:ids 的顺序即新顺序。不再需要猜 group_id(分组已废弃) */
  const reorderPinsAction = useCallback((fileId: string, ids: number[]) => {
    void invoke("reorder_pins", { fileId, ids }).catch((e) =>
      console.error("reorder_pins failed", e),
    );
  }, []);

  // 侧栏固定面板稳定回调(memo 化 PinsAggregate 需要;fileId 由聚合层传入,这里忽略)
  const pinsUnpin = useCallback((_fid: string, pinId: number) => void unpinAction(pinId), [unpinAction]);
  const pinsRename = useCallback((_fid: string, pinId: number) => renamePinAction(pinId), [renamePinAction]);

  /** 打开文件(统一入口:透传编码设置;openFile 与 tail 重开共用,避免两处漂移) */
  const openWithEncoding = useCallback(async (path: string): Promise<FileMeta> => {
    return await invoke<FileMeta>("open_file", { path, forceEncoding: getSettings().encoding });
  }, []);

  const openFile = useCallback(
    async (path?: string): Promise<boolean> => {
      const target = (path ?? welcomePath).trim();
      if (!target) return false;
      setStatusText("Opening…");
      try {
        // 已是打开的文件:直接切到该 tab(保留其会话/标记)
        if (files[target]) {
          setActiveFileId(target);
          setWelcomeVisible(false);
          setStatusText("");
          return true;
        }
        const meta = await openWithEncoding(target);
        setFiles((prev) => ({
          ...prev,
          [target]: {
            meta,
            path: target,
            lineCache: {},
            sessions: [],
            searchActiveId: null,
            marks: {},
            pinGroups: [],
            pins: [],
            pinLines: {},
          },
        }));
        setActiveFileId(target);
        setWelcomeVisible(false);
        void loadMarks(target);
        void loadPins(target);
        setStatusText(""); // 清掉 "Opening…",摘要由 fileSummary 派生显示
        saveLastFile(target);
        setRecentFiles(recordRecentFile(target));
        // 设置项"打开时自动进入 tail"
        if (getSettings().openTailMode) setTailMode(true);
        return true;
      } catch (e) {
        setStatusText(`Error: ${e}`);
        console.error(e);
        return false;
      }
    },
    [welcomePath, openWithEncoding, files],
  );

  // 启动时自动打开上次关闭的文件(设置项可关);文件已不存在则清除记录,显示开始页
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (!getSettings().restoreLastFile) return;
    const last = loadLastFile();
    if (!last) return;
    void openFile(last).then((ok) => {
      if (!ok) clearLastFile();
    });
  }, [openFile]);

  // 启动 3 秒后静默检查更新(设置项可关);未配置更新服务器/离线/未签名时静默失败
  useEffect(() => {
    if (!getSettings().checkUpdateOnStart) return;
    const t = window.setTimeout(() => {
      void import("@tauri-apps/plugin-updater")
        .then(async ({ check }) => {
          const update = await check();
          if (update) setPendingUpdate(update); // 弹自绘确认框,用户确认后才下载
        })
        .catch((e) => console.debug("update check skipped:", e));
    }, 3000);
    return () => window.clearTimeout(t);
  }, []);

  // 把缓冲中的命中一次性合并进对应会话(搜索结束后立即落盘)
  const flushHits = useCallback(() => {
    flushTimerRef.current = null;
    const batch = pendingHitsRef.current;
    pendingHitsRef.current = [];
    const cachePatch = pendingLineCacheRef.current;
    pendingLineCacheRef.current = {};
    const progress = pendingProgressRef.current;
    pendingProgressRef.current = null;
    const hasCache = Object.keys(cachePatch).length > 0;
    if (batch.length === 0 && !hasCache && !progress) return;
    // 按会话分组合并高亮(一次 setState 批量更新全部受影响会话)
    const bySid = new Map<number, { line_no: number; ranges: [number, number][] }[]>();
    for (const h of batch) {
      const list = bySid.get(h.search_id);
      if (list) list.push(h);
      else bySid.set(h.search_id, [h]);
    }
    // 命中写入发起搜索的文件(全局单扫描,searchFileRef 即归属文件);
    // lineCache/进度/计数一并合并,避免搜索期间整棵 App 每个 chunk 重渲染
    const fileId = searchFileRef.current;
    if (!fileId) return;
    mutateFile(fileId, (cur) => {
      let lineCache = cur.lineCache;
      if (hasCache) lineCache = { ...lineCache, ...cachePatch };
      return {
        ...cur,
        lineCache,
        sessions: cur.sessions.map((s) => {
          const hits = bySid.get(s.id);
          let next = s;
          if (hits) {
            const hm = { ...s.highlightMap };
            for (const h of hits) hm[h.line_no] = h.ranges;
            next = { ...s, highlightMap: hm, hitCount: s.hitCount + hits.length };
          }
          if (progress && progress.search_id === s.id) next = { ...next, progress };
          return next;
        }),
      };
    });
  }, [mutateFile]);

  /** 关闭指定文件 tab(缺省当前):驱逐后端文档,切相邻 tab */
  const closeFile = useCallback(
    (fileId?: string) => {
      const fid = fileId ?? activeFileId;
      if (!fid) return;
      // 若关闭的是搜索发起文件,先停扫描
      if (searchFileRef.current === fid && searchIdRef.current !== null) {
        void invoke("stop_search", { searchId: searchIdRef.current }).catch(() => {});
        searchIdRef.current = null;
        searchFileRef.current = null;
        runningRef.current = false;
        if (flushTimerRef.current !== null) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        pendingHitsRef.current = [];
        pendingLineCacheRef.current = {};
        pendingProgressRef.current = null;
      }
      setFiles((prev) => {
        const next = { ...prev };
        delete next[fid];
        return next;
      });
      void invoke("close_file", { fileId: fid }).catch(() => {});
      setActiveFileId((cur) => {
        if (cur !== fid) return cur;
        const rest = Object.keys(files).filter((k) => k !== fid);
        return rest.length ? rest[rest.length - 1] : null;
      });
      setCtxMenu(null);
      setStatusText("");
    },
    [activeFileId, files],
  );

  // ── 快捷键命令注册(命令系统;现有按钮/调用点保留,命令是补充触发路径)──

  /** Ctrl+O:系统文件选择器(与欢迎页浏览按钮同配置) */
  const openFileDialog = useCallback(async () => {
    try {
      const picked = await open({
        // 指定父窗口:否则对话框可能出现在应用背后,造成"点了没反应+应用像卡死"
        parent: getCurrentWindow(),
        title: "选择日志文件",
        multiple: false,
        directory: false,
        filters: [
          { name: "日志文件", extensions: ["log", "txt", "out", "err"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string" && picked) void openFile(picked);
    } catch (e) {
      console.error("dialog open failed", e);
    }
  }, [openFile]);

  /** 跳转到下一个/上一个命中(相对当前视口首行;F6 / Shift+F6)
   * 二搜激活时沿二次命中导航;否则沿会话全部命中 */
  const jumpToHit = useCallback(
    (dir: 1 | -1): number | null => {
      // 基于焦点栏的命中列表与视口,跳转到焦点栏
      const lines = focusNavLinesRef.current;
      const ref = focusLogRef.current;
      if (lines.length === 0 || !ref) return null;
      const first = ref.getFirstLine() ?? 0; // 0-based 视口首行
      // 下一个:视口下方第一个命中;没有则回到第一个(上一个同理取最后一条)
      const target =
        dir === 1
          ? lines.find((l) => l - 1 > first) ?? lines[0]
          : [...lines].reverse().find((l) => l - 1 < first) ?? lines[lines.length - 1];
      ref.scrollToLine(target - 1);
      // 只动**正文**光标;面板光标有自己的状态(见 filterHitLine),不跟着跑。
      // 首次跳转时给面板光标做个初始化,避免面板一开始就没有光标。
      setActiveHitLine(target);
      setFilterHitLine((cur) => (cur == null ? target : cur));
      return target;
    },
    [focusLogRef],
  );

  // ↑/↓ 移动行光标(klogg 焦点框);输入框/弹窗内不响应
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (document.querySelector(".modal-overlay") !== null) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      focusLogRef.current?.moveCursor(e.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusLogRef]);

  useEffect(() => {
    const un: Array<() => void> = [];
    un.push(registerCommand("openSettings", () => setSettingsOpen(true)));
    un.push(
      registerCommand("toggleTheme", () =>
        setSetting("theme", effectiveTheme === "dark" ? "light" : "dark"),
      ),
    );
    un.push(registerCommand("toggleTail", () => setTailMode((t) => !t)));
    un.push(
      registerCommand("focusSearch", () => {
        // 有搜索结果 → Ctrl+F 唤起"结果内过滤"(klogg 式);否则聚焦底栏搜索框
        if (focusSessionsLenRef.current > 0) {
          // 确保面板可见(隐藏时先展开,挂载后再唤起 refine)
          setFilterHidden(false);
          setPopoutOpen((p) => ({ ...p, filter: false }));
          refineOpenPendingRef.current = true;
          filterViewRef.current?.openRefine();
        } else {
          searchInputRef.current?.focus();
        }
      }),
    );
    un.push(registerCommand("openFile", () => void openFileDialog()));
    un.push(registerCommand("closeFile", closeFile));
    un.push(
      registerCommand("gotoLine", () => {
        if (!fileMeta) return;
        setPromptCfg({
          title: "跳转到行",
          hint: `范围 1-${fileMeta.lines.toLocaleString()}`,
          placeholder: "输入行号",
          okLabel: "跳转",
          initial: String((logViewRef.current?.getFirstLine() ?? 0) + 1),
          onSubmit: (v) => {
            const n = Number(v.trim());
            if (Number.isFinite(n) && n >= 1) {
              logViewRef.current?.scrollToLine(Math.min(Math.floor(n), fileMeta.lines) - 1);
            }
          },
        });
      }),
    );
    un.push(
      registerCommand("toggleFilterPanel", () => {
        // 可见 → 折叠;不可见 → 展开(若已弹出独立窗口,收回内嵌)
        if (filterHidden || popoutOpenRef.current.filter) {
          setFilterHidden(false);
          setPopoutOpen((p) => ({ ...p, filter: false }));
        } else {
          setFilterHidden(true);
        }
      }),
    );
    un.push(registerCommand("toggleSidebar", () => setSidebarVisible((v) => !v)));
    un.push(registerCommand("nextHit", () => jumpToHit(1)));
    un.push(registerCommand("prevHit", () => jumpToHit(-1)));
    un.push(
      registerCommand("zoomIn", () =>
        setSetting("fontSize", Math.min(16, getSettings().fontSize + 1)),
      ),
    );
    un.push(
      registerCommand("zoomOut", () =>
        setSetting("fontSize", Math.max(11, getSettings().fontSize - 1)),
      ),
    );
    un.push(registerCommand("resetZoom", () => setSetting("fontSize", 13)));
    initCommandDispatcher();
    return () => {
      for (const f of un) f();
    };
  }, [effectiveTheme, closeFile, openFileDialog, jumpToHit, filterHidden, fileMeta]);

  // ── run search ──
  const runSearch = useCallback(
    async (spec: SearchSpec) => {
      // 搜索作用于焦点栏文件(点击哪栏搜哪栏)
      const fid = focusFileId;
      if (!fid) return;
      const fileSessions = filesRef.current[fid]?.sessions ?? [];
      // 同一查询已在跑:幂等跳过。否则每次 Enter 都会启动一次全新全量扫描,
      // 旧扫描线程继续发事件,造成计数虚高与 N 倍扫描耗时。
      if (runningRef.current && lastSpecRef.current && sameSearchSpec(spec, lastSpecRef.current)) {
        return;
      }
      // 停止上一次搜索
      if (searchIdRef.current !== null) {
        await invoke("stop_search", { searchId: searchIdRef.current }).catch(() => {});
      }
      if (!spec.query.trim()) return; // 空查询不清会话,保留已有结果便于对比
      tailReplaceRef.current = null; // 手动搜索取消待处理的 tail 替换
      runningRef.current = true;
      lastSpecRef.current = spec;
      const clean: SearchSpec = { ...spec, exclude: spec.exclude.trim() };
      try {
        // 记录搜索归属文件:事件(chunk/progress/done)按此路由到对应 FileState
        searchFileRef.current = fid;
        const id = await invoke<number>("start_search", {
          fileId: fid,
          query: clean.query,
          opts: buildSearchOpts(clean),
        });
        searchIdRef.current = id;
        // 相同检索式(词 + 四个选项全一致)的既有会话:复用刷新,而非新建。
        // 避免"搜了 INFO 又搜 INFO"无限开新窗口 —— 重复同词应刷新原结果。
        const reuse = fileSessions.find((s) => !s.running && sameSearchSpec(s, clean));

        if (reuse) {
          // 把该会话重置为 running 态:清空旧命中并换上新 search_id,位置不变
          mutateSearchSessions((prev) =>
            prev.map((s) =>
              s.id === reuse.id
                ? { ...s, id, running: true, hitCount: 0, truncated: false, highlightMap: {}, progress: null }
                : s,
            ),
          );
        } else {
          // 新会话置顶(Notepad++ 风格:每次新词一个新会话,旧结果保留可对比)
          mutateSearchSessions((prev) =>
            [
              {
                id,
                ...clean,
                hitCount: 0,
                truncated: false,
                highlightMap: {},
                running: true,
                progress: null,
              },
              ...prev,
            ].slice(0, MAX_SESSIONS),
          );
        }
        setSearchActiveId(id);
        // 通知命中弹窗:新搜索会话(词/选项一并带上);未打开不转发
        if (popoutOpenRef.current.filter) {
          void appWindow
            .emitTo("filter-popout", "search_started", { search_id: id, ...clean })
            .catch(() => {});
        }
      } catch (e) {
        runningRef.current = false;
        // 以前只 console.error:文件未打开/正则非法时用户只看到"点了搜索没反应"
        setStatusText(`搜索启动失败:${e}`);
        console.error("start_search failed", e);
      }
    },
    [focusFileId, mutateSearchSessions, setSearchActiveId],
  );

  // 手动触发搜索:回车或点按钮(不做打字即搜)
  const doSearch = useCallback(() => {
    void runSearch({ query, regex, caseSensitive, wholeWord, exclude });
  }, [query, regex, caseSensitive, wholeWord, exclude, runSearch]);

  // 应用搜索历史条目:恢复其选项并立即搜索
  const applyQuery = useCallback(
    (spec: SearchSpec) => {
      setQuery(spec.query);
      setRegex(spec.regex);
      setCaseSensitive(spec.caseSensitive);
      setWholeWord(spec.wholeWord);
      setExclude(spec.exclude);
      void runSearch(spec);
    },
    [runSearch],
  );

  // ── listen search events ──
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen<SearchChunkPayload>("search_chunk", (e) => {
      // 过期搜索的残留事件:丢弃,否则计数与高亮会被叠加污染
      if (e.payload.search_id !== searchIdRef.current) return;
      const sid = e.payload.search_id;
      const hits = e.payload.hits;
      // 命中计数/高亮/行文本全部先缓冲,由 flushHits 在 80ms 内一次合并:
      // 避免每个 chunk 都 setFiles 触发整棵 App + 子组件重渲染
      pendingHitsRef.current.push(
        ...hits.map((h) => ({ search_id: sid, line_no: h.line_no, ranges: h.ranges })),
      );
      // 命中行文本随事件缓存进 lineCache:命中面板滚动零 IPC(延迟到 flushHits 写入)
      for (const h of hits) if (h.content) pendingLineCacheRef.current[h.line_no - 1] = h.content;
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushHits, 80);
      }
      // 转发给独立命中窗口(仅打开时;常驻隐藏窗口收事件是 Linux 卡顿根源之一)
      if (popoutOpenRef.current.filter) {
        void appWindow.emitTo("filter-popout", "search_chunk_fwd", e.payload).catch(() => {});
      }
    }).then((fn) => unlisteners.push(fn));

    listen<SearchProgressPayload>("search_progress", (e) => {
      if (e.payload.search_id !== searchIdRef.current) return;
      // 仅保留最新一次进度,由 flushHits 合并,避免每个 progress 事件重渲染整树
      pendingProgressRef.current = e.payload;
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushHits, 80);
      }
      if (popoutOpenRef.current.filter) {
        void appWindow.emitTo("filter-popout", "search_progress_fwd", e.payload).catch(() => {});
      }
    }).then((fn) => unlisteners.push(fn));

    listen<SearchDonePayload>("search_done", (e) => {
      if (e.payload.search_id !== searchIdRef.current) return;
      const sid = e.payload.search_id;
      // 结束前把残余缓冲立即合并,保证最终高亮完整
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushHits();
      // tail 重扫:把新会话的数据并入被替换会话并删除自身(会话 id 保持稳定)
      if (tailReplaceRef.current !== null) {
        const targetId = tailReplaceRef.current;
        tailReplaceRef.current = null;
        mutateSearchSessions((prev) => {
          const done = prev.find((x) => x.id === sid);
          if (!done) return prev;
          return prev
            .map((x) =>
              x.id === targetId
                ? { ...done, id: targetId, running: false, progress: null }
                : x,
            )
            .filter((x) => x.id !== sid);
        });
        runningRef.current = false;
        if (popoutOpenRef.current.filter) {
          void appWindow.emitTo("filter-popout", "search_done_fwd", e.payload).catch(() => {});
        }
        return;
      }
      // 以后端权威计数为准:本地累加可能混入过期搜索的残留事件而虚高
      mutateSearchSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? {
                ...s,
                hitCount: e.payload.hits,
                truncated: e.payload.truncated,
                running: false,
                progress: null,
              }
            : s,
        ),
      );
      runningRef.current = false;
      if (popoutOpenRef.current.filter) {
        void appWindow.emitTo("filter-popout", "search_done_fwd", e.payload).catch(() => {});
      }
    }).then((fn) => unlisteners.push(fn));

    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [flushHits, mutateSearchSessions]);

  // ── marks / pins:后端任何变更都会广播,重拉所有打开文件(侧栏聚合同步)──
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    listen("marks_changed", () => {
      for (const fid of Object.keys(filesRef.current)) void loadMarks(fid);
    }).then((fn) => unlisteners.push(fn));
    listen("pins_changed", () => {
      for (const fid of Object.keys(filesRef.current)) void loadPins(fid);
    }).then((fn) => unlisteners.push(fn));
    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [loadMarks, loadPins]);

  // ── CLI 单实例: `hi-log <file>` 从终端/文件关联转发的打开请求 ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("cli_open", (e) => {
      void openFile(e.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [openFile]);

  // ── 会话操作(多结果并存)──

  /** 切换激活会话:搜索栏联动显示该会话的查询词与选项 */
  const selectSession = useCallback(
    (id: number) => {
      const fid = focusFileId;
      if (!fid) return;
      const target = filesRef.current[fid]?.sessions.find((s) => s.id === id);
      if (target) {
        setQuery(target.query);
        setRegex(target.regex);
        setCaseSensitive(target.caseSensitive);
        setWholeWord(target.wholeWord);
        setExclude(target.exclude);
      }
      mutateFile(fid, (cur) => ({ ...cur, searchActiveId: id }));
      // 换会话 = 换结果集,两个光标都指向旧结果集的行,一并清掉
      setActiveHitLine(null);
      setFilterHitLine(null);
      if (popoutOpenRef.current.filter) {
        void appWindow.emitTo("filter-popout", "session_active_fwd", { search_id: id }).catch(() => {});
      }
    },
    [focusFileId, mutateFile],
  );

  /** 关闭单个会话;正在跑的会话一并停止后端扫描 */
  const closeSession = useCallback(
    (id: number) => {
      const fid = focusFileId;
      if (!fid) return;
      const target = filesRef.current[fid]?.sessions.find((s) => s.id === id);
      if (target?.running) {
        void invoke("stop_search", { searchId: id }).catch(() => {});
      }
      mutateFile(fid, (cur) => ({
        ...cur,
        sessions: cur.sessions.filter((s) => s.id !== id),
        searchActiveId: cur.searchActiveId === id ? null : cur.searchActiveId,
      }));
      if (popoutOpenRef.current.filter) {
        void appWindow.emitTo("filter-popout", "session_close_fwd", { search_id: id }).catch(() => {});
      }
    },
    [focusFileId, mutateFile],
  );

  /** 清空全部会话 */
  const clearSessions = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingHitsRef.current = [];
    const fid = focusFileId;
    if (!fid) return;
    for (const s of filesRef.current[fid]?.sessions ?? []) {
      if (s.running) void invoke("stop_search", { searchId: s.id }).catch(() => {});
    }
    mutateFile(fid, (cur) => ({ ...cur, sessions: [], searchActiveId: null }));
    searchIdRef.current = null;
    runningRef.current = false;
    setActiveHitLine(null);
    setFilterHitLine(null);
    if (popoutOpenRef.current.filter) {
      void appWindow.emitTo("filter-popout", "sessions_clear_fwd", {}).catch(() => {});
    }
  }, [focusFileId, mutateFile]);

  // ── 独立面板窗口(popout)桥接 ──
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    // popout 挂载后请求快照 → 回发当前搜索状态 / 文件信息
    listen<{ kind: string }>("panel_ready", (e) => {
      if (e.payload.kind === "filter") {
        const meta = fileMetaRef.current;
        if (!meta) return;
        const snap = snapshotRef.current;
        void appWindow
          .emitTo("filter-popout", "filter_snapshot", {
            fileId: meta.id,
            lines: meta.lines,
            sessions: snap.sessions,
            activeId: snap.activeId,
          })
          .catch(() => {});
      } else if (e.payload.kind === "sidebar") {
        // 弹窗挂载:发全部打开文件概览(聚合渲染数据源)
        const overview = Object.entries(filesRef.current).map(([fid, f]) => ({
          fileId: fid,
          path: f.path,
        }));
        if (overview.length > 0) {
          void appWindow
            .emitTo("sidebar-popout", "sidebar_snapshot", { files: overview, activeFileId })
            .catch(() => {});
        }
      }
    }).then((fn) => unlisteners.push(fn));

    // 弹窗聚合点击:跨文件跳转(切 tab + 滚动)+ 聚焦
    listen<{ fileId: string; line0: number }>("goto_file_line", (e) => {
      // 与侧栏聚合同一套逻辑:右栏文件跳右栏,否则切主 tab
      jumpToFileLine(e.payload.fileId, e.payload.line0);
      void appWindow.setFocus();
    }).then((fn) => unlisteners.push(fn));

    // popout 点击命中行/标记 → 主视图跳转并聚焦
    listen<number>("goto_line", (e) => {
      logViewRef.current?.scrollToLine(e.payload);
      void appWindow.setFocus();
    }).then((fn) => unlisteners.push(fn));

    // popout 内点击会话 chip → 统一激活状态(搜索栏联动,再广播回 popout)
    listen<{ search_id: number }>("panel_session_activate", (e) => {
      const target = filesRef.current[focusFileId ?? ""]?.sessions.find(
        (s) => s.id === e.payload.search_id,
      );
      if (target) {
        setQuery(target.query);
        setRegex(target.regex);
        setCaseSensitive(target.caseSensitive);
        setWholeWord(target.wholeWord);
        setExclude(target.exclude);
      }
      if (focusFileId)
        mutateFile(focusFileId, (cur) => ({ ...cur, searchActiveId: e.payload.search_id }));
      if (popoutOpenRef.current.filter) {
        void appWindow
          .emitTo("filter-popout", "session_active_fwd", { search_id: e.payload.search_id })
          .catch(() => {});
      }
    }).then((fn) => unlisteners.push(fn));

    // popout 内关闭会话/清空 → 主窗口执行(状态统一后广播回 popout)
    listen<{ search_id: number }>("panel_session_close", (e) => {
      closeSession(e.payload.search_id);
    }).then((fn) => unlisteners.push(fn));

    listen("panel_sessions_clear", () => {
      clearSessions();
    }).then((fn) => unlisteners.push(fn));

    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [closeSession, clearSessions, activeFileId, focusFileId, mutateFile, jumpToFileLine]);

  // ── mark actions ──
  const addMarkAction = useCallback(
    async (fileId: string, lineNo: number, color: number, col?: number, len?: number) => {
      // col/len 存在 → 部分标记(选中文本区间);否则整行
      await invoke("add_mark", { fileId, lineNo, color, col: col ?? null, len: len ?? null }).catch(
        (e) => console.error("add_mark failed", e),
      );
    },
    [],
  );

  /** 多行批量标记(默认蓝):逐行整行标记 */
  const markRangeAction = useCallback((fileId: string, start: number, end: number) => {
    for (let ln = start; ln <= end; ln++) {
      void invoke("add_mark", { fileId, lineNo: ln, color: 4, col: null, len: null }).catch((e) =>
        console.error("mark range failed", e),
      );
    }
  }, []);

  // 复制文本:WebView2 下 navigator.clipboard 可能缺安全上下文,用 execCommand 兜底
  const copyText = (t: string) => {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* 忽略失败 */
    }
    document.body.removeChild(ta);
  };

  const addNoteAction = useCallback(
    (fileId: string, lineNo: number, color: number) => {
      const current = filesRef.current[fileId]?.marks[lineNo]?.note ?? "";
      setCtxMenu(null);
      setPromptCfg({
        title: `第 ${lineNo} 行备注`,
        hint: current ? "修改备注" : "新备注",
        initial: current,
        multiline: true,
        placeholder: "输入备注,可留空",
        okLabel: "保存",
        onSubmit: (note) => {
          void invoke("add_mark", { fileId, lineNo, color, note }).catch((e) =>
            console.error("add_mark failed", e),
          );
        },
      });
    },
    [],
  );

  const removeMarkAction = useCallback(async (markId: number) => {
    await invoke("remove_mark", { markId }).catch((e) => console.error("remove_mark failed", e));
  }, []);

  // ── drag & drop file open ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    webviewWindow
      .onDragDropEvent((event) => {
        const t = event.payload.type;
        if (t === "enter" || t === "over") {
          setDropActive(true);
        } else if (t === "leave") {
          setDropActive(false);
        } else if (t === "drop") {
          setDropActive(false);
          // 拖入多个文件时全部打开(以前只取第一个,其余静默丢弃)
          for (const p of event.payload.paths ?? []) void openFile(p);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [openFile]);

  // ── tail 模式:轮询文件大小,追加后重开文件 + 重扫激活会话 ──

  /** 用激活会话的词/选项重新搜索,完成后替换该会话(不产生新会话) */
  const tailRefresh = useCallback(async () => {
    const meta = fileMetaRef.current;
    if (!meta) return;
    const s =
      sessionsRef.current.find((x) => x.id === activeIdRef.current) ?? sessionsRef.current[0];
    if (!s || s.running) return;
    try {
      const id = await invoke<number>("start_search", {
        fileId: meta.id,
        query: s.query,
        opts: buildSearchOpts(s),
      });
      searchIdRef.current = id;
      tailReplaceRef.current = s.id;
    } catch (e) {
      console.error("tail re-search failed", e);
    }
  }, []);

  const tailPollMs = useSettings((s) => s.tailPollMs);
  useEffect(() => {
    if (!tailMode || !fileMeta) return;
    const timer = window.setInterval(async () => {
      const meta = fileMetaRef.current;
      if (!meta) return;
      try {
        const size = await invoke<number>("file_size", { path: meta.id });
        if (size > meta.size) {
          // 重新打开:新 mmap + 重建索引(页缓存命中,代价≈读新增部分);
          // 透传编码设置,避免强制编码被悄悄拉回自动
          const newMeta = await openWithEncoding(meta.id);
          mutateFile(meta.id, (cur) => ({ ...cur, meta: newMeta }));
          if (newMeta.lines > meta.lines) {
            void tailRefresh();
          }
        }
      } catch {
        // 文件被删除/暂时不可读,下轮重试
      }
    }, tailPollMs);
    return () => window.clearInterval(timer);
  }, [tailMode, fileMeta, tailRefresh, tailPollMs, openWithEncoding]);

  const fetchLines = useCallback(
    async (start: number, count: number) => {
      if (!fileMeta) return [];
      try {
        const lines = await invoke<LinePayload[]>("get_lines", {
          fileId: fileMeta.id,
          start,
          count,
        });
        mutateFile(fileMeta.id, (cur) => {
          const next = { ...cur.lineCache };
          for (const l of lines) {
            next[l.line_no - 1] = l.text;
          }
          return { ...cur, lineCache: next };
        });
        return lines;
      } catch (e) {
        console.error("get_lines failed", e);
        return [];
      }
    },
    [fileMeta, mutateFile],
  );

  /** 分屏右栏的行拉取(作用于 splitFileId,独立于主视图) */
  const splitFetchLines = useCallback(
    async (start: number, count: number) => {
      if (!splitFileId) return [];
      try {
        const lines = await invoke<LinePayload[]>("get_lines", { fileId: splitFileId, start, count });
        mutateFile(splitFileId, (cur) => {
          const next = { ...cur.lineCache };
          for (const l of lines) next[l.line_no - 1] = l.text;
          return { ...cur, lineCache: next };
        });
        return lines;
      } catch (e) {
        console.error("split get_lines failed", e);
        return [];
      }
    },
    [splitFileId, mutateFile],
  );

  /** 焦点栏文件的行拉取(FilterView 命中面板用;主/右随焦点) */
  const focusFetchLines = useCallback(
    async (start: number, count: number) => {
      if (!focusFileId) return [];
      try {
        const lines = await invoke<LinePayload[]>("get_lines", { fileId: focusFileId, start, count });
        mutateFile(focusFileId, (cur) => {
          const next = { ...cur.lineCache };
          for (const l of lines) next[l.line_no - 1] = l.text;
          return { ...cur, lineCache: next };
        });
        return lines;
      } catch (e) {
        console.error("focus get_lines failed", e);
        return [];
      }
    },
    [focusFileId, mutateFile],
  );

  /** 行高索引测量用:仅拉取文本,不写入 lineCache(避免大文件缓存膨胀) */
  const measureFetch = useCallback(
    async (start: number, count: number) => {
      if (!fileMeta) return [];
      try {
        return await invoke<LinePayload[]>("get_lines", { fileId: fileMeta.id, start, count });
      } catch (e) {
        console.error("measure get_lines failed", e);
        return [];
      }
    },
    [fileMeta],
  );
  /** 行高索引(等宽字体):后端直接算折行数,只回传每行一个数字,不传文本 */
  const measureWraps = useCallback(
    async (start: number, count: number, cols: number) => {
      if (!fileMeta) return [];
      try {
        return await invoke<number[]>("measure_wraps", { fileId: fileMeta.id, start, count, cols });
      } catch (e) {
        console.error("measure_wraps failed", e);
        return [];
      }
    },
    [fileMeta],
  );
  const splitMeasureWraps = useCallback(
    async (start: number, count: number, cols: number) => {
      if (!splitFileId) return [];
      try {
        return await invoke<number[]>("measure_wraps", { fileId: splitFileId, start, count, cols });
      } catch (e) {
        console.error("split measure_wraps failed", e);
        return [];
      }
    },
    [splitFileId],
  );
  const splitMeasureFetch = useCallback(
    async (start: number, count: number) => {
      if (!splitFileId) return [];
      try {
        return await invoke<LinePayload[]>("get_lines", { fileId: splitFileId, start, count });
      } catch (e) {
        console.error("split measure get_lines failed", e);
        return [];
      }
    },
    [splitFileId],
  );

  // ── 分屏派生:右栏文件状态(与主视图独立渲染,数据共享)──
  const splitFile = splitFileId ? files[splitFileId] : null;
  const splitActiveSession = splitFile
    ? (splitFile.sessions.find((s) => s.id === splitFile.searchActiveId) ?? splitFile.sessions[0] ?? null)
    : null;
  const splitHighlightMap = splitActiveSession?.highlightMap ?? {};
  const splitPinSet = useMemo(
    () => new Set((splitFile?.pins ?? []).map((p) => p.line_no)),
    [splitFile],
  );

  const stopSearch = useCallback(() => {
    if (searchIdRef.current !== null) {
      void invoke("stop_search", { searchId: searchIdRef.current }).catch(() => {});
    }
    runningRef.current = false;
  }, []);

  /** 导出激活会话的命中行到文本文件:后端重扫(前端缓存只有看过的行,导出必然残缺) */
  const exportHitsAction = useCallback(
    async (s: SearchSession) => {
      const fid = focusFileId;
      if (!fid) return;
      const base = (fid.split(/[/\\]/).pop() ?? "hits").replace(/\.[^.]+$/, "");
      let dest: string | null = null;
      try {
        dest = await save({
          defaultPath: `${base}-hits.txt`,
          filters: [{ name: "文本", extensions: ["txt", "log"] }],
        });
      } catch {
        return; // 用户取消或对话框不可用
      }
      if (!dest) return;
      setStatusText("导出中…");
      try {
        const n = await invoke<number>("export_hits", {
          fileId: fid,
          query: s.query,
          opts: buildSearchOpts(s),
          path: dest,
          context: getSettings().contextLines,
        });
        setStatusText(`已导出 ${n.toLocaleString()} 条命中 → ${dest}`);
      } catch (e) {
        setStatusText(`导出失败:${e}`);
        console.error("export_hits failed", e);
      }
    },
    [focusFileId],
  );

  // FilterView 稳定回调(memo 化命中面板需要,避免内联箭头致 memo 失效)
  /** 点命中面板某条结果:正文滚过去,并把**两处光标**都设到这条
      (这是显式"去看这条",两处应当一致;而正文里 F6/‹› 翻找时只动正文光标) */
  const filterJump = useCallback(
    (l: number) => {
      if (focusPane === "split") splitLogRef.current?.scrollToLine(l);
      else logViewRef.current?.scrollToLine(l);
      setActiveHitLine(l + 1);
      setFilterHitLine(l + 1);
    },
    [focusPane],
  );
  const filterCtx = useCallback(
    (lineNo: number, x: number, y: number) => {
      if (focusFileId) setCtxMenu({ lineNo, x, y, fileId: focusFileId });
    },
    [focusFileId],
  );
  const filterPopout = useCallback(() => openPanel("filter"), [openPanel]);
  const filterCollapse = useCallback(() => setFilterHidden(true), []);
  // 面板内的 ‹› 属于"面板自己的导航":正文光标跟着走,面板光标也更新到同一条
  const filterRefinePrev = useCallback(() => {
    const t = jumpToHit(-1);
    if (t != null) setFilterHitLine(t);
  }, [jumpToHit]);
  const filterRefineNext = useCallback(() => {
    const t = jumpToHit(1);
    if (t != null) setFilterHitLine(t);
  }, [jumpToHit]);

  return (
    <div className={`app ${dropActive ? "app-dropping" : ""}`}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="title">hi-log</span>
        <button
          className="titlebar-btn"
          title="设置 (Ctrl+K)"
          onClick={() => setSettingsOpen(true)}
        >
          设置
        </button>
        <div className="win-controls">
          <button onClick={() => appWindow.minimize()} aria-label="minimize">─</button>
          <button onClick={() => appWindow.toggleMaximize()} aria-label="maximize">□</button>
          <button className="close" onClick={() => appWindow.close()} aria-label="close">×</button>
        </div>
      </div>

      {fileMeta && (
        <div className="tabbar">
          {Object.values(files).map((f) => (
            <div
              key={f.meta.id}
              className={`tab ${f.meta.id === activeFileId ? "active" : ""}`}
              title={f.path}
              onClick={() => {
                setActiveFileId(f.meta.id);
                setWelcomeVisible(false);
                setStatusText(""); // 清掉上一个文件的提示(如 Error),摘要随 meta 重新派生
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabCtx({ fileId: f.meta.id, x: e.clientX, y: e.clientY });
              }}
              onAuxClick={(e) => {
                // 中键关闭(浏览器/编辑器通例)
                if (e.button === 1) {
                  e.preventDefault();
                  closeFile(f.meta.id);
                }
              }}
            >
              <span className="tab-name">{f.path.split(/[/\\]/).pop()}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeFile(f.meta.id);
                }}
                aria-label="close file"
              >
                ×
              </button>
            </div>
          ))}
          {welcomeVisible && (
            <div
              className="tab active"
              title="欢迎页"
              onClick={() => setWelcomeVisible(true)}
            >
              <span className="tab-name">欢迎</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setWelcomeVisible(false);
                }}
                aria-label="close welcome"
              >
                ×
              </button>
            </div>
          )}
          <button
            className="tab tab-new"
            onClick={() => setWelcomeVisible(true)}
            aria-label="open file"
            title="新增文件(欢迎页选择/输入路径)"
          >
            +
          </button>
          <span className="tabbar-spacer" />
          <button
            className={`tab sidebar-toggle ${sidebarVisible ? "active" : ""}`}
            onClick={() => setSidebarVisible((v) => !v)}
            title="显示/隐藏侧栏(快照+固定+注释)"
          >
            侧栏
          </button>
        </div>
      )}

      {!fileMeta || welcomeVisible ? (
        <Welcome
          filePath={welcomePath}
          setFilePath={setWelcomePath}
          onOpen={() => openFile()}
          onOpenPath={(p) => openFile(p)}
          dropActive={dropActive}
          recentFiles={recentFiles}
          onRemoveRecent={(p) => setRecentFiles(removeRecentFile(p))}
        />
      ) : (
        <>
          <div className="main-area">
            <div
              className="workspace"
              onPointerDown={() => setFocusPane("main")}   // 点击主区 = 焦点主栏
            >
              {sidebarVisible && (
                <>
                  <div className="sidebar" style={{ width: sidebarWidth }}>
                    <div className="sidebar-toolbar">
                      <span className="sidebar-toolbar-title">面板</span>
                      <button
                        className="panel-btn"
                        onClick={() => openPanel("sidebar")}
                        title="弹出为独立窗口"
                      >
                        ↗
                      </button>
                    </div>
                    {sidebarSections.pins && (
                      <PinsAggregate
                        files={pinAggFiles}
                        activeFileId={activeFileId}
                        onJump={jumpToFileLine}
                        byFile={sidebarSections.pinsByFile}
                        onToggleView={togglePinsView}
                        onUnpin={pinsUnpin}
                        onRenamePin={pinsRename}
                        onReorder={reorderPinsAction}
                      />
                    )}
                    {sidebarSections.notes && (
                      <NotesPanel
                        files={notesAggFiles}
                        activeFileId={activeFileId}
                        onJump={jumpToFileLine}
                        byFile={sidebarSections.notesByFile}
                        onToggleView={toggleNotesView}
                        onDeleteNote={clearNoteAction}
                      />
                    )}
                  </div>
                  <div
                    className="sidebar-resizer"
                    onPointerDown={(e) => startResize(e, "width")}
                    onDoubleClick={() => setSetting("sidebarWidth", 230, { silent: true })}
                    title="拖动调整宽度,双击复位"
                  />
                </>
              )}
              <LogView
                ref={logViewRef}
                lineCount={fileMeta.lines}
                fileSize={fileMeta.size}
                lineCache={lineCache}
                highlightMap={activeHighlightMap}
                marks={marks}
                pins={pinSet}
                followTail={tailMode}
                showNotes={showNotes}
                globalCollapsed={globalCollapsed}
                onNoteContextMenu={(lineNo, x, y) => setNoteCtx({ lineNo, x, y, fileId: fileMeta.id })}
                onContextMenu={mainCtxMenu}
                fetchLines={fetchLines}
                measureFetch={measureFetch}
                measureWraps={measureWraps}
                activeHitLine={focusPane === "main" ? activeHitLine : null}
                onCursorLine={setCursorLine}
              />
              {splitFileId && splitFile && (
                <>
                  <div className="split-resizer" />
                  <div
                    className={`split-pane${focusPane === "split" ? " focused" : ""}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setFocusPane("split"); // 点击右栏 = 焦点右栏
                    }}
                  >
                    <div className="split-header">
                      <span className="split-file" title={splitFile.path}>
                        {splitFile.path.split(/[/\\]/).pop()}
                      </span>
                      <span className="split-spacer" />
                      <button
                        className="split-close"
                        title="关闭分屏"
                        onClick={() => setSplitFileId(null)}
                      >
                        ×
                      </button>
                    </div>
                    <LogView
                      ref={splitLogRef}
                      lineCount={splitFile.meta.lines}
                      fileSize={splitFile.meta.size}
                      lineCache={splitFile.lineCache}
                      highlightMap={splitHighlightMap}
                      marks={splitFile.marks}
                      pins={splitPinSet}
                      followTail={false}
                      showNotes={showNotes}
                      globalCollapsed={globalCollapsed}
                      onNoteContextMenu={(lineNo, x, y) => setNoteCtx({ lineNo, x, y, fileId: splitFileId })}
                      onContextMenu={splitCtxMenu}
                      fetchLines={splitFetchLines}
                      measureFetch={splitMeasureFetch}
                      measureWraps={splitMeasureWraps}
                      activeHitLine={focusPane === "split" ? activeHitLine : null}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
          {/* 有会话即显示命中面板(0 命中也可见,便于对比/清理) */}
          {focusSessions.length > 0 && !filterHidden && !popoutOpen.filter && (
            <>
              <div
                className="filter-resizer"
                onPointerDown={(e) => startResize(e, "height")}
                onDoubleClick={() => setSetting("filterHeight", 220, { silent: true })}
                title="拖动调整高度,双击复位"
              />
              <FilterView
                sessions={focusSessions}
                activeId={focusActiveId}
                onSelectSession={selectSession}
                onCloseSession={closeSession}
                onClearSessions={clearSessions}
                lineCache={focusFile?.lineCache ?? {}}
                highlightMap={focusHighlightMap}
                marks={focusFile?.marks ?? {}}
                pins={focusPinSet}
                fetchLines={focusFetchLines}
                onJump={filterJump}
                onContextMenu={filterCtx}
                hitCount={focusHitCount}
                truncated={focusTruncated}
                height={filterHeight}
                lineCount={focusFile?.meta.lines ?? 0}
                onPopout={filterPopout}
                activeHitLine={filterHitLine}
                onCollapse={filterCollapse}
                refineActive={refineActive}
                refineQuery={refineQuery}
                setRefineQuery={setRefineQuery}
                refineLines={focusNavLines}
                ref={filterViewRef}
                onRefinePrev={filterRefinePrev}
                onRefineNext={filterRefineNext}
                onExport={exportHitsAction}
              />
            </>
          )}
          <SearchBar
            query={query}
            setQuery={setQuery}
            regex={regex}
            setRegex={setRegex}
            caseSensitive={caseSensitive}
            setCaseSensitive={setCaseSensitive}
            wholeWord={wholeWord}
            setWholeWord={setWholeWord}
            exclude={exclude}
            setExclude={setExclude}
            running={focusSearchRunning}
            onSearch={doSearch}
            onStop={stopSearch}
            onApplyQuery={applyQuery}
            inputRef={searchInputRef}
            hitCount={focusHitCount}
            truncated={focusTruncated}
            progress={focusSearchProgress}
            hasHits={focusHitCount > 0}
            onPrevHit={() => jumpToHit(-1)}
            onNextHit={() => jumpToHit(1)}
            filterVisible={focusSessions.length > 0 && !filterHidden && !popoutOpen.filter}
            onToggleFilter={() => {
              // 可见 → 折叠;不可见 → 展开(若已弹出独立窗口,收回内嵌)
              if (filterHidden || popoutOpen.filter) {
                setFilterHidden(false);
                setPopoutOpen((p) => ({ ...p, filter: false }));
              } else {
                setFilterHidden(true);
              }
            }}
          />
        </>
      )}

      {ctxMenu && (() => {
        // 菜单数据按"右键所在文件"取(主 tab 或分屏右栏)
        const ctxFile = files[ctxMenu.fileId] ?? null;
        const ctxMarks = ctxFile?.marks ?? {};
        const ctxPins = ctxFile?.pins ?? [];
        const ctxMark = ctxMarks[ctxMenu.lineNo] ?? null;
        const pinned = ctxPins.find((p) => p.line_no === ctxMenu.lineNo) ?? null;
        return (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            lineNo={ctxMenu.lineNo}
            mark={ctxMark}
            // 有选区(单行)→ 标记选中部分(col/len);否则整行
            onMark={(c) =>
              void addMarkAction(
                ctxMenu.fileId,
                ctxMenu.lineNo,
                c,
                ctxMenu.selCol,
                ctxMenu.selLen,
              )
            }
            onMarkRange={
              ctxMenu.lineStart != null && ctxMenu.lineEnd != null
                ? () => {
                    markRangeAction(ctxMenu.fileId, ctxMenu.lineStart!, ctxMenu.lineEnd!);
                    setCtxMenu(null);
                  }
                : undefined
            }
            onCopy={
              ctxMenu.selText
                ? () => {
                    copyText(ctxMenu.selText!);
                    setCtxMenu(null);
                  }
                : undefined
            }
            onCopyLine={() => {
              copyText(ctxFile?.lineCache[ctxMenu.lineNo] ?? "");
              setCtxMenu(null);
            }}
            onNote={() => void addNoteAction(ctxMenu.fileId, ctxMenu.lineNo, ctxMark?.color ?? 0)}
            onClear={() => {
              if (ctxMark) void removeMarkAction(ctxMark.id);
            }}
            pinned={!!pinned}
            onTogglePin={
              pinned
                ? () => void unpinAction(pinned.id)
                : () => pinLineAction(ctxMenu.fileId, ctxMenu.lineNo)
            }
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}

      {noteCtx && (() => {
        const m = files[noteCtx.fileId]?.marks[noteCtx.lineNo] ?? null;
        return (
          <div
            className="ctx-backdrop"
            onClick={() => setNoteCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setNoteCtx(null);
            }}
          >
            <div
              className="ctx-menu"
              style={{ left: noteCtx.x, top: noteCtx.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ctx-title">第 {noteCtx.lineNo} 行备注</div>
              <button
                className="ctx-item"
                onClick={() => {
                  copyText(m?.note ?? "");
                  setNoteCtx(null);
                }}
              >
                复制备注
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  addNoteAction(noteCtx.fileId, noteCtx.lineNo, m?.color ?? 0);
                  setNoteCtx(null);
                }}
              >
                编辑备注…
              </button>
              <button
                className="ctx-item danger"
                onClick={() => {
                  // 删除注释:仅清空备注文本,保留颜色标记(add_mark 为 upsert,note 置空)
                  if (m) {
                    void invoke("add_mark", {
                      fileId: noteCtx.fileId,
                      lineNo: noteCtx.lineNo,
                      color: m.color,
                      note: "",
                    }).catch((e) => console.error("clear note failed", e));
                  }
                  setNoteCtx(null);
                }}
              >
                删除注释
              </button>
            </div>
          </div>
        );
      })()}

      {tabCtx && (
        <div
          className="ctx-backdrop"
          onClick={() => setTabCtx(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabCtx(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: tabCtx.x, top: tabCtx.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">{tabCtx.fileId.split(/[/\\]/).pop()}</div>
            <button
              className="ctx-item"
              onClick={() => {
                setSplitFileId(tabCtx.fileId);
                setTabCtx(null);
              }}
            >
              拆分编辑器{tabCtx.fileId === splitFileId ? "(已在右栏)" : ""}
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                copyText(tabCtx.fileId);
                setTabCtx(null);
              }}
            >
              复制文件路径
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                // 关闭除当前 tab 外的全部;欢迎页 tab 不动
                for (const id of Object.keys(filesRef.current)) {
                  if (id !== tabCtx.fileId) closeFile(id);
                }
                setActiveFileId(tabCtx.fileId);
                setTabCtx(null);
              }}
            >
              关闭其他
            </button>
            <button
              className="ctx-item danger"
              onClick={() => {
                closeFile(tabCtx.fileId);
                setTabCtx(null);
              }}
            >
              关闭
            </button>
            <button
              className="ctx-item danger"
              onClick={() => {
                for (const id of Object.keys(filesRef.current)) closeFile(id);
                // closeFile 逐个切换 active 时会读到过期的 files,兜底显式置空回到欢迎页
                setActiveFileId(null);
                setWelcomeVisible(true);
                setTabCtx(null);
              }}
            >
              全部关闭
            </button>
          </div>
        </div>
      )}

      {promptCfg && <PromptModal {...promptCfg} onClose={() => setPromptCfg(null)} />}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {pendingUpdate && (
        <ConfirmModal
          title="发现新版本"
          message={`hi-log ${pendingUpdate.version} 已可用,是否下载并安装?`}
          okLabel="下载并安装"
          cancelLabel="稍后"
          onConfirm={() => {
            const u = pendingUpdate;
            setPendingUpdate(null);
            void (async () => {
              try {
                await u.downloadAndInstall();
              } catch (e) {
                console.error("update install failed", e);
              }
            })();
          }}
          onClose={() => setPendingUpdate(null)}
        />
      )}

      {/* 状态栏常驻:以前被 fileMeta 门控,导致"打开失败/搜索失败"写进 statusText 后
          整块不渲染,错误被彻底吞掉,用户只看到"点了没反应"。 */}
      <div className="statusbar">
        <span className="status-file" title={filePath}>{filePath}</span>
        <span className="status-spacer" />
        <span className="status-msg">{statusText || fileSummary}</span>
        {cursorLine >= 0 && fileMeta && (
          <span className="status-cursor" title="正文行光标(↑↓ 移动)">
            L{(cursorLine + 1).toLocaleString()} / {fileMeta.lines.toLocaleString()}
          </span>
        )}
        {hitCount > 0 && <span className="status-hits">{hitCount.toLocaleString()} hits</span>}
        {fileMeta && (
          <button
            className={`theme-toggle ${tailMode ? "active" : ""}`}
            onClick={() => setTailMode((t) => !t)}
            title="tail 模式:文件追加自动加载,视口跟随底部,激活搜索自动重扫"
          >
            TAIL
          </button>
        )}
        {fileMeta && (
          <button
            className={`theme-toggle ${globalCollapsed ? "active" : ""}`}
            onClick={() => setGlobalCollapsed((v) => !v)}
            title="全局折叠/展开所有备注注释(单个仍可点 📝 展开;完全屏蔽在设置里)"
          >
            注释
          </button>
        )}
        <button
          className="theme-toggle"
          onClick={() => setSetting("theme", effectiveTheme === "dark" ? "light" : "dark")}
          title="切换浅色/深色主题(设置中可选跟随系统)"
        >
          {effectiveTheme === "dark" ? "DARK" : "LIGHT"}
        </button>
      </div>
    </div>
  );
}
