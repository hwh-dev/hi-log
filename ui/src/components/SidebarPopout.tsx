import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import SnapshotsPanel from "./SnapshotsPanel";
import PinsPanel, { type Pin, type PinGroup } from "./PinsPanel";
import PromptModal, { type PromptConfig } from "./PromptModal";
import { loadSnapshots, saveSnapshots, type Snapshot } from "../utils/snapshots";

const appWindow = getCurrentWindow();

interface LinePayload {
  text: string;
  line_no: number;
}

/**
 * 独立窗口版侧栏(label: sidebar-popout):快照 + 固定。
 * 快照存 localStorage,与主窗口同源直接读;固定走后端 IPC,
 * 与主窗口同一状态源,变更经 pins_changed 广播双向同步。
 * 跳转 → goto_line 回主窗口;固定动作(增删改)直接调后端。
 */
export default function SidebarPopout() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>(loadSnapshots);
  const [pinGroups, setPinGroups] = useState<PinGroup[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [pinLines, setPinLines] = useState<Record<number, string>>({});
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null);
  const fileIdRef = useRef<string | null>(null);

  // 挂载后通知主窗口回发 fileId
  useEffect(() => {
    void appWindow.emit("panel_ready", { kind: "sidebar" });
  }, []);

  // 从后端拉固定(分组 + 行文本预览),与主窗口 loadPins 同源
  const loadPins = useCallback(async (fileId: string) => {
    try {
      const data = await invoke<{ groups: PinGroup[]; pins: Pin[] }>("list_pins", { fileId });
      setPinGroups(data.groups);
      setPins(data.pins);
      setPinLines({});
      // 行号按连续段分组批量拉文本
      const groups2: [number, number][] = [];
      for (const n of data.pins.map((p) => p.line_no)) {
        if (groups2.length === 0 || n !== groups2[groups2.length - 1][0] + groups2[groups2.length - 1][1]) {
          groups2.push([n, 1]);
        } else {
          groups2[groups2.length - 1][1]++;
        }
      }
      for (const [start, count] of groups2) {
        invoke<LinePayload[]>("get_lines", { fileId, start: start - 1, count })
          .then((lines) => {
            setPinLines((prev) => {
              const next = { ...prev };
              for (const l of lines) next[l.line_no] = l.text;
              return next;
            });
          })
          .catch((e) => console.error("get_lines failed", e));
      }
    } catch (e) {
      console.error("list_pins failed", e);
    }
  }, []);

  // 主窗口回发 fileId → 加载固定
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ fileId: string }>("sidebar_snapshot", (e) => {
      fileIdRef.current = e.payload.fileId;
      void loadPins(e.payload.fileId);
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, [loadPins]);

  // 固定变更广播 → 重拉(与主窗口状态同源)
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("pins_changed", () => {
      const fid = fileIdRef.current;
      if (fid) void loadPins(fid);
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, [loadPins]);

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

  // ── 固定操作(直接调后端,与主窗口一致)──

  const jump = useCallback((lineNo0: number) => {
    void appWindow.emitTo("main", "goto_line", lineNo0);
  }, []);

  const unpinAction = useCallback(async (pinId: number) => {
    await invoke("remove_pin", { pinId }).catch((e) => console.error("remove_pin failed", e));
  }, []);

  const renamePinAction = useCallback(
    (pinId: number) => {
      const current = pins.find((p) => p.id === pinId)?.name ?? "";
      setPromptCfg({
        title: "重命名固定",
        initial: current,
        placeholder: "固定名称(可留空)",
        okLabel: "保存",
        onSubmit: (name) => {
          void invoke("rename_pin", { pinId, name }).catch((e) =>
            console.error("rename_pin failed", e),
          );
        },
      });
    },
    [pins],
  );

  const newPinGroupAction = useCallback((): Promise<number | null> => {
    const fid = fileIdRef.current;
    return new Promise((resolve) => {
      if (!fid) return resolve(null);
      setPromptCfg({
        title: "新建分组",
        placeholder: "分组名称",
        okLabel: "创建",
        onSubmit: (name) => {
          const trimmed = name.trim();
          if (!trimmed) return resolve(null);
          invoke<PinGroup>("create_pin_group", { fileId: fid, name: trimmed })
            .then((g) => resolve(g.id))
            .catch((e) => {
              console.error("create_pin_group failed", e);
              resolve(null);
            });
        },
      });
    });
  }, []);

  const deletePinGroupAction = useCallback(async (groupId: number) => {
    const fid = fileIdRef.current;
    if (!fid) return;
    await invoke("delete_pin_group", { fileId: fid, groupId }).catch((e) =>
      console.error("delete_pin_group failed", e),
    );
  }, []);

  const reorderPinsAction = useCallback(async (groupId: number, ids: number[]) => {
    const fid = fileIdRef.current;
    if (!fid) return;
    await invoke("reorder_pins", { fileId: fid, groupId, ids }).catch((e) =>
      console.error("reorder_pins failed", e),
    );
  }, []);

  const movePinAction = useCallback(async (pinId: number, groupId: number) => {
    const fid = fileIdRef.current;
    if (!fid) return;
    await invoke("move_pin_to_group", { pinId, fileId: fid, groupId }).catch((e) =>
      console.error("move_pin_to_group failed", e),
    );
  }, []);

  const reorderGroupsAction = useCallback(async (ids: number[]) => {
    const fid = fileIdRef.current;
    if (!fid) return;
    await invoke("reorder_pin_groups", { fileId: fid, ids }).catch((e) =>
      console.error("reorder_pin_groups failed", e),
    );
  }, []);

  const addSnapshot = useCallback(() => {
    // popout 无日志视图,固定动作委托主窗口(用主视图当前行)
    void appWindow.emitTo("main", "snapshot_add");
  }, []);

  const removeSnapshot = useCallback(
    (id: number) => {
      setSnapshots((prev) => {
        const next = prev.filter((s) => s.id !== id);
        saveSnapshots(next);
        void appWindow.emit("snapshots_changed");
        return next;
      });
    },
    [],
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
            saveSnapshots(next);
            void appWindow.emit("snapshots_changed");
            return next;
          });
        },
      });
    },
    [snapshots],
  );

  return (
    <div className="popout">
      <div className="popout-header" data-tauri-drag-region>
        <span className="popout-title">快照与固定</span>
        <span className="popout-spacer" />
        <div className="win-controls">
          <button onClick={() => appWindow.minimize()} aria-label="minimize">─</button>
          <button onClick={() => appWindow.toggleMaximize()} aria-label="maximize">□</button>
          <button className="close" onClick={() => appWindow.close()} aria-label="close">×</button>
        </div>
      </div>
      <div className="popout-body sidebar">
        <SnapshotsPanel
          snapshots={snapshots}
          onAdd={addSnapshot}
          onJump={jump}
          onRemove={removeSnapshot}
          onRename={renameSnapshot}
        />
        <PinsPanel
          groups={pinGroups}
          pins={pins}
          lineText={pinLines}
          onJump={jump}
          onUnpin={unpinAction}
          onRename={renamePinAction}
          onNewGroup={() => void newPinGroupAction()}
          onDeleteGroup={deletePinGroupAction}
          onReorder={reorderPinsAction}
          onReorderGroups={reorderGroupsAction}
          onMoveToGroup={movePinAction}
        />
      </div>
      {promptCfg && <PromptModal {...promptCfg} onClose={() => setPromptCfg(null)} />}
    </div>
  );
}
