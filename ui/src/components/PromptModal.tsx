import { useEffect, useRef } from "react";

/** 弹窗配置:各调用点用 setPromptCfg 打开,onSubmit 在用户确认后执行 */
export interface PromptConfig {
  title: string;
  /** 标题下的说明文字(可省略) */
  hint?: string;
  placeholder?: string;
  initial?: string;
  /** 多行输入(备注用):Enter 换行,Ctrl+Enter 确认 */
  multiline?: boolean;
  okLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
}

interface Props extends PromptConfig {
  onClose: () => void;
}

/**
 * 自绘输入弹窗(替换原生 window.prompt,跟随主题)。
 * Enter 确认 / Esc 取消 / 点击遮罩取消;预填文本自动全选,直接输入即覆盖(原生行为)。
 */
export default function PromptModal({
  title,
  hint,
  placeholder,
  initial,
  multiline,
  okLabel,
  cancelLabel,
  onSubmit,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = multiline ? textareaRef.current : inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [multiline]);

  // Esc 走窗口级监听:输入框失焦(如弹窗窗口聚焦异常)时也能取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    const el = multiline ? textareaRef.current : inputRef.current;
    if (!el) return;
    onSubmit(el.value);
    onClose(); // 确认后关闭弹窗(原生 prompt 语义)
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">{title}</div>
        {hint && <div className="modal-hint">{hint}</div>}
        {multiline ? (
          <textarea
            ref={textareaRef}
            defaultValue={initial}
            placeholder={placeholder}
            rows={4}
            spellCheck={false}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
            }}
          />
        ) : (
          <input
            ref={inputRef}
            defaultValue={initial}
            placeholder={placeholder}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        )}
        <div className="modal-actions">
          <button className="modal-btn" onClick={onClose}>
            {cancelLabel ?? "取消"}
          </button>
          <button className="modal-btn primary" onClick={submit}>
            {okLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
