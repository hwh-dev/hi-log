import { useCallback, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  filePath: string;
  setFilePath: (v: string) => void;
  onOpen: () => void;
  onOpenPath: (p: string) => void;
  dropActive: boolean;
  recentFiles: string[];
}

export default function Welcome({
  filePath,
  setFilePath,
  onOpen,
  onOpenPath,
  dropActive,
  recentFiles,
}: Props) {
  const fileName = (p: string) => p.split(/[/\\]/).pop() ?? p;
  const [pickerError, setPickerError] = useState(false);

  /** 系统文件选择器:选中即打开(Windows 原生对话框) */
  const browse = useCallback(async () => {
    try {
      const picked = await open({
        // 指定父窗口:否则对话框可能出现在应用背后,造成"点了没反应+应用像卡死"
        parent: getCurrentWindow(),
        title: "选择日志文件",
        multiple: false,
        directory: false,
        filters: [
          { name: "日志文件", extensions: ["log", "txt", "out", "err"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string" && picked) onOpenPath(picked);
      setPickerError(false);
    } catch (e) {
      console.error("dialog open failed", e);
      // 失败可见:旧版本二进制缺少 dialog 插件时,原生对话框静默无法打开
      setPickerError(true);
      window.setTimeout(() => setPickerError(false), 4000);
    }
  }, [onOpenPath]);

  return (
    <div className={`welcome ${dropActive ? "drop-active" : ""}`}>
      <div className="drop-zone">
        <div className="logo">hi-log</div>
        <p className="hint">
          {dropActive ? "松开即可打开" : "拖入日志文件，或输入路径打开"}
        </p>
        <div className="path-row">
          <input
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onOpen()}
            placeholder="e.g. C:\logs\app.log"
            spellCheck={false}
          />
          <button className="path-browse" onClick={() => void browse()}>
            浏览…
          </button>
          <button onClick={onOpen}>Open</button>
        </div>
        {pickerError && <p className="path-error">无法打开文件选择器,请检查是否运行的是最新版本</p>}
      </div>

      <div className="recent">
        <div className="recent-title">最近打开</div>
        {recentFiles.length === 0 ? (
          <div className="recent-empty">没有最近打开的文件</div>
        ) : (
          recentFiles.map((p) => (
            <button key={p} className="recent-item" title={p} onClick={() => onOpenPath(p)}>
              <span className="recent-name">{fileName(p)}</span>
              <span className="recent-path">{p}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
