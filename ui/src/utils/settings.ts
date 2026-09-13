import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { useSyncExternalStore } from "react";

/**
 * 统一设置层:类型化 schema + localStorage 读写 + 模块级 store(useSyncExternalStore)
 * + 跨窗口广播(settings_changed,Tauri 全局事件,与 snapshots_changed 同模式)。
 *
 * 设计要点:
 * - 单 key 单值存储,旧 key 直接复用(theme/filter-height/sidebar-width),零迁移;
 * - 数值/布尔/枚举统一走 parse 钳制(读旧值、写新值同一入口);
 * - 布局尺寸类(filterHeight/sidebarWidth)静默写,不广播(popout 不关心);
 * - 三窗口同源共享 localStorage,桥接只负责"变更通知 + 重新应用 DOM"。
 */

// ── 类型与默认值 ──

export type ThemeSetting = "dark" | "light" | "system";
export type EncodingSetting = "auto" | "utf8" | "gbk" | "utf16";
/** 外观风格:实心(默认)或液态玻璃(半透明+背景模糊) */
export type ThemeStyleSetting = "solid" | "glass";
/** 固定面板排序规则:标记时间 / 文件中顺序(行号) / 手动(拖拽重排) */
export type PinsSortSetting = "time" | "line" | "custom";

export interface AppSettings {
  // 外观
  theme: ThemeSetting;
  /** 外观风格:玻璃(半透明+backdrop-filter;引擎不支持时 CSS 侧自动回退高不透明) */
  themeStyle: ThemeStyleSetting;
  /** 背景图固定文件名 background.<ext>(只存文件名不存路径;""=内置渐变底) */
  backgroundImage: string;
  fontFamily: string;
  /** 字号 px(11-16),与行距共同决定行高 */
  fontSize: number;
  /** 行距 px(5-14);行高 = fontSize + rowSpacing(13+9=22,与初版一致) */
  rowSpacing: number;
  /** 显示备注注释行(完全屏蔽;关闭则连行内 📝 也不显示) */
  showNotes: boolean;
  // 搜索
  regexDefault: boolean;
  caseDefault: boolean;
  /** 整词默认开关(与上面两个对称,否则重启后整词会单独丢失) */
  wholeWordDefault: boolean;
  /** 上下文 ±N 行(0 = 关闭) */
  contextLines: number;
  searchHistoryMax: number;
  // 文件
  openTailMode: boolean;
  restoreLastFile: boolean;
  /** tail 轮询间隔 ms(500-10000) */
  tailPollMs: number;
  checkUpdateOnStart: boolean;
  encoding: EncodingSetting;
  // 快捷键(数据形态见 commands.ts 的 DEFAULT_BINDINGS;此处仅存储覆盖值)
  keybindings: Record<string, string | null>;
  // 布局(高频写,静默不广播)
  filterHeight: number;
  sidebarWidth: number;
  /** 侧栏区块显示开关 + 是否按文件分节(固定/注释独立) */
  sidebarSections: {
    pins: boolean;
    notes: boolean;
    pinsByFile: boolean;
    notesByFile: boolean;
  };
  /** 固定面板排序:标记时间(默认) / 文件中顺序 / 手动拖拽 */
  pinsSort: PinsSortSetting;
}

export const DEFAULT_FONT_FAMILY =
  '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace';

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  themeStyle: "solid",
  backgroundImage: "",
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 13,
  rowSpacing: 9,
  showNotes: true,
  regexDefault: false,
  caseDefault: false,
  wholeWordDefault: false,
  contextLines: 0,
  searchHistoryMax: 50,
  openTailMode: false,
  restoreLastFile: true,
  tailPollMs: 1000,
  checkUpdateOnStart: true,
  encoding: "auto",
  keybindings: {},
  filterHeight: 220,
  sidebarWidth: 230,
  sidebarSections: { pins: true, notes: true, pinsByFile: true, notesByFile: true },
  pinsSort: "time",
};

// ── schema:每个设置项的存储 key / 解析(钳制与白名单)──

interface SettingDef<T> {
  key: string;
  def: T;
  /** 宽松解析:null/非法 → 默认;数值钳制到 [min,max] */
  parse: (raw: string | null) => T;
  /** 序列化(缺省 String(v));JSON 类(快捷键表)必须显式提供 */
  dump?: (v: T) => string;
}

const clampNum = (raw: string | null, def: number, min: number, max: number): number => {
  // 注意 Number(null) === 0,必须先判空(否则无值时会钳到下限而非默认)
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const SCHEMA: { [K in keyof AppSettings]: SettingDef<AppSettings[K]> } = {
  theme: {
    key: "hi-log.theme",
    def: "dark",
    parse: (r) => (r === "light" || r === "system" ? r : "dark"),
  },
  themeStyle: {
    key: "hi-log.theme-style",
    def: "solid",
    parse: (r) => (r === "glass" ? "glass" : "solid"),
  },
  backgroundImage: {
    key: "hi-log.background",
    def: "",
    // 固定文件名白名单(只存 background.<ext>,路径/URL 一律拒收)
    parse: (r) => {
      const t = (r ?? "").trim().toLowerCase();
      return /^background\.(png|jpe?g|webp|bmp)$/.test(t) ? t : "";
    },
  },
  fontFamily: {
    key: "hi-log.font-family",
    def: DEFAULT_FONT_FAMILY,
    parse: (r) => (r && r.trim() ? r.trim() : DEFAULT_FONT_FAMILY),
  },
  fontSize: {
    key: "hi-log.font-size",
    def: 13,
    parse: (r) => clampNum(r, 13, 11, 16),
  },
  rowSpacing: {
    key: "hi-log.row-spacing",
    def: 9,
    parse: (r) => clampNum(r, 9, 5, 14),
  },
  showNotes: {
    key: "hi-log.show-notes",
    def: true,
    parse: (r) => (r === null ? true : r !== "false"),
  },
  regexDefault: {
    key: "hi-log.regex-default",
    def: false,
    parse: (r) => r === "true",
  },
  caseDefault: {
    key: "hi-log.case-default",
    def: false,
    parse: (r) => r === "true",
  },
  wholeWordDefault: {
    key: "hi-log.whole-word-default",
    def: false,
    parse: (r) => r === "true",
  },
  contextLines: {
    key: "hi-log.context-lines",
    def: 0,
    parse: (r) => clampNum(r, 0, 0, 10),
  },
  searchHistoryMax: {
    key: "hi-log.search-history-max",
    def: 50,
    parse: (r) => clampNum(r, 50, 10, 200),
  },
  openTailMode: {
    key: "hi-log.open-tail-mode",
    def: false,
    parse: (r) => r === "true",
  },
  restoreLastFile: {
    key: "hi-log.restore-last-file",
    def: true,
    parse: (r) => (r === null ? true : r !== "false"),
  },
  tailPollMs: {
    key: "hi-log.tail-poll-ms",
    def: 1000,
    parse: (r) => clampNum(r, 1000, 500, 10000),
  },
  checkUpdateOnStart: {
    key: "hi-log.check-update",
    def: true,
    parse: (r) => (r === null ? true : r !== "false"),
  },
  encoding: {
    key: "hi-log.encoding",
    def: "auto",
    parse: (r) => (r === "utf8" || r === "gbk" || r === "utf16" ? r : "auto"),
  },
  keybindings: {
    key: "hi-log.keybindings",
    def: {},
    parse: (r) => {
      try {
        const o = JSON.parse(r ?? "{}");
        return typeof o === "object" && o !== null ? o : {};
      } catch {
        return {};
      }
    },
    dump: (v) => JSON.stringify(v),
  },
  filterHeight: {
    key: "hi-log.filter-height",
    def: 220,
    parse: (r) => clampNum(r, 220, 60, 100000),
  },
  sidebarSections: {
    key: "hi-log.sidebar-sections",
    def: { pins: true, notes: true, pinsByFile: true, notesByFile: true },
    parse: (r) => {
      try {
        const o = JSON.parse(r ?? "{}");
        return {
          pins: typeof o.pins === "boolean" ? o.pins : true,
          notes: typeof o.notes === "boolean" ? o.notes : true,
          pinsByFile: typeof o.pinsByFile === "boolean" ? o.pinsByFile : true,
          notesByFile: typeof o.notesByFile === "boolean" ? o.notesByFile : true,
        };
      } catch {
        return { pins: true, notes: true, pinsByFile: true, notesByFile: true };
      }
    },
    dump: (v) => JSON.stringify(v),
  },
  pinsSort: {
    key: "hi-log.pins-sort",
    def: "time",
    parse: (r) => (r === "line" || r === "custom" ? r : "time"),
  },
  sidebarWidth: {
    key: "hi-log.sidebar-width",
    def: 230,
    parse: (r) => clampNum(r, 230, 160, 480),
  },
};

// ── 模块级 store(三窗口各自独立模块实例,同源同值)──

let cache: AppSettings = loadSettings();
const listeners = new Set<() => void>();

export function getSettings(): AppSettings {
  return cache;
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  for (const fn of listeners) fn();
}

/**
 * React 订阅(selector 必须返回原始值:number/string/boolean,
 * 否则 useSyncExternalStore 的快照比较会因新对象恒不等而死循环)。
 */
export function useSettings<T>(selector: (s: AppSettings) => T): T {
  return useSyncExternalStore(subscribeSettings, () => selector(getSettings()));
}

// ── 读写 ──

export function loadSettings(): AppSettings {
  const out = { ...DEFAULT_SETTINGS };
  // SettingDef<never>:parse 返回 never,可赋给任意字段(运行时为具体类型,安全)
  for (const [k, def] of Object.entries(SCHEMA) as [keyof AppSettings, SettingDef<never>][]) {
    out[k] = def.parse(localStorage.getItem(def.key));
  }
  return out;
}

/**
 * 写入设置:parse 钳制后落盘 → 更新缓存(新对象触发订阅)→ 应用外观 →
 * 非静默时广播 settings_changed(popout 等窗口重载)。JSON 类(keybindings)直接信任。
 */
export function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
  opts?: { silent?: boolean },
): void {
  const def = SCHEMA[key];
  let stored: string;
  let next: AppSettings[K];
  if (def.dump) {
    stored = def.dump(value);
    next = value;
  } else {
    stored = String(value);
    next = def.parse(stored);
    if (stored !== String(next)) stored = String(next); // 钳制后回写规范化值
  }
  localStorage.setItem(def.key, stored);
  cache = { ...cache, [key]: next };
  applyAppearance(cache);
  if (!opts?.silent) {
    broadcastSettingsChanged();
  }
  notify();
}

/** 跨窗口广播;非 Tauri 环境(单测/纯浏览器)静默跳过 */
function broadcastSettingsChanged() {
  try {
    void getCurrentWindow().emit("settings_changed");
  } catch {
    // no-op
  }
}

/** 恢复全部默认(清空本应用的全部设置 key) */
export function resetSettings() {
  for (const k of Object.keys(SCHEMA) as (keyof AppSettings)[]) {
    localStorage.removeItem(SCHEMA[k].key);
  }
  cache = loadSettings();
  applyAppearance(cache);
  broadcastSettingsChanged();
  notify();
}

// ── 外观应用(主题三态 + 字体/行高 CSS 变量)──

const darkMQ =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** 系统配色偏好(只读;system 主题时状态栏图标/解析主题跟随系统) */
export const systemDarkMQ = darkMQ;

/** 解析生效主题(system 按系统偏好) */
export function resolveTheme(t: ThemeSetting, systemDark: boolean): "dark" | "light" {
  if (t === "system") return systemDark ? "dark" : "light";
  return t;
}

/** 行高公式(唯一来源):字号 + 行距 */
export function rowHeight(s: AppSettings): number {
  return s.fontSize + s.rowSpacing;
}

// ── 玻璃主题:背景图解析(固定文件名 → asset URL)+ blur 能力检测 ──

/** backdrop-filter 支持(老 WebKitGTK 无;不支持时 CSS 侧用高不透明回退主题) */
const BLUR_SUPPORTED = (() => {
  try {
    return (
      typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("backdrop-filter", "blur(1px)")
    );
  } catch {
    return false;
  }
})();

/** 已解析的背景图 asset URL(未解析/失效 = null → CSS 渐变兜底) */
let bgAssetUrl: string | null = null;
/** 解析代际:快速换图/重启解析时旧结果作废,防乱序回写 */
let bgResolveSeq = 0;

function applyBgImage() {
  const root = document.documentElement;
  if (cache.backgroundImage && bgAssetUrl) {
    root.style.setProperty("--bg-image", `url("${bgAssetUrl}")`);
  } else {
    root.style.removeProperty("--bg-image");
  }
}

/** 由固定文件名重拼 asset URL 并预载探测(换机/文件丢失 → null → 渐变兜底) */
export async function resolveBackgroundImageUrl(): Promise<string | null> {
  const seq = ++bgResolveSeq;
  const name = cache.backgroundImage;
  if (!name) {
    bgAssetUrl = null;
    applyBgImage();
    return null;
  }
  try {
    const url = convertFileSrc(await join(await appDataDir(), name));
    const ok = await new Promise<boolean>((res) => {
      const img = new Image();
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = url;
    });
    if (seq !== bgResolveSeq) return null; // 已被新选择取代
    bgAssetUrl = ok ? url : null;
    applyBgImage();
    return bgAssetUrl;
  } catch {
    if (seq === bgResolveSeq) {
      bgAssetUrl = null;
      applyBgImage();
    }
    return null;
  }
}

/**
 * 选图成功后直接注入 URL(免一次 appDataDir 重解析)。
 * 必须先于 setSetting() 调用:否则"新文件名 + 旧 URL"会错配一帧。
 */
export function setResolvedBackgroundPath(absPath: string | null) {
  bgResolveSeq++;
  bgAssetUrl = absPath ? convertFileSrc(absPath) : null;
  applyBgImage();
}

/** 当前生效的背景 URL(设置页预览用);未解析/失效 = null */
export function getResolvedBackgroundUrl(): string | null {
  return bgAssetUrl;
}

export function applyAppearance(s: AppSettings) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(s.theme, darkMQ?.matches ?? false);
  root.dataset.themeStyle = s.themeStyle;
  if (BLUR_SUPPORTED) delete root.dataset.blurFallback;
  else root.dataset.blurFallback = "1";
  root.style.setProperty("--font-size", `${s.fontSize}px`);
  root.style.setProperty("--row-height", `${rowHeight(s)}px`);
  root.style.setProperty("--font-family", s.fontFamily);
  applyBgImage();
}

let bridgeStarted = false;

/**
 * 跨窗口桥(三窗口的 main.tsx 都调用):
 * 1. 挂载即应用外观 —— 修复 popout 窗口永远 dark 的历史问题;
 * 2. listen settings_changed → 重读 localStorage + 重应用 + 通知订阅者;
 * 3. 跟随系统偏好变化(仅 system 主题生效时)。
 */
export function initSettingsBridge(): void {
  applyAppearance(cache);
  // 背景图 URL 异步解析(Image 预载探测):启动及各窗口收到变更后各重解一次
  void resolveBackgroundImageUrl();
  if (bridgeStarted) return;
  bridgeStarted = true;
  void listen("settings_changed", () => {
    cache = loadSettings();
    applyAppearance(cache);
    notify();
    void resolveBackgroundImageUrl();
  });
  darkMQ?.addEventListener?.("change", () => {
    if (cache.theme === "system") {
      cache = { ...cache };
      applyAppearance(cache);
      notify();
    }
  });
}

// ── 数据类辅助(localStorage key 收敛至此;历史/最近文件保持各自模块原有格式)──

export function loadLastFile(): string | null {
  return localStorage.getItem("hi-log.last-file");
}
export function saveLastFile(path: string) {
  localStorage.setItem("hi-log.last-file", path);
}
export function clearLastFile() {
  localStorage.removeItem("hi-log.last-file");
}

export function loadRecentFiles(): string[] {
  try {
    return JSON.parse(localStorage.getItem("hi-log.recent-files") ?? "[]");
  } catch {
    return [];
  }
}
export function recordRecentFile(path: string, max = 10): string[] {
  const next = [path, ...loadRecentFiles().filter((p) => p !== path)].slice(0, max);
  localStorage.setItem("hi-log.recent-files", JSON.stringify(next));
  return next;
}
export function removeRecentFile(path: string): string[] {
  const next = loadRecentFiles().filter((p) => p !== path);
  localStorage.setItem("hi-log.recent-files", JSON.stringify(next));
  return next;
}

/** 一条搜索历史:词 + 当时的选项(选历史项时要连选项一起还原) */
export interface SearchHistoryEntry {
  q: string;
  regex: boolean;
  caseSensitive: boolean;
  /** 整词(旧数据按 false 补齐) */
  wholeWord: boolean;
  /** 排除词(旧数据按空补齐) */
  exclude: string;
}

/** 搜索历史:兼容旧的 string[] 与缺字段条目(选项按默认补齐) */
export function loadSearchHistory(): SearchHistoryEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem("hi-log.search-history") ?? "[]");
    if (!Array.isArray(v)) return [];
    return v
      .map((h): SearchHistoryEntry | null => {
        if (typeof h === "string") {
          return { q: h, regex: false, caseSensitive: false, wholeWord: false, exclude: "" };
        }
        if (typeof h?.q !== "string" || !h.q) return null;
        return {
          q: h.q,
          regex: !!h.regex,
          caseSensitive: !!h.caseSensitive,
          wholeWord: !!h.wholeWord,
          exclude: typeof h.exclude === "string" ? h.exclude : "",
        };
      })
      .filter((h): h is SearchHistoryEntry => h !== null);
  } catch {
    return [];
  }
}
export function saveSearchHistory(list: SearchHistoryEntry[]) {
  localStorage.setItem("hi-log.search-history", JSON.stringify(list));
}
/** 记录一次搜索(同词同**全部选项**去重置顶,截断到 max);返回新列表。
    去重键必须含整词/排除词,否则"同词不同排除"会被错误合并成一条。 */
export function recordSearchHistory(
  entry: Omit<SearchHistoryEntry, never>,
  max: number,
): SearchHistoryEntry[] {
  const { q, regex, caseSensitive, wholeWord, exclude } = entry;
  const rest = loadSearchHistory().filter(
    (x) =>
      !(
        x.q === q &&
        x.regex === regex &&
        x.caseSensitive === caseSensitive &&
        x.wholeWord === wholeWord &&
        x.exclude === exclude
      ),
  );
  const next = [{ q, regex, caseSensitive, wholeWord, exclude }, ...rest].slice(0, max);
  saveSearchHistory(next);
  return next;
}
export function clearSearchHistory() {
  localStorage.removeItem("hi-log.search-history");
}

// ── 搜索上下文 ±N 行(纯函数,可单测)──

/** 命中行(1-based,升序)→ 展开为 ±n 上下文后的显示行号(升序)。n<=0 原样返回 */
export function expandContext(hitLines: number[], n: number, maxLine: number): number[] {
  if (n <= 0) return hitLines;
  if (hitLines.length === 0) return [];
  const set = new Set<number>();
  for (const ln of hitLines) {
    const lo = Math.max(1, ln - n);
    const hi = Math.min(maxLine, ln + n);
    for (let i = lo; i <= hi; i++) set.add(i);
  }
  return [...set];
}
