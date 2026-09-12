import React from "react";

/**
 * core 返回的匹配区间是"字节偏移",而 text 是 UTF-8 解码后的字符串,
 * 多字节字符会导致偏移错位,需要做字节 → 字符偏移换算。
 *
 * 整行只编码一次,所有区间复用同一份字节;避免每个区间 endpooint 都
 * 重新 TextEncoder.encode 整段(O(命中数 × 文本长) → O(文本长 + 命中数))。
 */
export function highlightText(
  text: string,
  ranges: [number, number][],
  keyBase: string,
): React.ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const bytes = new TextEncoder().encode(text);
  const byteToChar = (byteIdx: number): number => {
    if (byteIdx <= 0) return 0;
    let chars = 0;
    let b = 0;
    const lim = Math.min(byteIdx, bytes.length);
    while (b < lim) {
      const c = bytes[b];
      b += c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
      chars += 1;
    }
    return chars;
  };
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (let i = 0; i < ranges.length; i++) {
    const s = byteToChar(ranges[i][0]);
    const e = byteToChar(ranges[i][1]);
    if (s < last || e <= s) continue; // 防御:重叠或非法区间
    if (s > last) parts.push(text.slice(last, s));
    parts.push(<mark key={`${keyBase}-${i}`}>{text.slice(s, e)}</mark>);
    last = e;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
