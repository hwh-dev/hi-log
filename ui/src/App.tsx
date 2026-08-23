import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import LogView, { LogViewHandle } from "./components/LogView";
import SearchBar from "./components/SearchBar";
import FilterView from "./components/FilterView";
import Welcome from "./components/Welcome";
import PinsPanel, { type Pin, type PinGroup } from "./components/PinsPanel";
import SnapshotsPanel from "./components/SnapshotsPanel";
import ContextMenu from "./components/ContextMenu";
import PromptModal, { type PromptConfig } from "./components/PromptModal";
import ConfirmModal from "./components/ConfirmModal";
import SettingsModal from "./components/SettingsModal";
import { registerCommand, initCommandDispatcher } from "./utils/commands";
import type { Update } from "@tauri-apps/plugin-updater";
import type { Mark } from "./utils/palette";
import { loadSnapshots, saveSnapshots, type Snapshot } from "./utils/snapshots";
import {
  getSettings,
  setSetting,
  useSettings,
  resolveTheme,
  systemDarkMQ,
  loadRecentFiles,
  recordRecentFile,
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
interface SearchSession {
  id: number; // 即后端 search_id
  query: string;
  regex: boolean;
  caseSensitive: boolean;
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
}

const appWindow = getCurrentWindow();
const webviewWindow = getCurrentWebviewWindow();

/** 并存会话上限(超限丢弃最旧;高命中会话各占数十 MB,必须设上限) */
const MAX_SESSIONS = 8;

export default function App() {
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const [filePath, setFilePath] = useState("");
  const [lineCache, setLineCache] = useState<LineCache>({});
  const [statusText, setStatusText] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);

  // ── theme(设置层管理;状态栏按钮只做快捷切换,可设"跟随系统")──
  const theme = useSettings((s) => s.theme);
  const effectiveTheme = resolveTheme(theme, systemDarkMQ?.matches ?? false);

  // ── search state ──
  const [query, setQuery] = useState("");
  // 默认选项从设置初始化(仅初始生效;历史条目 applyQuery 仍显式传选项)
  const [regex, setRegex] = useState(() => getSettings().regexDefault);
  const [caseSensitive, setCaseSensitive] = useState(() => getSettings().caseDefault);
  /** 搜索会话列表(最新在前,多会话并存);渲染用派生值见下 */
  const [sessions, setSessions] = useState<SearchSession[]>([]);
  /** 当前激活会话 id(高亮/命中列表跟随) */
  const [activeId, setActiveId] = useState<number | null>(null);
  /** tail 模式:文件追加自动加载 + 视口跟随 + 激活搜索自动重扫 */
  const [tailMode, setTailMode] = useState(false);
  /** 备注注释:是否显示(设置里完全屏蔽);状态栏按钮是"全局折叠"开关 */
  const showNotes = useSettings((s) => s.showNotes);
  /** 状态栏按钮:全局折叠所有备注注释(仍可单个展开) */
  const [globalCollapsed, setGlobalCollapsed] = useState(false);
  const searchIdRef = useRef<number | null>(null);
  /** tail 重搜的被替换会话 id(search_done 后并入并删除新会话) */
  const tailReplaceRef = useRef<number | null>(null);
  /** 当前搜索是否在跑(running 的 ref 镜像,runSearch 幂等判断用) */
  const runningRef = useRef(false);
  /** 最近一次发起的搜索参数(幂等判断用) */
  const lastQueryRef = useRef("");
  const lastRegexRef = useRef(false);
  const lastCaseRef = useRef(false);
  // 搜索命中累积缓冲:80ms 节流合并 setState,避免高命中时 O(n) 拷贝撑爆主线程
  const pendingHitsRef = useRef<{ search_id: number; line_no: number; ranges: [number, number][] }[]>([]);
  const flushTimerRef = useRef<number | null>(null);

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

  // ── marks state(仅用于日志行着色与右键,侧栏不再列示)──
  const [marks, setMarks] = useState<MarkMap>({});
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  /** 备注注释行右键菜单(复制/编辑/删除) */
  const [noteCtx, setNoteCtx] = useState<{ lineNo: number; x: number; y: number } | null>(null);
  /** 自绘输入弹窗(备注/命名等,替换原生 prompt) */
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null);
  /** 自绘确认弹窗(自动更新,替换原生 confirm) */
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  // ── pins state(固定:独立于颜色标记的书签功能)──
  const [pinGroups, setPinGroups] = useState<PinGroup[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [pinLines, setPinLines] = useState<LineCache>({});
  /** 固定行号集合(1-based),LogView 书签圆点指示 */
  const pinSet = useMemo(() => new Set(pins.map((p) => p.line_no)), [pins]);

  // ── snapshots state(固定视图锚点,localStorage 持久化)──
  const [snapshots, setSnapshots] = useState<Snapshot[]>(loadSnapshots);

  // 快照变动广播:独立窗口(popout)据此同步
  const broadcastSnapshots = useCallback(() => {
    void appWindow.emit("snapshots_changed");
  }, []);

  const addSnapshot = useCallback(() => {
    const first = logViewRef.current?.getFirstLine() ?? 0;
    setSnapshots((prev) => {
      const next = [
        ...prev,
        {
          id: Date.now(),
          name: `快照 ${prev.length + 1}`,
          line_no: Math.min(first + 1, fileMeta?.lines ?? 1),
          created_at: Date.now(),
        },
      ];
      saveSnapshots(next);
      return next;
    });
    broadcastSnapshots();
  }, [fileMeta, broadcastSnapshots]);

  const removeSnapshot = useCallback(
    (id: number) => {
      setSnapshots((prev) => {
        const next = prev.filter((s) => s.id !== id);
        saveSnapshots(next);
        return next;
      });
      broadcastSnapshots();
    },
    [broadcastSnapshots],
  );

  const renameSnapshot = useCallback(
    (id: number) => {
      const target = snapshots.find((s) => s.id === id);
      if (!target) return;
      setPromptCfg({
        title: "重命名快照",
        initial: target.name,
        placeholder: "快照名称",
        okLabel: "保存",
        onSubmit: (name) => {
          setSnapshots((prev) => {
            const next = prev.map((s) => (s.id === id ? { ...s, name } : s));
            saveSnapshots(next);
            return next;
          });
          broadcastSnapshots();
        },
      });
    },
    [snapshots, broadcastSnapshots],
  );

  const logViewRef = useRef<LogViewHandle>(null);
  /** 搜索输入框引用(Ctrl+F 聚焦用) */
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 稳定引用(useCallback):LogView 已 memo,内联箭头会让 memo 失效
  const handleLogContextMenu = useCallback((lineNo: number, x: number, y: number) => {
    setCtxMenu({ lineNo, x, y });
  }, []);

  // ── 面板尺寸(拖拽调整,设置层持久化;静默写不广播)──
  const filterHeight = useSettings((s) => s.filterHeight);
  const sidebarWidth = useSettings((s) => s.sidebarWidth);
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
        // 重发 fileId:Windows 常驻弹窗挂载时主窗口可能尚未打开文件,
        // panel_ready 的 sidebar_snapshot 被跳过;此处补齐,弹窗据此加载固定
        const meta = fileMetaRef.current;
        if (meta) {
          void appWindow
            .emitTo("sidebar-popout", "sidebar_snapshot", { fileId: meta.id })
            .catch(() => {});
        }
      }
    })();
  }, []);

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

  const loadMarks = useCallback(async (fileId: string) => {
    try {
      const list = await invoke<Mark[]>("list_marks", { fileId });
      const map: MarkMap = {};
      for (const m of list) map[m.line_no] = m;
      setMarks(map);
    } catch (e) {
      console.error("list_marks failed", e);
    }
  }, []);

  // ── 固定(pin)数据加载与操作 ──

  const loadPins = useCallback(async (fileId: string) => {
    try {
      const data = await invoke<{ groups: PinGroup[]; pins: Pin[] }>("list_pins", { fileId });
      setPinGroups(data.groups);
      setPins(data.pins);
      // 拉取固定行的文本,供面板展示内容预览
      setPinLines({});
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
            setPinLines((prev) => {
              const next = { ...prev };
              for (const l of lines) next[l.line_no] = l.text;
              return next;
            });
          })
          .catch((e) => console.error("get_lines failed", e));
      }
    } catch (e) {
      console.error("list_pins failed", e);
    }
  }, []);

  const addPinAction = useCallback(
    (lineNo: number, groupId: number | null) => {
      if (!fileMeta) return;
      // 弹窗打开前先关掉右键菜单,避免其全屏遮罩残留
      setCtxMenu(null);
      // 固定时允许命名(可留空);取消则放弃固定
      setPromptCfg({
        title: `固定第 ${lineNo} 行`,
        hint: "名称可留空",
        placeholder: "固定名称",
        okLabel: "固定",
        onSubmit: (name) => {
          void invoke("add_pin", { fileId: fileMeta.id, lineNo, groupId, name }).catch((e) =>
            console.error("add_pin failed", e),
          );
        },
      });
    },
    [fileMeta],
  );

  const unpinAction = useCallback(async (pinId: number) => {
    await invoke("remove_pin", { pinId }).catch((e) => console.error("remove_pin failed", e));
  }, []);

  const renamePinAction = useCallback((pinId: number) => {
    const current = pins.find((p) => p.id === pinId)?.name ?? "";
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
  }, [pins]);

  const newPinGroupAction = useCallback((): Promise<number | null> => {
    // 弹窗异步收集名称;取消时 Promise 不 resolve,"新建并固定"链自然中断
    return new Promise((resolve) => {
      if (!fileMeta) return resolve(null);
      setCtxMenu(null);
      setPromptCfg({
        title: "新建分组",
        placeholder: "分组名称",
        okLabel: "创建",
        onSubmit: (name) => {
          const trimmed = name.trim();
          if (!trimmed) return resolve(null);
          invoke<PinGroup>("create_pin_group", { fileId: fileMeta.id, name: trimmed })
            .then((g) => resolve(g.id))
            .catch((e) => {
              console.error("create_pin_group failed", e);
              resolve(null);
            });
        },
      });
    });
  }, [fileMeta]);

  const deletePinGroupAction = useCallback(
    async (groupId: number) => {
      if (!fileMeta) return;
      await invoke("delete_pin_group", { fileId: fileMeta.id, groupId }).catch((e) =>
        console.error("delete_pin_group failed", e),
      );
    },
    [fileMeta],
  );

  const reorderPinsAction = useCallback(
    async (groupId: number, ids: number[]) => {
      if (!fileMeta) return;
      await invoke("reorder_pins", { fileId: fileMeta.id, groupId, ids }).catch((e) =>
        console.error("reorder_pins failed", e),
      );
    },
    [fileMeta],
  );

  const reorderGroupsAction = useCallback(
    async (ids: number[]) => {
      if (!fileMeta) return;
      await invoke("reorder_pin_groups", { fileId: fileMeta.id, ids }).catch((e) =>
        console.error("reorder_pin_groups failed", e),
      );
    },
    [fileMeta],
  );

  const movePinAction = useCallback(
    async (pinId: number, groupId: number) => {
      if (!fileMeta) return;
      await invoke("move_pin_to_group", { pinId, fileId: fileMeta.id, groupId }).catch((e) =>
        console.error("move_pin_to_group failed", e),
      );
    },
    [fileMeta],
  );

  /** 打开文件(统一入口:透传编码设置;openFile 与 tail 重开共用,避免两处漂移) */
  const openWithEncoding = useCallback(async (path: string): Promise<FileMeta> => {
    return await invoke<FileMeta>("open_file", { path, forceEncoding: getSettings().encoding });
  }, []);

  const openFile = useCallback(
    async (path?: string): Promise<boolean> => {
      const target = (path ?? filePath).trim();
      if (!target) return false;
      setStatusText("Opening…");
      try {
        const meta = await openWithEncoding(target);
        setFileMeta(meta);
        setFilePath(target);
        setLineCache({});
        resetSearch();
        void loadMarks(target);
        void loadPins(target);
        setStatusText(
          `${meta.lines.toLocaleString()} lines · ${(meta.size / 1024 / 1024).toFixed(1)} MB · ${meta.encoding}`,
        );
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
    [filePath, openWithEncoding],
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

  const resetSearch = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingHitsRef.current = [];
    // 停止仍在跑的后端扫描,避免清空后白扫整个文件
    if (searchIdRef.current !== null) {
      void invoke("stop_search", { searchId: searchIdRef.current }).catch(() => {});
    }
    setSessions([]);
    setActiveId(null);
    runningRef.current = false;
    searchIdRef.current = null;
  }, []);

  // 把缓冲中的命中一次性合并进对应会话(搜索结束后立即落盘)
  const flushHits = useCallback(() => {
    flushTimerRef.current = null;
    const batch = pendingHitsRef.current;
    pendingHitsRef.current = [];
    if (batch.length === 0) return;
    // 按会话分组合并高亮(一次 setState 批量更新全部受影响会话)
    const bySid = new Map<number, { line_no: number; ranges: [number, number][] }[]>();
    for (const h of batch) {
      const list = bySid.get(h.search_id);
      if (list) list.push(h);
      else bySid.set(h.search_id, [h]);
    }
    setSessions((prev) =>
      prev.map((s) => {
        const hits = bySid.get(s.id);
        if (!hits) return s;
        const next = { ...s.highlightMap };
        for (const h of hits) next[h.line_no] = h.ranges;
        return { ...s, highlightMap: next, hitCount: s.hitCount + hits.length };
      }),
    );
  }, []);

  const closeFile = useCallback(() => {
    setFileMeta(null);
    setFilePath("");
    setLineCache({});
    setMarks({});
    setPinGroups([]);
    setPins([]);
    setPinLines({});
    setCtxMenu(null);
    resetSearch();
    setStatusText("");
  }, [resetSearch]);

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

  /** 跳转到下一个/上一个命中(相对当前视口首行;F6 / Shift+F6) */
  const jumpToHit = useCallback((dir: 1 | -1) => {
    const lines = hitLinesRef.current;
    if (lines.length === 0) return;
    const first = logViewRef.current?.getFirstLine() ?? 0; // 0-based 视口首行
    if (dir === 1) {
      // 下一个:视口下方第一个命中;没有则回到第一个
      const target = lines.find((l) => l - 1 > first) ?? lines[0];
      logViewRef.current?.scrollToLine(target - 1);
    } else {
      const target = [...lines].reverse().find((l) => l - 1 < first) ?? lines[lines.length - 1];
      logViewRef.current?.scrollToLine(target - 1);
    }
  }, []);

  useEffect(() => {
    const un: Array<() => void> = [];
    un.push(registerCommand("openSettings", () => setSettingsOpen(true)));
    un.push(
      registerCommand("toggleTheme", () =>
        setSetting("theme", effectiveTheme === "dark" ? "light" : "dark"),
      ),
    );
    un.push(registerCommand("toggleTail", () => setTailMode((t) => !t)));
    un.push(registerCommand("focusSearch", () => searchInputRef.current?.focus()));
    un.push(registerCommand("openFile", () => void openFileDialog()));
    un.push(registerCommand("closeFile", closeFile));
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
  }, [effectiveTheme, closeFile, openFileDialog, jumpToHit, filterHidden]);

  // ── run search ──
  const runSearch = useCallback(
    async (q: string, r: boolean, c: boolean) => {
      if (!fileMeta) return;
      // 同一查询已在跑:幂等跳过。否则每次 Enter 都会启动一次全新全量扫描,
      // 旧扫描线程继续发事件,造成计数虚高与 N 倍扫描耗时。
      if (
        runningRef.current &&
        q === lastQueryRef.current &&
        r === lastRegexRef.current &&
        c === lastCaseRef.current
      ) {
        return;
      }
      // 停止上一次搜索
      if (searchIdRef.current !== null) {
        await invoke("stop_search", { searchId: searchIdRef.current }).catch(() => {});
      }
      if (!q.trim()) return; // 空查询不清会话,保留已有结果便于对比
      tailReplaceRef.current = null; // 手动搜索取消待处理的 tail 替换
      runningRef.current = true;
      lastQueryRef.current = q;
      lastRegexRef.current = r;
      lastCaseRef.current = c;
      try {
        const id = await invoke<number>("start_search", {
          fileId: fileMeta.id,
          query: q,
          opts: { regex: r, caseSensitive: c },
        });
        searchIdRef.current = id;
        // 相同查询(词+正则+大小写一致)的既有会话:复用刷新,而非新建。
        // 避免"搜了 INFO 又搜 INFO"无限开新窗口 —— 重复同词应刷新原结果。
        const reuse = sessionsRef.current.find(
          (s) => !s.running && s.query === q && s.regex === r && s.caseSensitive === c,
        );

        if (reuse) {
          // 把该会话重置为 running 态:清空旧命中并换上新 search_id,位置不变
          setSessions((prev) =>
            prev.map((s) =>
              s.id === reuse.id
                ? { ...s, id, running: true, hitCount: 0, truncated: false, highlightMap: {}, progress: null }
                : s,
            ),
          );
        } else {
          // 新会话置顶(Notepad++ 风格:每次新词一个新会话,旧结果保留可对比)
          setSessions((prev) =>
            [
              {
                id,
                query: q,
                regex: r,
                caseSensitive: c,
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
        setActiveId(id);
        // 通知命中弹窗:新搜索会话(词/选项一并带上);未打开不转发
        if (popoutOpenRef.current.filter) {
          void appWindow
            .emitTo("filter-popout", "search_started", { search_id: id, query: q, regex: r, caseSensitive: c })
            .catch(() => {});
        }
      } catch (e) {
        runningRef.current = false;
        console.error("start_search failed", e);
      }
    },
    [fileMeta, resetSearch],
  );

  // 手动触发搜索:回车或点按钮(不做打字即搜)
  const doSearch = useCallback(() => {
    void runSearch(query, regex, caseSensitive);
  }, [query, regex, caseSensitive, runSearch]);

  // 应用搜索历史条目:恢复其选项并立即搜索
  const applyQuery = useCallback(
    (q: string, r: boolean, c: boolean) => {
      setQuery(q);
      setRegex(r);
      setCaseSensitive(c);
      void runSearch(q, r, c);
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
      // 命中数字即时反馈,高亮 map 才 80ms 节流合并(按会话)
      pendingHitsRef.current.push(
        ...hits.map((h) => ({ search_id: sid, line_no: h.line_no, ranges: h.ranges })),
      );
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, hitCount: s.hitCount + hits.length } : s)),
      );
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
      const sid = e.payload.search_id;
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, progress: e.payload } : s)),
      );
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
        setSessions((prev) => {
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
      setSessions((prev) =>
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
  }, [flushHits]);

  // ── marks / pins:后端任何变更都会广播,统一重拉当前文件的数据 ──
  useEffect(() => {
    if (!fileMeta) return;
    const unlisteners: Array<() => void> = [];
    listen("marks_changed", () => {
      void loadMarks(fileMeta.id);
    }).then((fn) => unlisteners.push(fn));
    listen("pins_changed", () => {
      void loadPins(fileMeta.id);
    }).then((fn) => unlisteners.push(fn));
    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [fileMeta, loadMarks, loadPins]);

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
  const selectSession = useCallback((id: number) => {
    const target = sessionsRef.current.find((s) => s.id === id);
    if (target) {
      setQuery(target.query);
      setRegex(target.regex);
      setCaseSensitive(target.caseSensitive);
    }
    setActiveId(id);
    if (popoutOpenRef.current.filter) {
      void appWindow.emitTo("filter-popout", "session_active_fwd", { search_id: id }).catch(() => {});
    }
  }, []);

  /** 关闭单个会话;正在跑的会话一并停止后端扫描 */
  const closeSession = useCallback((id: number) => {
    setSessions((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target?.running) {
        void invoke("stop_search", { searchId: id }).catch(() => {});
      }
      return prev.filter((s) => s.id !== id);
    });
    setActiveId((a) => (a === id ? null : a));
    if (popoutOpenRef.current.filter) {
      void appWindow.emitTo("filter-popout", "session_close_fwd", { search_id: id }).catch(() => {});
    }
  }, []);

  /** 清空全部会话 */
  const clearSessions = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingHitsRef.current = [];
    setSessions((prev) => {
      for (const s of prev) {
        if (s.running) void invoke("stop_search", { searchId: s.id }).catch(() => {});
      }
      return [];
    });
    setActiveId(null);
    searchIdRef.current = null;
    runningRef.current = false;
    if (popoutOpenRef.current.filter) {
      void appWindow.emitTo("filter-popout", "sessions_clear_fwd", {}).catch(() => {});
    }
  }, []);

  // ── 独立面板窗口(popout)桥接 ──
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    // popout 挂载后请求快照 → 回发当前搜索状态 / 文件信息
    listen<{ kind: string }>("panel_ready", (e) => {
      const meta = fileMetaRef.current;
      if (!meta) return;
      if (e.payload.kind === "filter") {
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
        void appWindow
          .emitTo("sidebar-popout", "sidebar_snapshot", { fileId: meta.id })
          .catch(() => {});
      }
    }).then((fn) => unlisteners.push(fn));

    // popout 点击命中行/快照/标记 → 主视图跳转并聚焦
    listen<number>("goto_line", (e) => {
      logViewRef.current?.scrollToLine(e.payload);
      void appWindow.setFocus();
    }).then((fn) => unlisteners.push(fn));

    // popout 内点击会话 chip → 统一激活状态(搜索栏联动,再广播回 popout)
    listen<{ search_id: number }>("panel_session_activate", (e) => {
      const target = sessionsRef.current.find((s) => s.id === e.payload.search_id);
      if (target) {
        setQuery(target.query);
        setRegex(target.regex);
        setCaseSensitive(target.caseSensitive);
      }
      setActiveId(e.payload.search_id);
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

    // popout 内"固定快照"(无日志视图,委托主窗口当前视图行)
    listen("snapshot_add", () => {
      addSnapshot();
    }).then((fn) => unlisteners.push(fn));

    // popout 内增删快照 → 重读 localStorage 同步
    listen("snapshots_changed", () => {
      setSnapshots(loadSnapshots());
    }).then((fn) => unlisteners.push(fn));

    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [addSnapshot, closeSession, clearSessions]);

  // ── mark actions ──
  const addMarkAction = useCallback(
    async (lineNo: number, color: number) => {
      if (!fileMeta) return;
      await invoke("add_mark", { fileId: fileMeta.id, lineNo, color }).catch((e) =>
        console.error("add_mark failed", e),
      );
    },
    [fileMeta],
  );

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
    (lineNo: number, color: number) => {
      if (!fileMeta) return;
      const current = marks[lineNo]?.note ?? "";
      setCtxMenu(null);
      setPromptCfg({
        title: `第 ${lineNo} 行备注`,
        hint: current ? "修改备注" : "新备注",
        initial: current,
        multiline: true,
        placeholder: "输入备注,可留空",
        okLabel: "保存",
        onSubmit: (note) => {
          void invoke("add_mark", { fileId: fileMeta.id, lineNo, color, note }).catch((e) =>
            console.error("add_mark failed", e),
          );
        },
      });
    },
    [fileMeta, marks],
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
          const p = event.payload.paths[0];
          if (p) openFile(p);
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
        opts: { regex: s.regex, caseSensitive: s.caseSensitive },
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
          setFileMeta(newMeta);
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
      if (!fileMeta) return;
      try {
        const lines = await invoke<LinePayload[]>("get_lines", {
          fileId: fileMeta.id,
          start,
          count,
        });
        setLineCache((prev) => {
          const next = { ...prev };
          for (const l of lines) {
            next[l.line_no - 1] = l.text;
          }
          return next;
        });
      } catch (e) {
        console.error("get_lines failed", e);
      }
    },
    [fileMeta],
  );

  const stopSearch = useCallback(() => {
    if (searchIdRef.current !== null) {
      void invoke("stop_search", { searchId: searchIdRef.current }).catch(() => {});
    }
    runningRef.current = false;
  }, []);

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
          <div className="tab active" title={filePath}>
            <span className="tab-name">{filePath.split(/[/\\]/).pop()}</span>
            <button className="tab-close" onClick={closeFile} aria-label="close file">×</button>
          </div>
          <button className="tab tab-new" onClick={closeFile} aria-label="open new">+</button>
          <span className="tabbar-spacer" />
          <button
            className={`tab sidebar-toggle ${sidebarVisible ? "active" : ""}`}
            onClick={() => setSidebarVisible((v) => !v)}
            title="显示/隐藏侧栏(快照+标记)"
          >
            侧栏
          </button>
        </div>
      )}

      {!fileMeta ? (
        <Welcome
          filePath={filePath}
          setFilePath={setFilePath}
          onOpen={() => openFile()}
          onOpenPath={(p) => openFile(p)}
          dropActive={dropActive}
          recentFiles={recentFiles}
        />
      ) : (
        <>
          <div className="main-area">
            <div className="workspace">
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
                    <SnapshotsPanel
                      snapshots={snapshots}
                      onAdd={addSnapshot}
                      onJump={(l) => logViewRef.current?.scrollToLine(l)}
                      onRemove={removeSnapshot}
                      onRename={renameSnapshot}
                    />
                    <PinsPanel
                      groups={pinGroups}
                      pins={pins}
                      lineText={pinLines}
                      onJump={(l) => logViewRef.current?.scrollToLine(l)}
                      onUnpin={unpinAction}
                      onRename={renamePinAction}
                      onNewGroup={() => void newPinGroupAction()}
                      onDeleteGroup={deletePinGroupAction}
                      onReorder={reorderPinsAction}
                      onReorderGroups={reorderGroupsAction}
                      onMoveToGroup={movePinAction}
                    />
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
                lineCache={lineCache}
                highlightMap={activeHighlightMap}
                marks={marks}
                pins={pinSet}
                followTail={tailMode}
                showNotes={showNotes}
                globalCollapsed={globalCollapsed}
                onNoteContextMenu={(lineNo, x, y) => setNoteCtx({ lineNo, x, y })}
                onContextMenu={handleLogContextMenu}
                fetchLines={fetchLines}
              />
            </div>
          </div>
          {/* 有会话即显示命中面板(0 命中也可见,便于对比/清理) */}
          {sessions.length > 0 && !filterHidden && !popoutOpen.filter && (
            <>
              <div
                className="filter-resizer"
                onPointerDown={(e) => startResize(e, "height")}
                onDoubleClick={() => setSetting("filterHeight", 220, { silent: true })}
                title="拖动调整高度,双击复位"
              />
              <FilterView
                sessions={sessions}
                activeId={activeId}
                onSelectSession={selectSession}
                onCloseSession={closeSession}
                onClearSessions={clearSessions}
                lineCache={lineCache}
                highlightMap={activeHighlightMap}
                marks={marks}
                fetchLines={fetchLines}
                onJump={(l) => logViewRef.current?.scrollToLine(l)}
                onContextMenu={(lineNo, x, y) => setCtxMenu({ lineNo, x, y })}
                hitCount={hitCount}
                truncated={truncated}
                height={filterHeight}
                lineCount={fileMeta.lines}
                onPopout={() => openPanel("filter")}
                onCollapse={() => setFilterHidden(true)}
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
            running={searchRunning}
            onSearch={doSearch}
            onStop={stopSearch}
            onApplyQuery={applyQuery}
            inputRef={searchInputRef}
            hitCount={hitCount}
            truncated={truncated}
            progress={searchProgress}
            filterVisible={sessions.length > 0 && !filterHidden && !popoutOpen.filter}
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
        const pinned = pins.find((p) => p.line_no === ctxMenu.lineNo) ?? null;
        return (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            lineNo={ctxMenu.lineNo}
            mark={marks[ctxMenu.lineNo] ?? null}
            onMark={(c) => void addMarkAction(ctxMenu.lineNo, c)}
            onNote={() =>
              void addNoteAction(ctxMenu.lineNo, marks[ctxMenu.lineNo]?.color ?? 0)
            }
            onClear={() => {
              const m = marks[ctxMenu.lineNo];
              if (m) void removeMarkAction(m.id);
            }}
            pinGroups={pinGroups}
            pinnedGroup={pinned ? pinGroups.find((g) => g.id === pinned.group_id) ?? null : null}
            onPin={(gid) => void addPinAction(ctxMenu.lineNo, gid)}
            onUnpin={() => {
              if (pinned) void unpinAction(pinned.id);
            }}
            onRenamePin={() => {
              if (pinned) void renamePinAction(pinned.id);
            }}
            onNewGroupAndPin={() => {
              void newPinGroupAction().then((gid) => {
                if (gid != null) void addPinAction(ctxMenu.lineNo, gid);
              });
            }}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}

      {noteCtx && (() => {
        const m = marks[noteCtx.lineNo];
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
                  addNoteAction(noteCtx.lineNo, m?.color ?? 0);
                  setNoteCtx(null);
                }}
              >
                编辑备注…
              </button>
              <button
                className="ctx-item danger"
                onClick={() => {
                  // 删除注释:仅清空备注文本,保留颜色标记(add_mark 为 upsert,note 置空)
                  if (m && fileMeta) {
                    void invoke("add_mark", {
                      fileId: fileMeta.id,
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

      {fileMeta && (
        <div className="statusbar">
          <span className="status-file" title={filePath}>{filePath}</span>
          <span className="status-spacer" />
          <span>{statusText}</span>
          {hitCount > 0 && <span className="status-hits">{hitCount.toLocaleString()} hits</span>}
          <button
            className={`theme-toggle ${tailMode ? "active" : ""}`}
            onClick={() => setTailMode((t) => !t)}
            title="tail 模式:文件追加自动加载,视口跟随底部,激活搜索自动重扫"
          >
            TAIL
          </button>
          <button
            className={`theme-toggle ${globalCollapsed ? "active" : ""}`}
            onClick={() => setGlobalCollapsed((v) => !v)}
            title="全局折叠/展开所有备注注释(单个仍可点 📝 展开;完全屏蔽在设置里)"
          >
            注释
          </button>
          <button
            className="theme-toggle"
            onClick={() => setSetting("theme", effectiveTheme === "dark" ? "light" : "dark")}
            title="切换浅色/深色主题(设置中可选跟随系统)"
          >
            {effectiveTheme === "dark" ? "DARK" : "LIGHT"}
          </button>
        </div>
      )}
    </div>
  );
}
