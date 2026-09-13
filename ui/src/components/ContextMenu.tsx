import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PALETTE_NAMES, paletteColor, type Mark } from "../utils/palette";

/** 首帧测量前的兜底尺寸(仅用于初始定位,测量后立刻被真实尺寸覆盖) */
const MENU_W_MAX = 224;
const MENU_H_EST = 300;

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
  /** 复制整行(无选区时可用);缺省不显示 */
  onCopyLine?: () => void;
  /** 把选中文本加为高亮规则;缺省不显示 */
  onHighlight?: () => void;
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
  onCopyLine,
  onHighlight,
}: Props) {
  // Esc 关闭(菜单是浮层,点空白处能关但键盘关不掉)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 位置靠**实测**菜单尺寸来钳制,不再手写高度常量 ——
  // 以前每加一个菜单项都要同步改那个常量,漏改就会在贴底右键时溢出、末项看不见。
  // useLayoutEffect 在浏览器绘制前完成测量与重定位,用户看不到中间态。
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
    left: Math.max(4, Math.min(x, window.innerWidth - MENU_W_MAX)),
    top: Math.max(4, Math.min(y, window.innerHeight - MENU_H_EST)),
  }));
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const w = el.offsetWidth || MENU_W_MAX;
    const h = el.offsetHeight || MENU_H_EST;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    });
  }, [x, y]);
  const style: React.CSSProperties = {
    ...pos,
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
      <div ref={menuRef} className="ctx-menu" style={style} onClick={(e) => e.stopPropagation()}>
        <div className="ctx-title">第 {lineNo.toLocaleString()} 行</div>
        {onCopy && (
          <button className="ctx-item" onClick={onCopy}>
            复制选中文本
          </button>
        )}
        {onHighlight && (
          <button className="ctx-item" onClick={onHighlight}>
            高亮选中文本
          </button>
        )}
        {onCopyLine && (
          <button className="ctx-item" onClick={onCopyLine}>
            复制整行
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
