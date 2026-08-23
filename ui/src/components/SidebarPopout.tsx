import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import PinsAggregate, { type FilePinsBlock } from "./PinsAggregate";
import NotesPanel, { type FileNotesBlock } from "./NotesPanel";
import type { Pin, PinGroup } from "./PinsPanel";
import type { Mark } from "../utils/palette";
import { useSettings } from "../utils/settings";

const appWindow = getCurrentWindow();

interface LinePayload {
  text: string;
  line_no: number;
}

/** 弹窗版侧栏:固定 + 注释,多文件聚合(与主窗口同构)。数据从后端按 fileId 拉取。 */
export default function SidebarPopout() {
  const [pinAggFiles, setPinAggFiles] = useState<FilePinsBlock[]>([]);
  const [notesAggFiles, setNotesAggFiles] = useState<FileNotesBlock[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [filesOverview, setFilesOverview] = useState<{ fileId: string; path: string }[]>([]);
  const sidebarSections = useSettings((s) => s.sidebarSections);

  // 挂载后通知主窗口回发文件概览
  useEffect(() => {
    void appWindow.emit("panel_ready", { kind: "sidebar" });
  }, []);

  // 拉单文件固定(分组 + 行文本预览)
  const loadPinsFor = useCallback(async (fileId: string, path: string) => {
    try {
      const data = await invoke<{ groups: PinGroup[]; pins: Pin[] }>("list_pins", { fileId });
      const b: FilePinsBlock = { fileId, path, groups: data.groups, pins: data.pins, lineText: {} };
      setPinAggFiles((prev) => {
        const rest = prev.filter((x) => x.fileId !== fileId);
        return [...rest, b];
      });
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
            setPinAggFiles((prev) =>
              prev.map((x) => {
                if (x.fileId !== fileId) return x;
                const next = { ...x.lineText };
                for (const l of lines) next[l.line_no] = l.text;
                return { ...x, lineText: next };
              }),
            );
          })
          .catch(() => {});
      }
    } catch (e) {
      console.error("list_pins failed", e);
    }
  }, []);

  // 拉单文件注释(备注)
  const loadNotesFor = useCallback(async (fileId: string, path: string) => {
    try {
      const list = await invoke<Mark[]>("list_marks", { fileId });
      const items = list
        .filter((m) => m.note)
        .map((m) => ({ lineNo: m.line_no, note: m.note as string }))
        .sort((a, b) => a.lineNo - b.lineNo);
      setNotesAggFiles((prev) => {
        const rest = prev.filter((x) => x.fileId !== fileId);
        return items.length ? [...rest, { fileId, path, items }] : rest;
      });
    } catch (e) {
      console.error("list_marks failed", e);
    }
  }, []);

  // 主窗口回发文件概览 → 拉全部数据
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ files: { fileId: string; path: string }[]; activeFileId: string | null }>(
      "sidebar_snapshot",
      (e) => {
        setFilesOverview(e.payload.files ?? []);
        setActiveFileId(e.payload.activeFileId ?? null);
        for (const f of e.payload.files ?? []) {
          void loadPinsFor(f.fileId, f.path);
          void loadNotesFor(f.fileId, f.path);
        }
      },
    ).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, [loadPinsFor, loadNotesFor]);

  // 变更广播 → 重拉全部(与主窗口同源同步)
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("pins_changed", () => {
      for (const f of filesOverview) void loadPinsFor(f.fileId, f.path);
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, [filesOverview, loadPinsFor]);

  useEffect(() => {
    let un: (() => void) | undefined;
    listen("marks_changed", () => {
      for (const f of filesOverview) void loadNotesFor(f.fileId, f.path);
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, [filesOverview, loadNotesFor]);

  // 聚合点击跳转:跨文件 → 主窗口切 tab + 滚动
  const jumpToFileLine = useCallback((fileId: string, line0: number) => {
    void appWindow.emitTo("main", "goto_file_line", { fileId, line0 }).catch(() => {});
  }, []);

  return (
    <div className="popout">
      <div className="popout-header" data-tauri-drag-region>
        <span className="popout-title">固定与注释</span>
        <span className="popout-spacer" />
        <div className="win-controls">
          <button onClick={() => appWindow.minimize()} aria-label="minimize">─</button>
          <button onClick={() => appWindow.toggleMaximize()} aria-label="maximize">□</button>
          <button className="close" onClick={() => appWindow.close()} aria-label="close">×</button>
        </div>
      </div>
      <div className="popout-body sidebar">
        <PinsAggregate
          files={pinAggFiles}
          activeFileId={activeFileId}
          onJump={jumpToFileLine}
          byFile={sidebarSections.pinsByFile}
        />
        <NotesPanel
          files={notesAggFiles}
          activeFileId={activeFileId}
          onJump={jumpToFileLine}
          byFile={sidebarSections.notesByFile}
        />
      </div>
    </div>
  );
}
