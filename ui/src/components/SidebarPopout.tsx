import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import SnapshotsPanel from "./SnapshotsPanel";
import PromptModal, { type PromptConfig } from "./PromptModal";
import { loadSnapshots, saveSnapshots, type Snapshot } from "../utils/snapshots";

const appWindow = getCurrentWindow();

/**
 * 独立窗口版侧栏(label: sidebar-popout):快照。
 * 快照存 localStorage,与主窗口同源,直接读;
 * 快照改动广播 snapshots_changed 双向同步;跳转 → goto_line 回主窗口。
 */
export default function SidebarPopout() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>(loadSnapshots);
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null);
  const fileIdRef = useRef<string | null>(null);

  // 挂载后通知主窗口回发 fileId
  useEffect(() => {
    void appWindow.emit("panel_ready", { kind: "sidebar" });
  }, []);

  const persistSnapshots = useCallback((next: Snapshot[]) => {
    saveSnapshots(next);
    void appWindow.emit("snapshots_changed");
  }, []);

  // 主窗口回发 fileId
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ fileId: string }>("sidebar_snapshot", (e) => {
      fileIdRef.current = e.payload.fileId;
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, []);

  // 快照变更广播 → 重读 localStorage
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("snapshots_changed", () => {
      setSnapshots(loadSnapshots());
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, []);

  const jump = useCallback((lineNo0: number) => {
    void appWindow.emitTo("main", "goto_line", lineNo0);
  }, []);

  const addSnapshot = useCallback(() => {
    // popout 无日志视图,固定动作委托主窗口(用主视图当前行)
    void appWindow.emitTo("main", "snapshot_add");
  }, []);

  const removeSnapshot = useCallback(
    (id: number) => {
      setSnapshots((prev) => {
        const next = prev.filter((s) => s.id !== id);
        persistSnapshots(next);
        return next;
      });
    },
    [persistSnapshots],
  );

  const renameSnapshot = useCallback(
    (id: number) => {
      const target = snapshots.find((s) => s.id === id);
      if (!target) return;
      setPromptCfg({
        title: "重命名快照",
        initial: target.name,
        placeholder: "快照名称",
        okLabel: "保存",
        onSubmit: (name) => {
          setSnapshots((prev) => {
            const next = prev.map((s) => (s.id === id ? { ...s, name } : s));
            persistSnapshots(next);
            return next;
          });
        },
      });
    },
    [snapshots, persistSnapshots],
  );

  return (
    <div className="popout">
      <div className="popout-header">
        <span className="popout-title">SNAPSHOTS</span>
        <span className="popout-spacer" />
        <button className="popout-close" onClick={() => appWindow.close()} title="关闭窗口">
          ×
        </button>
      </div>
      <div className="popout-body sidebar">
        <SnapshotsPanel
          snapshots={snapshots}
          onAdd={addSnapshot}
          onJump={jump}
          onRemove={removeSnapshot}
          onRename={renameSnapshot}
        />
      </div>
      {promptCfg && <PromptModal {...promptCfg} onClose={() => setPromptCfg(null)} />}
    </div>
  );
}
