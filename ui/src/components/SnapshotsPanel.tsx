import type { Snapshot } from "../utils/snapshots";

interface Props {
  snapshots: Snapshot[];
  onAdd: () => void;
  onJump: (lineNo0: number) => void;
  onRemove: (id: number) => void;
  onRename: (id: number) => void;
}

/** 左侧栏 SNAPSHOTS 区块:📌 固定当前视图,点击跳回,双击重命名 */
export default function SnapshotsPanel({
  snapshots,
  onAdd,
  onJump,
  onRemove,
  onRename,
}: Props) {
  return (
    <section className="snapshots-panel">
      <div className="snapshots-header">
        <span>SNAPSHOTS</span>
        <button className="snapshot-add" onClick={onAdd} title="固定当前视图为快照">
          📌
        </button>
      </div>
      {snapshots.length === 0 ? (
        <div className="snapshots-empty">固定当前视图,一键跳回</div>
      ) : (
        snapshots.map((s) => (
          <div
            key={s.id}
            className="snapshot-item"
            title={`第 ${s.line_no} 行 — 双击重命名`}
            onClick={() => onJump(s.line_no - 1)}
            onDoubleClick={() => onRename(s.id)}
          >
            <span className="snapshot-pin">📌</span>
            <span className="snapshot-name">{s.name}</span>
            <span className="snapshot-line">L{s.line_no.toLocaleString()}</span>
            <button
              className="snapshot-remove"
              aria-label="删除快照"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(s.id);
              }}
            >
              ×
            </button>
          </div>
        ))
      )}
    </section>
  );
}
