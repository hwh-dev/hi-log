import { useEffect } from "react";

interface Props {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 自绘确认弹窗(替换原生 window.confirm,跟随主题)。
 * 确定按钮默认聚焦,Enter 即确认;Esc / 点击遮罩取消。
 */
export default function ConfirmModal({
  title,
  message,
  okLabel,
  cancelLabel,
  onConfirm,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="alertdialog" aria-modal="true">
        <div className="modal-title">{title}</div>
        <div className="modal-message">{message}</div>
        <div className="modal-actions">
          <button className="modal-btn" onClick={onClose}>
            {cancelLabel ?? "取消"}
          </button>
          <button className="modal-btn primary" autoFocus onClick={onConfirm}>
            {okLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
