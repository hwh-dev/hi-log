import { useEffect, useRef, useState } from "react";

export interface Pin {
  id: number;
  /** 1-based 行号 */
  line_no: number;
  group_id: number | null;
  /** 自定义名称(可空;显示优先于行号) */
  name: string;
  /** 组内排序序号(拖拽重排写入) */
  position: number;
  /** unix 秒 */
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
  /** 分组全量重排(拖拽分组顺序) */
  onReorderGroups: (orderedGroupIds: number[]) => void;
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
  onReorderGroups,
}: Props) {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const dragIdRef = useRef<number | null>(null);
  // 折叠的分组 id 集合(空 = 全展开);分组标题箭头点击切换
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // 分组排序拖拽(指针事件):dragGroupId 仅作视觉,dragStateRef 记录拖拽状态
  const [dragGroupId, setDragGroupId] = useState<number | null>(null);
  const dragStateRef = useRef<{ groupId: number; startX: number; startY: number; moved: boolean } | null>(null);

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

  /** 分组重排(拖拽排序):把 dragId 移到 targetId 前(或后) */
  const reorderGroups = (dragId: number, targetId: number, before: boolean) => {
    const ids = groups.map((g) => g.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(ids.indexOf(targetId) + (before ? 0 : 1), 0, dragId);
    onReorderGroups(ids);
  };

  const toggleCollapse = (groupId: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  /** 在 ⠿ 手柄上按下:开始分组拖拽(指针事件,绕开标题内可点击按钮,可靠) */
  const startGroupDrag = (groupId: number, e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // 箭头/删除不触发拖拽
    e.preventDefault();
    dragStateRef.current = { groupId, startX: e.clientX, startY: e.clientY, moved: false };
  };

  // 全局 pointermove/up:手动拖拽分组排序(事件挂 window,拖出标题仍能跟踪落点)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (!st.moved) {
        if (Math.abs(e.clientX - st.startX) < 6 && Math.abs(e.clientY - st.startY) < 6) return;
        st.moved = true;
        setDragGroupId(st.groupId);
      }
      // 元素命中的分组标题悬停高亮(标了 data-group-id)
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const title = el?.closest(".pin-group-title") as HTMLElement | null;
      const gid = title ? Number(title.dataset.groupId) : null;
      for (const t of Array.from(document.querySelectorAll<HTMLElement>(".pin-group-title"))) {
        t.classList.toggle("drop-target", gid != null && Number(t.dataset.groupId) === gid);
      }
    };
    const onUp = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (st) {
        if (st.moved) {
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const title = el?.closest(".pin-group-title") as HTMLElement | null;
          const gid = title ? Number(title.dataset.groupId) : null;
          if (title && gid != null && gid !== st.groupId) {
            const rect = title.getBoundingClientRect();
            reorderGroups(st.groupId, gid, e.clientY < rect.top + rect.height / 2);
          }
        }
        dragStateRef.current = null;
        setDragGroupId(null);
      }
      for (const t of Array.from(document.querySelectorAll<HTMLElement>(".pin-group-title"))) {
        t.classList.remove("drop-target");
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [reorderGroups]);

  return (
    <aside className="pins-panel">
      <div className="pins-header">
        <span className="pins-title">固定</span>
        <button className="pins-new" onClick={() => onNewGroup()} title="新建分组">
          ＋ 分组
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
                {/* 分组标题:可折叠 + 组内跨组拖拽目标 + 分组拖拽排序(⠿ 手柄) */}
                <div
                  className={`pin-group-title${dragGroupId === g.id ? " dragging" : ""}`}
                  data-group-id={g.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    // 组内 pin 拖到标题 → 移入该组;分组排序走指针拖拽(不经此处)
                    if (dragIdRef.current != null) onMoveToGroup(dragIdRef.current, g.id);
                  }}
                >
                  <span
                    className="pin-group-drag"
                    title="拖拽排序分组"
                    onPointerDown={(e) => startGroupDrag(g.id, e)}
                  >
                    ⠿
                  </span>
                  <button
                    className="pin-group-arrow"
                    title={collapsed.has(g.id) ? "展开" : "折叠"}
                    draggable={false}
                    onDragStart={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(g.id);
                    }}
                  >
                    {collapsed.has(g.id) ? "▶" : "▼"}
                  </button>
                  <span className="pin-group-name" onClick={() => toggleCollapse(g.id)}>
                    {g.name}
                  </span>
                  <span className="pin-group-count">{list.length}</span>
                  <button
                    className="pin-group-del"
                    title="删除分组(组内固定移到默认组)"
                    draggable={false}
                    onDragStart={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteGroup(g.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                {!collapsed.has(g.id) &&
                  list.map((p) => (
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
                    {p.name && (
                      <span className="pin-item-meta">L{p.line_no.toLocaleString()}</span>
                    )}
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
                    <span className="pin-item-text">{lineText[p.line_no] ?? ""}</span>
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
