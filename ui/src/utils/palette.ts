/**
 * 标记色板 —— 与 core/src/marks/mod.rs 的 PALETTE 顺序严格一致。
 * 标记只存色板下标(color: u8),颜色在这里解析,改色板只需动这一处。
 */
export const PALETTE = [
  "#e74c3c", // 红
  "#f39c12", // 橙
  "#f1c40f", // 黄
  "#2ecc71", // 绿
  "#3498db", // 蓝
  "#9b59b6", // 紫
  "#1abc9c", // 青
  "#e67e22", // 琥珀
] as const;

export const PALETTE_NAMES = ["红", "橙", "黄", "绿", "蓝", "紫", "青", "琥珀"];

/** 与后端 MarkPayload 对应 */
export interface Mark {
  id: number;
  file_id: string;
  line_no: number; // 1-based
  color: number;
  note: string;
  /** 部分标记:选中文本起始偏移(0-based 字节)与长度;缺省 = 整行标记 */
  col?: number;
  len?: number;
  created_at: number;
}

/** 色板下标 → 颜色(越界取模防御) */
export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}
