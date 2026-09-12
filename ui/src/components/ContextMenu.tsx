import { PALETTE_NAMES, paletteColor, type Mark } from "../utils/palette";

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
  /** 该行是否已固定(决定"固定/取消固定"文案) */
  pinned?: boolean;
  /** 固定/取消固定:一次点击零输入(默认组+无名称;改名去侧栏 hover) */
  onTogglePin?: () => void;
  /** 多行选中时批量标记(蓝色整行);缺省不显示 */
  onMarkRange?: () => void;
  /** 有选中文本时"复制选中文本";缺省不显示 */
  onCopy?: () => void;
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
  pinned,
  onTogglePin,
  onClose,
  onMarkRange,
  onCopy,
}: Props) {
  const menuW = 224;
  const menuH = 36 + 36 + (onMarkRange ? 28 : 0) + (onCopy ? 28 : 0) + 34 + 28 + 8;
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
        {onCopy && (
          <button className="ctx-item" onClick={onCopy}>
            复制选中文本
          </button>
        )}
        {onMarkRange && (
          <button className="ctx-item" onClick={onMarkRange}>
            标记选中的多行(蓝色)
          </button>
        )}
        {/* 颜色组 = [无] + 8 色。klogg 式:清除标记就是"选无色",
            不需要单独一个"清除标记"按钮。该行没有标记时"无"即选中态。
            ⚠️ "无"只在 UI 层,不能加进 PALETTE —— PALETTE 的下标与后端
            marks.color(u8) 严格对应,插入一项会让所有已存标记颜色错位。 */}
        <div className="ctx-colors">
          <button
            className={`ctx-color none${mark ? "" : " selected"}`}
            title="无(清除标记)"
            aria-label="清除标记"
            onClick={onClear}
          />
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

        {/* ── 固定/取消固定:一次点击零输入(改名去侧栏 hover)── */}
        <div className="ctx-pins-label">📌 固定</div>
        {onTogglePin && (
          <button className={`ctx-item${pinned ? " pinned" : ""}`} onClick={onTogglePin}>
            {pinned ? "取消固定" : "固定"}
          </button>
        )}
      </div>
    </div>
  );
}
