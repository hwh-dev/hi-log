import { useState } from "react";
import type { Pin, PinGroup } from "./PinsPanel";

/** 单个文件的固定数据块(侧栏聚合用) */
export interface FilePinsBlock {
  fileId: string;
  path: string;
  groups: PinGroup[];
  pins: Pin[];
  lineText: Record<number, string>;
}

interface Props {
  /** 所有打开文件的固定聚合(按打开顺序) */
  files: FilePinsBlock[];
  activeFileId: string | null;
  /** 点击固定项:切到对应文件并滚到该行 */
  onJump: (fileId: string, lineNo0: number) => void;
  /** true=按文件分节;false=所有文件固定合并平铺(更直观) */
  byFile: boolean;
  /** 区段头上的视图切换(按文件分节 ⇄ 合并);缺省不显示按钮 */
  onToggleView?: () => void;
  /** 侧栏内编辑/删除固定(按钮 hover 展示) */
  onUnpin?: (fileId: string, pinId: number) => void;
  onRenamePin?: (fileId: string, pinId: number) => void;
  onDeleteGroup?: (fileId: string, groupId: number) => void;
}

/**
 * 固定聚合面板(VS Code 风区段):区段头可整体折叠;内容按文件分节/合并,
 * 点击跳转(切 tab + 滚动);hover 项可重命名/取消固定、删除分组。
 */
export default function PinsAggregate({
  files,
  activeFileId,
  onJump,
  byFile,
  onToggleView,
  onUnpin,
  onRenamePin,
  onDeleteGroup,
}: Props) {
  // 区段折叠(整体)
  const [sectionCollapsed, setSectionCollapsed] = useState(false);
  // 分组折叠:key = "fileId:groupId"
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const total = files.reduce((n, f) => n + f.pins.length, 0);

  // 合并模式:所有文件的固定平铺(按行号排序,带文件名标签便于区分)
  const flat = byFile
    ? []
    : files
        .flatMap((f) =>
          f.pins.map((p) => ({
            fileId: f.fileId,
            path: f.path,
            pin: p,
            text: f.lineText[p.line_no] ?? "",
          })),
        )
        .sort((a, b) => a.pin.line_no - b.pin.line_no);

  return (
    <div className={`sidebar-section${sectionCollapsed ? " collapsed" : ""}`}>
      <div
        className="sidebar-section-head"
        onClick={() => setSectionCollapsed((v) => !v)}
        title={sectionCollapsed ? "展开固定" : "折叠固定"}
      >
        <button
          className="sidebar-section-arrow"
          onClick={(e) => {
            e.stopPropagation();
            setSectionCollapsed((v) => !v);
          }}
        >
          {sectionCollapsed ? "▶" : "▼"}
        </button>
        <span className="sidebar-section-title">固定</span>
        <span className="sidebar-section-count">{total}</span>
        {onToggleView && (
          <button
            className="section-view-toggle"
            title="切换:按文件分节 / 合并平铺"
            onClick={(e) => {
              e.stopPropagation();
              onToggleView();
            }}
          >
            {byFile ? "分节" : "合并"}
          </button>
        )}
      </div>
      {!sectionCollapsed &&
        (byFile ? (
          <div className="pins-aggregate">
            {files.map((f) => (
              <div key={f.fileId} className="pins-file">
                <div
                  className={`pins-file-head${f.fileId === activeFileId ? " active" : ""}`}
                  title={f.path}
                >
                <span className="pins-file-name">{f.path.split(/[/\\]/).pop()}</span>
                <span className="pins-file-count">{f.pins.length}</span>
              </div>
              {f.groups.map((g) => {
                const list = f.pins.filter((p) => p.group_id === g.id);
                if (list.length === 0) return null;
                const key = `${f.fileId}:${g.id}`;
                const isCollapsed = collapsed.has(key);
                return (
                  <div key={key}>
                    <div className="pin-group-title">
                      <button
                        className="pin-group-arrow"
                        title={isCollapsed ? "展开" : "折叠"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(key);
                        }}
                      >
                        {isCollapsed ? "▶" : "▼"}
                      </button>
                      <span className="pin-group-name">{g.name}</span>
                      <span className="pin-group-count">{list.length}</span>
                      {onDeleteGroup && (
                        <button
                          className="pin-group-del"
                          title="删除分组(组内固定移到默认组)"
                          draggable={false}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteGroup(f.fileId, g.id);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {!isCollapsed &&
                      list.map((p) => (
                        <div
                          key={p.id}
                          className="pin-item"
                          title={`${p.name || `L${p.line_no}`} — 第 ${p.line_no} 行`}
                          onClick={() => onJump(f.fileId, p.line_no - 1)}
                        >
                          <span className={`pin-item-no${p.name ? " named" : ""}`}>
                            {p.name || `L${p.line_no.toLocaleString()}`}
                          </span>
                          <span className="pin-item-text">{f.lineText[p.line_no] ?? ""}</span>
                          {onRenamePin && (
                            <button
                              className="pin-item-rename"
                              title="重命名固定"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRenamePin(f.fileId, p.id);
                              }}
                            >
                              ✎
                            </button>
                          )}
                          {onUnpin && (
                            <button
                              className="pin-item-remove"
                              title="取消固定"
                              onClick={(e) => {
                                e.stopPropagation();
                                onUnpin(f.fileId, p.id);
                              }}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                );
              })}
              </div>
            ))}
          </div>
        ) : (
          <div className="pins-aggregate">
            {flat.map(({ fileId, path, pin, text }) => (
              <div
                key={`${fileId}:${pin.id}`}
                className="pin-item"
                title={`${pin.name || `L${pin.line_no}`} — ${fileId}`}
                onClick={() => onJump(fileId, pin.line_no - 1)}
              >
                <span className="pin-item-file">{path.split(/[/\\]/).pop()}</span>
                <span className={`pin-item-no${pin.name ? " named" : ""}`}>
                  {pin.name || `L${pin.line_no.toLocaleString()}`}
                </span>
                <span className="pin-item-text">{text}</span>
                {onRenamePin && (
                  <button
                    className="pin-item-rename"
                    title="重命名固定"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenamePin(fileId, pin.id);
                    }}
                  >
                    ✎
                  </button>
                )}
                {onUnpin && (
                  <button
                    className="pin-item-remove"
                    title="取消固定"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnpin(fileId, pin.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
