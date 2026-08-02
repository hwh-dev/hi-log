/** 快照 = 固定的视图锚点行 + 名称,localStorage 持久化(会话间保留) */
export interface Snapshot {
  id: number;
  name: string;
  /** 锚点行(1-based) */
  line_no: number;
  created_at: number;
}

const KEY = "hi-log.snapshots";

export function loadSnapshots(): Snapshot[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveSnapshots(list: Snapshot[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}
