import React from "react";

/**
 * core 与后端存储的匹配区间一律是 **UTF-8 字节偏移**(搜索命中、部分标记的 col/len),
 * 而 text 是解码后的 JS 字符串。`String.prototype.slice` 用的是 **UTF-16 码元**,
 * 所以必须做字节 → 码元换算,否则含多字节字符的行会从半个字符处切开。
 *
 * 换算用双表 LUT(整行只编码一次,所有区间 O(1) 查表):
 * - `startOf[b]` = 覆盖第 b 个字节的字符的**起始**码元下标(区间起点向下取整)
 * - `endOf[b]`   = 覆盖第 b 个字节的字符的**结束**码元下标(区间终点向上取整)
 *
 * ⚠️ 计数单位必须是 UTF-16 码元而不是 Unicode 码点:星平面字符(emoji)
 * 在 UTF-8 里是 4 字节、在 UTF-16 里是 **2 个码元**。按码点计数会让其后
 * 所有偏移少 1,slice 出半个代理对(显示为乱码)。
 */
export interface ByteCharTables {
  startOf: Int32Array;
  endOf: Int32Array;
}

export function byteToCharTables(text: string): ByteCharTables {
  const bytes = new TextEncoder().encode(text);
  const n = bytes.length;
  const startOf = new Int32Array(n + 1);
  const endOf = new Int32Array(n + 1);
  let b = 0;
  let u = 0;
  while (b < n) {
    const c = bytes[b];
    const width = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    const units = width === 4 ? 2 : 1;
    const stop = Math.min(b + width, n);
    for (let k = b; k < stop; k++) {
      startOf[k] = u;
      endOf[k] = u + units;
    }
    b += width;
    u += units;
  }
  startOf[n] = u;
  endOf[n] = u;
  return { startOf, endOf };
}

/**
 * 半开字节区间 `[start, end)` → 半开码元区间。
 * 终点取「最后一个被覆盖字节(`end-1`)所在字符的结束位置」——
 * 直接查 `startOf[end]` 在区间终点落在字符边界时会**多算一个字符**。
 */
export function byteRangeToChars(
  t: ByteCharTables,
  start: number,
  end: number,
): [number, number] {
  const n = t.startOf.length - 1;
  const bs = Math.max(0, Math.min(start, n));
  const be = Math.max(0, Math.min(end, n));
  const s = t.startOf[bs];
  const e = be > 0 ? t.endOf[be - 1] : s;
  return e > s ? [s, e] : [s, s];
}

/**
 * 把一行的字节区间渲染成 `<mark>` 高亮节点。
 * 区间必须升序且互不重叠,乱序/重叠/非法区间会被防御性跳过。
 */
export function highlightText(
  text: string,
  ranges: [number, number][],
  keyBase: string,
): React.ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const tables = byteToCharTables(text);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (let i = 0; i < ranges.length; i++) {
    const [s, e] = byteRangeToChars(tables, ranges[i][0], ranges[i][1]);
    if (s < last || e <= s) continue; // 防御:重叠或非法区间
    if (s > last) parts.push(text.slice(last, s));
    parts.push(<mark key={`${keyBase}-${i}`}>{text.slice(s, e)}</mark>);
    last = e;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
