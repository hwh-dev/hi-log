import { useRef, useState } from "react";

export interface Pin {
  id: number;
  /** 1-based 行号 */
  line_no: number;
  group_id: number | null;
  /** 自定义名称(可空;显示优先于行号) */
  name: string;
  created_at: number;
}

export interface PinGroup {
  id: number;
  name: string;
}

interface Props {
  groups: PinGroup[];
  /** 按 list_pins 返回顺序(组内已按 position 排序) */
  pins: Pin[];
  /** 行号(1-based) → 行文本,固定行的内容预览 */
  lineText: Record<number, string>;
  onJump: (lineNo0: number) => void;
  onUnpin: (pinId: number) => void;
  /** 重命名固定(名称由调用方 prompt 输入) */
  onRename: (pinId: number) => void;
  /** 新建分组(名称由调用方 prompt 输入) */
  onNewGroup: () => void;
  onDeleteGroup: (groupId: number) => void;
  /** 组内全量重排(拖拽排序结果) */
  onReorder: (groupId: number, orderedIds: number[]) => void;
  /** 跨组移动(拖到分组标题) */
  onMoveToGroup: (pinId: number, groupId: number) => void;
}

/**
 * 固定面板:书签风格的分组固定列表(Notepad++/klogg)。
 * 组内行可拖拽排序;拖到其他分组标题上即移入该组;点击跳转,× 取消固定。
 */
export default function PinsPanel({
  groups,
  pins,
  lineText,
  onJump,
  onUnpin,
  onRename,
  onNewGroup,
  onDeleteGroup,
  onReorder,
  onMoveToGroup,
}: Props) {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const dragIdRef = useRef<number | null>(null);

  const pinsIn = (groupId: number) =>
    pins.filter((p) => p.group_id === groupId);

  /** 组内重排:把 dragId 移到 targetId 前(或后) */
  const reorderInGroup = (groupId: number, dragId: number, targetId: number, before: boolean) => {
    const ids = pinsIn(groupId).map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(ids.indexOf(targetId) + (before ? 0 : 1), 0, dragId);
    onReorder(groupId, ids);
  };

  return (
    <aside className="pins-panel">
      <div className="pins-header">
        <span className="pins-title">PINS</span>
        <button className="pins-new" onClick={() => onNewGroup()} title="新建分组">
          + 分组
        </button>
      </div>
      {groups.length === 0 ? (
        <div className="pins-empty">
          右键日志行固定
          <br />
          可分组并拖拽排序
        </div>
      ) : (
        <div className="pins-groups">
          {groups.map((g) => {
            const list = pinsIn(g.id);
            return (
              <div key={g.id} className="pin-group">
                {/* 分组标题:跨组拖拽的放置目标 */}
                <div
                  className="pin-group-title"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = dragIdRef.current;
                    if (id != null) onMoveToGroup(id, g.id);
                  }}
                >
                  <span className="pin-group-name">📌 {g.name}</span>
                  <span className="pin-group-count">{list.length}</span>
                  <button
                    className="pin-group-del"
                    title="删除分组(组内固定移到默认组)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteGroup(g.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                {list.map((p) => (
                  <div
                    key={p.id}
                    className={`pin-item${draggingId === p.id ? " dragging" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      dragIdRef.current = p.id;
                      setDraggingId(p.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(p.id));
                    }}
                    onDragEnd={() => {
                      dragIdRef.current = null;
                      setDraggingId(null);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = dragIdRef.current;
                      if (id == null || id === p.id) return;
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      reorderInGroup(g.id, id, p.id, e.clientY < rect.top + rect.height / 2);
                    }}
                    onClick={() => onJump(p.line_no - 1)}
                    title={p.name ? `${p.name} — 第 ${p.line_no} 行` : `第 ${p.line_no} 行`}
                  >
                    <span className={`pin-item-no${p.name ? " named" : ""}`}>
                      {p.name ? p.name : `L${p.line_no.toLocaleString()}`}
                    </span>
                    <button
                      className="pin-item-rename"
                      aria-label="重命名固定"
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRename(p.id);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="pin-item-remove"
                      aria-label="取消固定"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnpin(p.id);
                      }}
                    >
                      ×
                    </button>
                    <span className="pin-item-text">
                      {p.name ? `L${p.line_no.toLocaleString()} · ${lineText[p.line_no] ?? ""}` : lineText[p.line_no] ?? ""}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
