import { memo, useState } from "react";
import type { Pin, PinGroup } from "./PinsPanel";
import { useSettings, setSetting, type PinsSortSetting } from "../utils/settings";

/** 单个文件的固定数据块(侧栏聚合用;groups 字段保留兼容旧数据,UI 不再分组) */
export interface FilePinsBlock {
  fileId: string;
  path: string;
  groups: PinGroup[];
  pins: Pin[];
  lineText: Record<number, string>;
}

interface Props {
  /** 所有打开文件的固定聚合(按打开顺序) */
  files: FilePinsBlock[];
  activeFileId: string | null;
  /** 点击固定项:切到对应文件并滚到该行 */
  onJump: (fileId: string, lineNo0: number) => void;
  /** true=按文件分节;false=所有文件固定合并平铺(更直观) */
  byFile: boolean;
  /** 区段头上的视图切换(按文件分节 ⇄ 合并);缺省不显示按钮 */
  onToggleView?: () => void;
  /** 侧栏内编辑/删除固定(按钮 hover 展示) */
  onUnpin?: (fileId: string, pinId: number) => void;
  onRenamePin?: (fileId: string, pinId: number) => void;
  /** 手动拖拽重排(仅"手动"排序 + 分节模式);ids 为新顺序 */
  onReorder?: (fileId: string, ids: number[]) => void;
}

const SORT_LABEL: Record<PinsSortSetting, string> = { time: "时间", line: "行号", custom: "手动" };
const SORT_NEXT: Record<PinsSortSetting, PinsSortSetting> = { time: "line", line: "custom", custom: "time" };

/** 按规则排序;自定义(custom)= 保持 list_pins 的 position 原序 */
function sortPins(pins: Pin[], mode: PinsSortSetting): Pin[] {
  if (mode === "custom") return pins;
  const arr = [...pins];
  if (mode === "time") arr.sort((a, b) => a.created_at - b.created_at || a.position - b.position);
  else arr.sort((a, b) => a.line_no - b.line_no);
  return arr;
}

/**
 * 固定聚合面板(VS Code 风区段):区段头可整体折叠;内容按文件分节/合并平铺,
 * 点击跳转;hover 可重命名/取消固定;排序=标记时间/文件中顺序/手动拖拽(仅分节+手动时可拖)。
 * 分组概念已从 UI 撤销(数据兼容保留)。
 */
function PinsAggregate({
  files,
  activeFileId,
  onJump,
  byFile,
  onToggleView,
  onUnpin,
  onRenamePin,
  onReorder,
}: Props) {
  // 区段折叠(整体)
  const [sectionCollapsed, setSectionCollapsed] = useState(false);
  // 当前排序规则(全局设置,三窗口统一)
  const pinsSort = useSettings((s) => s.pinsSort);
  // 拖拽状态
  const [dragId, setDragId] = useState<number | null>(null);

  const total = files.reduce((n, f) => n + f.pins.length, 0);
  const draggable = byFile && pinsSort === "custom" && !!onReorder;

  /** 把 dragId 项移动到 overId 项之前,产出新 ids 顺序 */
  const handleDrop = (fileId: string, overId: number) => {
    const f = files.find((x) => x.fileId === fileId);
    if (!f || dragId == null) return;
    const list = sortPins(f.pins, pinsSort);
    const from = list.findIndex((p) => p.id === dragId);
    const to = list.findIndex((p) => p.id === overId);
    if (from < 0 || to < 0 || from === to) return;
    const ids = list.map((p) => p.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    setDragId(null);
    onReorder?.(fileId, ids);
  };

  /** 单条固定项渲染(两种模式共用;fileTag=合并模式的文件名标签) */
  const item = (fileId: string, p: Pin, text: string, isDragging: boolean, fileTag?: string) => (
    <div
      key={`${fileId}:${p.id}`}
      className={`pin-item${isDragging ? " dragging" : ""}`}
      title={`${p.name || `L${p.line_no}`} — 第 ${p.line_no} 行`}
      draggable={draggable}
      onDragStart={(e) => {
        setDragId(p.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(p.id));
      }}
      onDragEnd={() => setDragId(null)}
      onDragOver={(e) => {
        if (dragId != null) e.preventDefault();
      }}
      onDrop={(e) => {
        if (dragId != null) {
          e.preventDefault();
          handleDrop(fileId, p.id);
        }
      }}
      onClick={() => onJump(fileId, p.line_no - 1)}
    >
      {fileTag && <span className="pin-item-file">{fileTag}</span>}
      {/* 行号永远做主显示(固定的身份),自定义名字降为次级标签 ——
          否则一个恰好长成数字的旧名字(如 "3131")会被误当成错误行号 */}
      <span className="pin-item-no">{`L${p.line_no.toLocaleString()}`}</span>
      {p.name && (
        <span className="pin-item-name" title={p.name}>
          {p.name}
        </span>
      )}
      <span className="pin-item-text">{text}</span>
      {onRenamePin && (
        <button
          className="pin-item-rename"
          title="重命名固定"
          onClick={(e) => {
            e.stopPropagation();
            onRenamePin(fileId, p.id);
          }}
        >
          ✎
        </button>
      )}
      {onUnpin && (
        <button
          className="pin-item-remove"
          title="取消固定"
          onClick={(e) => {
            e.stopPropagation();
            onUnpin(fileId, p.id);
          }}
        >
          ×
        </button>
      )}
    </div>
  );

  // 分节模式:每文件按规则排序平铺
  const byFileList = files.map((f) => ({ f, list: sortPins(f.pins, pinsSort) }));
  // 合并模式:跨文件平铺(时间/行号全局排序;手动=按文件顺序+内部 position,不可拖)
  const flat = byFile
    ? []
    : files
        .flatMap((f) =>
          sortPins(f.pins, pinsSort).map((p) => ({
            fileId: f.fileId,
            path: f.path,
            pin: p,
            text: f.lineText[p.line_no] ?? "",
          })),
        )
        .sort((a, b) =>
          pinsSort === "time"
            ? a.pin.created_at - b.pin.created_at || a.pin.position - b.pin.position
            : pinsSort === "line"
              ? a.pin.line_no - b.pin.line_no
              : 0,
        );

  return (
    <div className={`sidebar-section${sectionCollapsed ? " collapsed" : ""}`}>
      <div
        className="sidebar-section-head"
        onClick={() => setSectionCollapsed((v) => !v)}
        title={sectionCollapsed ? "展开固定" : "折叠固定"}
      >
        <button
          className="sidebar-section-arrow"
          onClick={(e) => {
            e.stopPropagation();
            setSectionCollapsed((v) => !v);
          }}
        >
          {sectionCollapsed ? "▶" : "▼"}
        </button>
        <span className="sidebar-section-title">固定</span>
        <span className="sidebar-section-count">{total}</span>
        <button
          className="section-view-toggle"
          title={`排序:${SORT_LABEL[pinsSort]} — 点击切换(标记时间 / 文件中顺序 / 手动拖拽)`}
          onClick={(e) => {
            e.stopPropagation();
            setSetting("pinsSort", SORT_NEXT[pinsSort]);
          }}
        >
          排序:{SORT_LABEL[pinsSort]}
        </button>
        {onToggleView && (
          <button
            className="section-view-toggle"
            title="切换:按文件分节 / 合并平铺"
            onClick={(e) => {
              e.stopPropagation();
              onToggleView();
            }}
          >
            {byFile ? "分节" : "合并"}
          </button>
        )}
      </div>
      {!sectionCollapsed &&
        (byFile ? (
          <div className="pins-aggregate">
            {byFileList.map(({ f, list }) => (
              <div key={f.fileId} className="pins-file">
                <div
                  className={`pins-file-head${f.fileId === activeFileId ? " active" : ""}`}
                  title={f.path}
                >
                  <span className="pins-file-name">{f.path.split(/[/\\]/).pop()}</span>
                  <span className="pins-file-count">{f.pins.length}</span>
                </div>
                {list.map((p) => item(f.fileId, p, f.lineText[p.line_no] ?? "", dragId === p.id))}
              </div>
            ))}
          </div>
        ) : (
          <div className="pins-aggregate">
            {flat.map(({ fileId, path, pin, text }) =>
              item(fileId, pin, text, false, path.split(/[/\\]/).pop()),
            )}
          </div>
        ))}
    </div>
  );
}

// memo:搜索/滚动只改 lineCache/sessions 时,聚合 props 不变,侧栏不再随 80ms flush 重渲染
export default memo(PinsAggregate);
