import { useEffect, useState } from "react";
import {
  getSettings,
  setSetting,
  useSettings,
  rowHeight,
  type AppSettings,
  type ThemeSetting,
  type EncodingSetting,
} from "../utils/settings";
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  MODIFIER_KEYS,
  normalizeKey,
  parseBinding,
  resolveBindings,
  findBindingConflicts,
  type CommandId,
} from "../utils/commands";

interface Props {
  onClose: () => void;
}

type TabId = "appearance" | "search" | "files" | "keys";

const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "search", label: "搜索" },
  { id: "files", label: "文件" },
  { id: "keys", label: "快捷键" },
];

const THEME_OPTIONS: { v: ThemeSetting; label: string }[] = [
  { v: "dark", label: "深色" },
  { v: "light", label: "浅色" },
  { v: "system", label: "跟随系统" },
];

const FONT_OPTIONS: { v: string; label: string }[] = [
  { v: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace', label: "Cascadia Code(默认)" },
  { v: '"JetBrains Mono", "Cascadia Code", Consolas, monospace', label: "JetBrains Mono" },
  { v: '"Fira Code", "JetBrains Mono", Consolas, monospace', label: "Fira Code" },
  { v: "Consolas, 'Courier New', monospace", label: "Consolas" },
  { v: "'DejaVu Sans Mono', 'Ubuntu Mono', monospace", label: "DejaVu Sans Mono" },
  { v: "monospace", label: "系统等宽" },
];

const ENCODING_OPTIONS: { v: EncodingSetting; label: string }[] = [
  { v: "auto", label: "自动检测(推荐)" },
  { v: "utf8", label: "UTF-8" },
  { v: "gbk", label: "GBK" },
  { v: "utf16", label: "UTF-16" },
];

/** 设置行:左 label+描述,右控件 */
function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label-col">
        <span className="settings-label">{label}</span>
        {desc && <span className="settings-desc">{desc}</span>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Stepper({
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="settings-stepper">
      <button onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <span className="settings-stepper-value">
        {value}
        {unit ?? ""}
      </span>
      <button onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`settings-toggle ${checked ? "active" : ""}`}
      onClick={() => onChange(!checked)}
    >
      {checked ? "开" : "关"}
    </button>
  );
}

/** 快捷键页签:行 = 命令 + 当前绑定;点击进入捕获态,冲突检测,可恢复默认 */
function KeyBindingsTab() {
  const keybindings = useSettings((s) => s.keybindings);
  const bindings = resolveBindings(keybindings);
  const [capturing, setCapturing] = useState<CommandId | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const setBinding = (id: CommandId, v: string | null) => {
    setSetting("keybindings", { ...getSettings().keybindings, [id]: v });
  };

  useEffect(() => {
    if (capturing === null) return;
    // capture 阶段 + stopPropagation:先于全局命令分发器与弹窗 Esc 监听
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setBinding(capturing, null);
        setCapturing(null);
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return; // 纯修饰键按下忽略
      const key = normalizeKey(e.key);
      if (!key) return;
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Meta");
      parts.push(key);
      const b = parseBinding(parts.join("+"));
      if (!b) return;
      const hits = findBindingConflicts(bindings, capturing, b);
      if (hits.length > 0) {
        const names = hits.map((id) => COMMANDS.find((c) => c.id === id)?.label ?? id);
        setConflict(`与「${names.join("、")}」冲突,未保存`);
        return;
      }
      setConflict(null);
      setBinding(capturing, parts.join("+"));
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  return (
    <div className="settings-body">
      {COMMANDS.map((c) => {
        const bound = bindings[c.id];
        const isCapturing = capturing === c.id;
        return (
          <div className="settings-row" key={c.id}>
            <span className="settings-label">{c.label}</span>
            <div className="settings-control">
              <button
                className={`settings-key-bind ${isCapturing ? "capturing" : ""} ${!bound ? "unbound" : ""}`}
                title={isCapturing ? "按下新快捷键(Esc 取消,Backspace 清除)" : "点击设置快捷键"}
                onClick={() => {
                  setCapturing(isCapturing ? null : c.id);
                  setConflict(null);
                }}
              >
                {isCapturing ? "按下快捷键…" : (bound ?? "未绑定")}
              </button>
              <button
                className="settings-key-reset"
                title="恢复默认绑定"
                onClick={() => {
                  setBinding(c.id, DEFAULT_BINDINGS[c.id]);
                  setConflict(null);
                }}
              >
                默认
              </button>
            </div>
          </div>
        );
      })}
      {conflict && <div className="settings-conflict">{conflict}</div>}
      <div className="settings-reset-all">
        <button
          className="modal-btn"
          onClick={() => {
            setSetting("keybindings", {});
            setConflict(null);
          }}
        >
          全部恢复默认
        </button>
      </div>
    </div>
  );
}

/**
 * 设置弹窗(标题栏 ⚙ 打开):页签式,改动即生效并跨窗口广播(popout 实时跟随)。
 * Esc / 点击遮罩关闭(与 PromptModal 同模式)。
 */
export default function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<TabId>("appearance");
  const s = useSettings((s) => s);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setSetting(key, value);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal settings-modal" role="dialog" aria-modal="true">
        <div className="modal-title">设置</div>
        <div className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab ${tab === t.id ? "active" : ""}`}
              autoFocus={t.id === "appearance"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "appearance" && (
          <div className="settings-body">
            <Row label="主题" desc="深色 / 浅色 / 跟随系统配色">
              <Select value={s.theme} options={THEME_OPTIONS} onChange={(v) => set("theme", v)} />
            </Row>
            <Row label="字体" desc="日志视口与搜索栏等宽字体">
              <Select value={s.fontFamily} options={FONT_OPTIONS} onChange={(v) => set("fontFamily", v)} />
            </Row>
            <Row label="字号" desc="日志与面板字号,范围 11-16px">
              <Stepper value={s.fontSize} min={11} max={16} step={1} unit="px" onChange={(v) => set("fontSize", v)} />
            </Row>
            <Row label="行距" desc={`行高 = 字号 + 行距(当前 ${rowHeight(s)}px)`}>
              <Stepper value={s.rowSpacing} min={5} max={14} step={1} unit="px" onChange={(v) => set("rowSpacing", v)} />
            </Row>
          </div>
        )}

        {tab === "search" && (
          <div className="settings-body">
            <Row label="默认启用正则" desc="新搜索默认勾选 .* 正则">
              <Toggle checked={s.regexDefault} onChange={(v) => set("regexDefault", v)} />
            </Row>
            <Row label="默认区分大小写" desc="新搜索默认勾选 Aa">
              <Toggle checked={s.caseDefault} onChange={(v) => set("caseDefault", v)} />
            </Row>
            <Row label="上下文行数" desc="命中行前后各显示 ±N 行,0 = 关闭">
              <Stepper value={s.contextLines} min={0} max={10} step={1} unit=" 行" onChange={(v) => set("contextLines", v)} />
            </Row>
            <Row label="搜索历史上限" desc="▼ 下拉最多保留的搜索词数量">
              <Stepper value={s.searchHistoryMax} min={10} max={200} step={10} onChange={(v) => set("searchHistoryMax", v)} />
            </Row>
          </div>
        )}

        {tab === "files" && (
          <div className="settings-body">
            <Row label="打开时自动进入 tail" desc="新打开文件即跟随末尾">
              <Toggle checked={s.openTailMode} onChange={(v) => set("openTailMode", v)} />
            </Row>
            <Row label="启动恢复上次文件" desc="启动时自动打开上次关闭的文件">
              <Toggle checked={s.restoreLastFile} onChange={(v) => set("restoreLastFile", v)} />
            </Row>
            <Row label="tail 轮询间隔" desc="检测文件追加的周期">
              <Stepper value={s.tailPollMs} min={500} max={10000} step={500} unit="ms" onChange={(v) => set("tailPollMs", v)} />
            </Row>
            <Row label="启动检查更新" desc="启动 3 秒后静默检查新版本">
              <Toggle checked={s.checkUpdateOnStart} onChange={(v) => set("checkUpdateOnStart", v)} />
            </Row>
            <Row label="编码" desc="打开文件时生效;切换后需重新打开文件">
              <Select value={s.encoding} options={ENCODING_OPTIONS} onChange={(v) => set("encoding", v)} />
            </Row>
          </div>
        )}

        {tab === "keys" && <KeyBindingsTab />}
      </div>
    </div>
  );
}
