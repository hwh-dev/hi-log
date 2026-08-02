import { PALETTE_NAMES, paletteColor, type Mark } from "../utils/palette";
import type { PinGroup } from "./PinsPanel";

interface Props {
  x: number;
  y: number;
  /** 1-based 行号 */
  lineNo: number;
  /** 该行已有的标记(无则 null) */
  mark: Mark | null;
  onMark: (color: number) => void;
  onNote: () => void;
  onClear: () => void;
  /** 固定分组列表(含默认组) */
  pinGroups: PinGroup[];
  /** 该行已固定的分组(未固定则 null) */
  pinnedGroup: PinGroup | null;
  /** 固定到分组(名称由调用方 prompt,可为空) */
  onPin: (groupId: number) => void;
  onUnpin: () => void;
  /** 重命名该行固定 */
  onRenamePin: () => void;
  /** 新建分组并固定到新组 */
  onNewGroupAndPin: () => void;
  onClose: () => void;
}

/** 日志行右键菜单:标记颜色 / 备注 / 固定到分组 */
export default function ContextMenu({
  x,
  y,
  lineNo,
  mark,
  onMark,
  onNote,
  onClear,
  pinGroups,
  pinnedGroup,
  onPin,
  onUnpin,
  onRenamePin,
  onNewGroupAndPin,
  onClose,
}: Props) {
  const menuW = 224;
  const menuH =
    36 + 36 + (mark ? 26 : 0) + 34 + Math.min(pinGroups.length, 5) * 24 + 26 + (pinnedGroup ? 52 : 0) + 8;
  const style: React.CSSProperties = {
    left: Math.max(4, Math.min(x, window.innerWidth - menuW)),
    top: Math.max(4, Math.min(y, window.innerHeight - menuH)),
    maxHeight: "calc(100vh - 16px)",
    overflowY: "auto",
  };

  return (
    <div
      className="ctx-backdrop"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="ctx-menu" style={style} onClick={(e) => e.stopPropagation()}>
        <div className="ctx-title">第 {lineNo.toLocaleString()} 行</div>
        <div className="ctx-colors">
          {PALETTE_NAMES.map((name, i) => (
            <button
              key={i}
              className={`ctx-color${mark?.color === i ? " selected" : ""}`}
              style={{ background: paletteColor(i) }}
              title={name}
              aria-label={`标记为${name}`}
              onClick={() => onMark(i)}
            />
          ))}
        </div>
        <button className="ctx-item" onClick={onNote}>
          {mark?.note ? "修改备注…" : "写备注…"}
        </button>
        {mark && (
          <button className="ctx-item danger" onClick={onClear}>
            清除标记
          </button>
        )}

        {/* ── 固定(独立于颜色标记的书签功能)── */}
        <div className="ctx-pins-label">📌 固定</div>
        {pinGroups.map((g) => (
          <button
            key={g.id}
            className={`ctx-item${pinnedGroup?.id === g.id ? " pinned" : ""}`}
            onClick={() => onPin(g.id)}
          >
            {g.name}
            {pinnedGroup?.id === g.id ? " ✓" : ""}
          </button>
        ))}
        <button className="ctx-item" onClick={onNewGroupAndPin}>
          新建分组并固定…
        </button>
        {pinnedGroup && (
          <>
            <button className="ctx-item" onClick={onRenamePin}>
              重命名固定…
            </button>
            <button className="ctx-item danger" onClick={onUnpin}>
              取消固定
            </button>
          </>
        )}
      </div>
    </div>
  );
}
