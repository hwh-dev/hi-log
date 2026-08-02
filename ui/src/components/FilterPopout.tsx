import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FilterView, { type SearchSession } from "./FilterView";
import ContextMenu from "./ContextMenu";
import PromptModal, { type PromptConfig } from "./PromptModal";
import type { Pin, PinGroup } from "./PinsPanel";
import type { Mark } from "../utils/palette";

interface HitPayload {
  line_no: number;
  ranges: [number, number][];
}

interface SearchChunkPayload {
  search_id: number;
  hits: HitPayload[];
}

interface SearchProgressPayload {
  search_id: number;
  scanned: number;
  total: number;
}

interface SearchDonePayload {
  search_id: number;
  hits: number;
  cancelled: boolean;
  truncated: boolean;
}

type LineCache = Record<number, string>;
type MarkMap = Record<number, Mark>;

const appWindow = getCurrentWindow();

/**
 * 独立窗口版搜索命中列表(label: filter-popout)。
 * 打开时向主窗口要一份完整会话快照,此后跟随增量转发事件;
 * 会话切换/关闭/清空经主窗口统一状态后广播回来,两端始终一致。
 */
export default function FilterPopout() {
  const [sessions, setSessions] = useState<SearchSession[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [lineCache, setLineCache] = useState<LineCache>({});
  const [marks, setMarks] = useState<MarkMap>({});
  const [pinGroups, setPinGroups] = useState<PinGroup[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; lineNo: number } | null>(null);
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null);
  const fileIdRef = useRef<string | null>(null);

  // 挂载后通知主窗口回发搜索快照
  useEffect(() => {
    void appWindow.emit("panel_ready", { kind: "filter" });
  }, []);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;

  const loadMarks = useCallback(async (fid: string) => {
    try {
      const list = await invoke<Mark[]>("list_marks", { fileId: fid });
      const map: MarkMap = {};
      for (const m of list) map[m.line_no] = m;
      setMarks(map);
    } catch (e) {
      console.error("list_marks failed", e);
    }
  }, []);

  const loadPins = useCallback(async (fid: string) => {
    try {
      const data = await invoke<{ groups: PinGroup[]; pins: Pin[] }>("list_pins", { fileId: fid });
      setPinGroups(data.groups);
      setPins(data.pins);
    } catch (e) {
      console.error("list_pins failed", e);
    }
  }, []);

  const fetchLines = useCallback(async (start: number, count: number) => {
    const fid = fileIdRef.current;
    if (!fid) return;
    try {
      const lines = await invoke<{ text: string; line_no: number }[]>("get_lines", {
        fileId: fid,
        start,
        count,
      });
      setLineCache((prev) => {
        const next = { ...prev };
        for (const l of lines) next[l.line_no - 1] = l.text;
        return next;
      });
    } catch (e) {
      console.error("get_lines failed", e);
    }
  }, []);

  // 主窗口快照 + 增量转发(事件均带 search_id,只更新对应会话)
  useEffect(() => {
    const un: Array<() => void> = [];
    listen<{
      fileId: string;
      sessions: SearchSession[];
      activeId: number | null;
    }>("filter_snapshot", (e) => {
      fileIdRef.current = e.payload.fileId;
      setSessions(e.payload.sessions);
      setActiveId(e.payload.activeId);
      void loadMarks(e.payload.fileId);
      void loadPins(e.payload.fileId);
    }).then((f) => un.push(f));

    // 主窗口发起新搜索 → 创建会话
    listen<{ search_id: number; query: string; regex: boolean; caseSensitive: boolean }>(
      "search_started",
      (e) => {
        setSessions((prev) => [
          {
            id: e.payload.search_id,
            query: e.payload.query,
            regex: e.payload.regex,
            caseSensitive: e.payload.caseSensitive,
            hitCount: 0,
            truncated: false,
            highlightMap: {},
            running: true,
            progress: null,
          },
          ...prev,
        ]);
        setActiveId(e.payload.search_id);
      },
    ).then((f) => un.push(f));

    listen<SearchChunkPayload>("search_chunk_fwd", (e) => {
      const sid = e.payload.search_id;
      const hits = e.payload.hits;
      // 直接合并(独立窗口命中通常较少;主窗口已有节流)
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const next = { ...s.highlightMap };
          for (const h of hits) next[h.line_no] = h.ranges;
          return { ...s, highlightMap: next, hitCount: s.hitCount + hits.length };
        }),
      );
    }).then((f) => un.push(f));

    listen<SearchProgressPayload>("search_progress_fwd", (e) => {
      const sid = e.payload.search_id;
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, progress: e.payload } : s)),
      );
    }).then((f) => un.push(f));

    listen<SearchDonePayload>("search_done_fwd", (e) => {
      const sid = e.payload.search_id;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? {
                ...s,
                hitCount: e.payload.hits,
                truncated: e.payload.truncated,
                running: false,
                progress: null,
              }
            : s,
        ),
      );
    }).then((f) => un.push(f));

    listen<{ search_id: number }>("session_active_fwd", (e) => {
      setActiveId(e.payload.search_id);
    }).then((f) => un.push(f));

    listen<{ search_id: number }>("session_close_fwd", (e) => {
      setSessions((prev) => prev.filter((s) => s.id !== e.payload.search_id));
      setActiveId((a) => (a === e.payload.search_id ? null : a));
    }).then((f) => un.push(f));

    listen("sessions_clear_fwd", () => {
      setSessions([]);
      setActiveId(null);
    }).then((f) => un.push(f));

    return () => {
      for (const fn of un) fn();
    };
  }, [loadMarks]);

  // 标记 / 固定变更广播 → 重拉
  useEffect(() => {
    const un: Array<() => void> = [];
    listen("marks_changed", () => {
      const fid = fileIdRef.current;
      if (fid) void loadMarks(fid);
    }).then((f) => un.push(f));
    listen("pins_changed", () => {
      const fid = fileIdRef.current;
      if (fid) void loadPins(fid);
    }).then((f) => un.push(f));
    return () => {
      for (const fn of un) fn();
    };
  }, [loadMarks, loadPins]);

  const jump = useCallback((lineNo0: number) => {
    void appWindow.emitTo("main", "goto_line", lineNo0);
  }, []);

  // 会话操作:发给主窗口统一执行(状态一致后再广播回来)
  const selectSession = useCallback((id: number) => {
    void appWindow.emitTo("main", "panel_session_activate", { search_id: id }).catch(() => {});
  }, []);
  const closeSession = useCallback((id: number) => {
    void appWindow.emitTo("main", "panel_session_close", { search_id: id }).catch(() => {});
  }, []);
  const clearSessions = useCallback(() => {
    void appWindow.emitTo("main", "panel_sessions_clear", {}).catch(() => {});
  }, []);

  const addMarkAction = useCallback(
    async (lineNo: number, color: number) => {
      const fid = fileIdRef.current;
      if (!fid) return;
      await invoke("add_mark", { fileId: fid, lineNo, color }).catch((e) =>
        console.error("add_mark failed", e),
      );
    },
    [],
  );

  const addNoteAction = useCallback(
    (lineNo: number, color: number) => {
      const fid = fileIdRef.current;
      if (!fid) return;
      const current = marks[lineNo]?.note ?? "";
      setCtxMenu(null);
      setPromptCfg({
        title: `第 ${lineNo} 行备注`,
        hint: current ? "修改备注" : "新备注",
        initial: current,
        multiline: true,
        placeholder: "输入备注,可留空",
        okLabel: "保存",
        onSubmit: (note) => {
          void invoke("add_mark", { fileId: fid, lineNo, color, note }).catch((e) =>
            console.error("add_mark failed", e),
          );
        },
      });
    },
    [marks],
  );

  const removeMarkAction = useCallback(async (markId: number) => {
    await invoke("remove_mark", { markId }).catch((e) => console.error("remove_mark failed", e));
  }, []);

  // ── 固定(pin)操作 ──
  const addPinAction = useCallback((lineNo: number, groupId: number | null) => {
    const fid = fileIdRef.current;
    if (!fid) return;
    setCtxMenu(null);
    setPromptCfg({
      title: `固定第 ${lineNo} 行`,
      hint: "名称可留空",
      placeholder: "固定名称",
      okLabel: "固定",
      onSubmit: (name) => {
        void invoke("add_pin", { fileId: fid, lineNo, groupId, name }).catch((e) =>
          console.error("add_pin failed", e),
        );
      },
    });
  }, []);

  const unpinAction = useCallback(async (pinId: number) => {
    await invoke("remove_pin", { pinId }).catch((e) => console.error("remove_pin failed", e));
  }, []);

  const renamePinAction = useCallback((pinId: number) => {
    const current = pins.find((p) => p.id === pinId)?.name ?? "";
    setCtxMenu(null);
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
  }, [pins]);

  const newPinGroupAction = useCallback((): Promise<number | null> => {
    // 弹窗异步收集名称;取消时 Promise 不 resolve,"新建并固定"链自然中断
    return new Promise((resolve) => {
      const fid = fileIdRef.current;
      if (!fid) return resolve(null);
      setCtxMenu(null);
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

  return (
    <div className="popout">
      <div className="popout-header">
        <span className="popout-title">FILTER</span>
        <span className="popout-info">
          {active ? `${active.hitCount.toLocaleString()}${active.truncated ? "+" : ""} 命中` : "无搜索"}
        </span>
        <span className="popout-spacer" />
        <button className="popout-close" onClick={() => appWindow.close()} title="关闭窗口">
          ×
        </button>
      </div>
      <div className="popout-body">
        <FilterView
          sessions={sessions}
          activeId={activeId}
          onSelectSession={selectSession}
          onCloseSession={closeSession}
          onClearSessions={clearSessions}
          lineCache={lineCache}
          highlightMap={active?.highlightMap ?? {}}
          fetchLines={fetchLines}
          onJump={jump}
          onContextMenu={(lineNo, x, y) => setCtxMenu({ lineNo, x, y })}
          hitCount={active?.hitCount ?? 0}
          truncated={active?.truncated ?? false}
        />
      </div>
      {ctxMenu && (() => {
        const pinned = pins.find((p) => p.line_no === ctxMenu.lineNo) ?? null;
        return (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            lineNo={ctxMenu.lineNo}
            mark={marks[ctxMenu.lineNo] ?? null}
            onMark={(c) => void addMarkAction(ctxMenu.lineNo, c)}
            onNote={() =>
              void addNoteAction(ctxMenu.lineNo, marks[ctxMenu.lineNo]?.color ?? 0)
            }
            onClear={() => {
              const m = marks[ctxMenu.lineNo];
              if (m) void removeMarkAction(m.id);
            }}
            pinGroups={pinGroups}
            pinnedGroup={pinned ? pinGroups.find((g) => g.id === pinned.group_id) ?? null : null}
            onPin={(gid) => void addPinAction(ctxMenu.lineNo, gid)}
            onUnpin={() => {
              if (pinned) void unpinAction(pinned.id);
            }}
            onRenamePin={() => {
              if (pinned) void renamePinAction(pinned.id);
            }}
            onNewGroupAndPin={() => {
              void newPinGroupAction().then((gid) => {
                if (gid != null) void addPinAction(ctxMenu.lineNo, gid);
              });
            }}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}

      {promptCfg && <PromptModal {...promptCfg} onClose={() => setPromptCfg(null)} />}
    </div>
  );
}
