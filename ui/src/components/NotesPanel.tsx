import { memo, useState } from "react";

/** 单文件的注释数据块(侧栏聚合用) */
export interface FileNotesBlock {
  fileId: string;
  path: string;
  items: { lineNo: number; note: string }[];
}

interface Props {
  /** 所有打开文件的备注注释聚合(按打开顺序) */
  files: FileNotesBlock[];
  activeFileId: string | null;
  /** 点击注释项:切到对应文件并滚到该行 */
  onJump: (fileId: string, lineNo0: number) => void;
  /** true=按文件分节;false=所有文件注释合并平铺(更直观) */
  byFile: boolean;
  /** 区段头上的视图切换(按文件分节 ⇄ 合并);缺省不显示按钮 */
  onToggleView?: () => void;
  /** 删除注释(仅清备注,保留颜色标记) */
  onDeleteNote?: (fileId: string, lineNo: number) => void;
}

/**
 * 注释聚合面板(VS Code 风区段):区段头可整体折叠;按文件分节或合并平铺,
 * 快速看哪些行有注释,点击跳转(切 tab + 滚动);hover 可删除注释。
 */
function NotesPanel({
  files,
  activeFileId,
  onJump,
  byFile,
  onToggleView,
  onDeleteNote,
}: Props) {
  const [sectionCollapsed, setSectionCollapsed] = useState(false);

  const withItems = files.filter((f) => f.items.length > 0);
  // 无任何注释时不渲染(避免侧栏空占)
  if (withItems.length === 0) return null;
  const total = withItems.reduce((n, f) => n + f.items.length, 0);

  // 合并模式:所有文件的注释平铺(按行号排序,带文件名标签便于区分)
  const flat = byFile
    ? []
    : withItems
        .flatMap((f) => f.items.map((it) => ({ fileId: f.fileId, path: f.path, ...it })))
        .sort((a, b) => a.lineNo - b.lineNo);

  return (
    <div className={`sidebar-section${sectionCollapsed ? " collapsed" : ""}`}>
      <div
        className="sidebar-section-head"
        onClick={() => setSectionCollapsed((v) => !v)}
        title={sectionCollapsed ? "展开注释" : "折叠注释"}
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
        <span className="sidebar-section-title">注释</span>
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
          <div className="notes-panel">
            {withItems.map((f) => (
              <div key={f.fileId} className="notes-file">
                <div
                  className={`pins-file-head${f.fileId === activeFileId ? " active" : ""}`}
                  title={f.path}
                >
                  <span className="pins-file-name">{f.path.split(/[/\\]/).pop()}</span>
                  <span className="pins-file-count">{f.items.length}</span>
                </div>
                {f.items.map((it) => (
                  <div
                    key={it.lineNo}
                    className="note-item"
                    title={it.note}
                    onClick={() => onJump(f.fileId, it.lineNo - 1)}
                  >
                    <span className="pin-item-no">L{it.lineNo.toLocaleString()}</span>
                    <span className="note-item-text">{it.note}</span>
                    {onDeleteNote && (
                      <button
                        className="note-item-del"
                        title="删除注释(保留颜色标记)"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteNote(f.fileId, it.lineNo);
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
        ) : (
          <div className="notes-panel">
            {flat.map((it) => (
              <div
                key={`${it.fileId}:${it.lineNo}`}
                className="note-item"
                title={`${it.note} — ${it.fileId}`}
                onClick={() => onJump(it.fileId, it.lineNo - 1)}
              >
                <span className="pin-item-file">{it.path.split(/[/\\]/).pop()}</span>
                <span className="pin-item-no">L{it.lineNo.toLocaleString()}</span>
                <span className="note-item-text">{it.note}</span>
                {onDeleteNote && (
                  <button
                    className="note-item-del"
                    title="删除注释(保留颜色标记)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteNote(it.fileId, it.lineNo);
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

// memo:搜索/滚动只改 lineCache/sessions 时,聚合 props 不变,侧栏不再随 80ms flush 重渲染
export default memo(NotesPanel);
