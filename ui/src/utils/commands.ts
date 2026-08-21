import { getSettings } from "./settings";

/**
 * 命令系统 + 快捷键:把高频交互抽象为命令注册表(渐进式 —— 现有按钮/调用点保留,
 * 命令只是补充触发路径;未注册的命令 dispatch 静默 no-op)。纯 TS,可单测。
 */

export type CommandId =
  | "openSettings"
  | "toggleTheme"
  | "toggleTail"
  | "focusSearch"
  | "nextHit"
  | "prevHit"
  | "toggleFilterPanel"
  | "toggleSidebar"
  | "openFile"
  | "closeFile"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom";

export interface CommandDef {
  id: CommandId;
  label: string;
  defaultBinding: string | null;
}

export const COMMANDS: CommandDef[] = [
  { id: "openSettings", label: "打开设置", defaultBinding: "Ctrl+K" },
  { id: "focusSearch", label: "聚焦搜索栏", defaultBinding: "Ctrl+F" },
  { id: "nextHit", label: "下一个命中", defaultBinding: "F6" },
  { id: "prevHit", label: "上一个命中", defaultBinding: "Shift+F6" },
  { id: "toggleTail", label: "切换 tail 模式", defaultBinding: "Ctrl+T" },
  { id: "toggleTheme", label: "切换主题", defaultBinding: "Ctrl+Shift+T" },
  { id: "openFile", label: "打开文件", defaultBinding: "Ctrl+O" },
  { id: "closeFile", label: "关闭当前文件", defaultBinding: "Ctrl+W" },
  { id: "toggleFilterPanel", label: "显示/隐藏命中面板", defaultBinding: "Ctrl+Shift+F" },
  { id: "toggleSidebar", label: "显示/隐藏侧栏", defaultBinding: "Ctrl+Shift+B" },
  { id: "zoomIn", label: "放大字号", defaultBinding: "Ctrl+=" },
  { id: "zoomOut", label: "缩小字号", defaultBinding: "Ctrl+-" },
  { id: "resetZoom", label: "重置字号", defaultBinding: "Ctrl+0" },
];

export const DEFAULT_BINDINGS: Record<CommandId, string | null> = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c.defaultBinding]),
) as Record<CommandId, string | null>;

// ── 绑定解析/格式化(纯函数)──

export interface Binding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** 禁止绑定的键(系统/交互保留) */
const RESERVED_KEYS = new Set(["Esc", "Enter", "Tab", "Space"]);
/** 纯修饰键:单独按下不构成绑定 */
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/**
 * 键名规范化:字母/数字大写,F1-F12 保持,方向键/符号统一。
 * 同时接受"存储形态"(Up)与"事件形态"(ArrowUp),保证 parseBinding(读存储)
 * 与 matchBinding(读 KeyboardEvent)双向一致。
 */
export function normalizeKey(k: string): string | null {
  if (k.length === 1 && /[a-zA-Z0-9]/.test(k)) return k.toUpperCase();
  switch (k) {
    case "=":
    case "-":
    case "+":
    case ".":
    case ",":
    case ";":
    case "/":
      return k;
    case "Escape":
    case "Esc":
      return "Esc";
    case "ArrowUp":
    case "Up":
      return "Up";
    case "ArrowDown":
    case "Down":
      return "Down";
    case "ArrowLeft":
    case "Left":
      return "Left";
    case "ArrowRight":
    case "Right":
      return "Right";
    default:
      return /^F([1-9]|1[0-2])$/.test(k) ? k : null;
  }
}

/** "Ctrl+Shift+F6" / "F6" / "Ctrl+=" → Binding;非法(保留键/纯修饰键/未知部分)返回 null */
export function parseBinding(s: string): Binding | null {
  if (!s || !s.trim()) return null;
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = normalizeKey(parts[parts.length - 1] ?? "");
  if (!key || RESERVED_KEYS.has(key)) return null;
  const mods = parts.slice(0, -1);
  if (new Set(mods).size !== mods.length) return null; // 重复修饰键
  const b: Binding = { ctrl: false, alt: false, shift: false, meta: false, key };
  for (const m of mods) {
    if (m === "Ctrl") b.ctrl = true;
    else if (m === "Alt") b.alt = true;
    else if (m === "Shift") b.shift = true;
    else if (m === "Meta") b.meta = true;
    else return null;
  }
  return b;
}

export function formatBinding(b: Binding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  if (b.meta) parts.push("Meta");
  parts.push(b.key);
  return parts.join("+");
}

export function matchBinding(e: KeyboardEvent, b: Binding): boolean {
  return (
    e.ctrlKey === b.ctrl &&
    e.altKey === b.alt &&
    e.shiftKey === b.shift &&
    e.metaKey === b.meta &&
    (normalizeKey(e.key) ?? "") === b.key
  );
}

/** 用户存储值 + 默认表合并(用户覆盖默认;null 显式解除;非法值视为未绑) */
export function resolveBindings(
  stored: Record<string, string | null>,
): Record<CommandId, string | null> {
  const out: Record<string, string | null> = { ...DEFAULT_BINDINGS };
  for (const [id, v] of Object.entries(stored)) {
    if (!(id in DEFAULT_BINDINGS)) continue;
    if (v === null) {
      out[id] = null;
      continue;
    }
    if (parseBinding(v)) out[id] = v;
  }
  return out as Record<CommandId, string | null>;
}

/** 与新绑定撞键的命令列表(排除自身;传入 resolveBindings 后的绑定表) */
export function findBindingConflicts(
  bindings: Record<CommandId, string | null>,
  targetId: CommandId,
  b: Binding,
): CommandId[] {
  const fmt = formatBinding(b);
  return COMMANDS.filter((c) => c.id !== targetId && bindings[c.id] === fmt).map((c) => c.id);
}

// ── 执行器注册表 + 全局分发(仅主窗口 App 注册/启动一次)──

const executors = new Map<CommandId, () => void>();

/** 注册命令执行器;返回注销函数 */
export function registerCommand(id: CommandId, fn: () => void): () => void {
  executors.set(id, fn);
  return () => {
    if (executors.get(id) === fn) executors.delete(id);
  };
}

export function dispatchCommand(id: CommandId): void {
  executors.get(id)?.();
}

let dispatcherStarted = false;

/**
 * 全局键盘分发(主窗口调用一次):
 * - 输入框/文本域内:无修饰键的单键绑定不触发(不吞打字);
 * - 任一 .modal-overlay 打开时不触发(弹窗内不抢键;快捷键捕获态另有 capture 拦截);
 * - 命中绑定 → preventDefault(拦截 WebView 默认行为如 Ctrl+F 查找)+ 执行。
 */
export function initCommandDispatcher(): void {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
    if (!e.ctrlKey && !e.altKey && !e.metaKey && typing) return;
    if (document.querySelector(".modal-overlay") !== null) return;
    const bindings = resolveBindings(getSettings().keybindings);
    for (const c of COMMANDS) {
      const raw = bindings[c.id];
      if (!raw) continue;
      const b = parseBinding(raw);
      if (b && matchBinding(e, b)) {
        e.preventDefault();
        dispatchCommand(c.id);
        return;
      }
    }
  });
}

export { MODIFIER_KEYS };
