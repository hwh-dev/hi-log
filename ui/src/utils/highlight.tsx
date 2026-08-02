import React from "react";

/**
 * core 返回的匹配区间是"字节偏移",而 text 是 UTF-8 解码后的字符串,
 * 多字节字符会导致偏移错位,需要做字节 → 字符偏移换算。
 */
function byteToCharIndex(text: string, byteIdx: number): number {
  if (byteIdx <= 0) return 0;
  const bytes = new TextEncoder().encode(text);
  let chars = 0;
  let b = 0;
  while (b < byteIdx) {
    const c = bytes[b];
    b += c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    chars += 1;
  }
  return chars;
}

/** 把文本按匹配区间拆成 <mark> 高亮片段 */
export function highlightText(
  text: string,
  ranges: [number, number][],
  keyBase: string,
): React.ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (let i = 0; i < ranges.length; i++) {
    const s = byteToCharIndex(text, ranges[i][0]);
    const e = byteToCharIndex(text, ranges[i][1]);
    if (s < last || e <= s) continue; // 防御:重叠或非法区间
    if (s > last) parts.push(text.slice(last, s));
    parts.push(<mark key={`${keyBase}-${i}`}>{text.slice(s, e)}</mark>);
    last = e;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
