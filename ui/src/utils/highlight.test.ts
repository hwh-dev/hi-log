import { describe, expect, it } from "vitest";
import { byteRangeToChars, byteToCharTables, highlightText } from "./highlight";

/** 便捷断言:字节区间 → 实际切出来的字符串 */
function slice(text: string, start: number, end: number): string {
  const [s, e] = byteRangeToChars(byteToCharTables(text), start, end);
  return text.slice(s, e);
}

describe("byteToCharTables / byteRangeToChars", () => {
  it("ASCII:字节偏移等于码元偏移", () => {
    const t = "hello world";
    expect(slice(t, 0, 5)).toBe("hello");
    expect(slice(t, 6, 11)).toBe("world");
    expect(slice(t, 0, t.length)).toBe(t);
  });

  it("CJK:3 字节字符按 1 个码元算", () => {
    const t = "中文abc";
    // "中" = 3 字节,"文" = 3 字节,后面是 ASCII
    expect(slice(t, 0, 3)).toBe("中");
    expect(slice(t, 3, 6)).toBe("文");
    expect(slice(t, 6, 9)).toBe("abc");
    expect(slice(t, 0, 9)).toBe(t);
  });

  it("emoji:4 字节字符占 2 个 UTF-16 码元(回归:旧实现按码点计数,偏移少 1)", () => {
    const t = "😀a";
    expect(t.length).toBe(3); // 代理对 2 + 'a' 1
    // 旧实现在此返回 1(把 emoji 当 1 个码元),slice 会切出半个代理对
    expect(slice(t, 0, 4)).toBe("😀");
    expect(slice(t, 4, 5)).toBe("a");
    expect(slice(t, 0, 5)).toBe(t);
  });

  it("emoji 在命中之前时,后续区间仍然对齐", () => {
    const t = "😀ERROR";
    const errorByteStart = new TextEncoder().encode("😀").length; // 4
    expect(slice(t, errorByteStart, errorByteStart + 5)).toBe("ERROR");
  });

  it("混合 CJK + emoji + ASCII 的整行覆盖", () => {
    const t = "中文😀err文";
    const bytes = new TextEncoder().encode(t).length;
    expect(slice(t, 0, bytes)).toBe(t);
    // 逐字节起点不落在字符上时,向下取整到该字符起点
    const [s] = byteRangeToChars(byteToCharTables(t), 1, 2);
    expect(s).toBe(0);
  });

  it("空串与越界不炸", () => {
    expect(slice("", 0, 0)).toBe("");
    // 完全越界的区间被钳到串尾 → 空区间(不产生乱切片,也不误伤整行)
    expect(slice("abc", 99, 200)).toBe("");
    // 起点越界、终点在范围内 → 空区间而非倒置
    expect(byteRangeToChars(byteToCharTables("abc"), -5, -1)).toEqual([0, 0]);
    // 部分越界 → 钳到有效范围
    expect(slice("abc", 1, 99)).toBe("bc");
  });

  it("零长度与倒置区间返回空区间", () => {
    const t = "abcdef";
    expect(byteRangeToChars(byteToCharTables(t), 2, 2)).toEqual([2, 2]);
    expect(byteRangeToChars(byteToCharTables(t), 4, 2)).toEqual([4, 4]);
  });
});

/** 取出节点数组里 <mark> 元素的文本(直接用 props.children,不渲染) */
function markText(node: unknown): string | null {
  const n = node as { type?: unknown; props?: { children?: unknown } } | null;
  if (!n || !n.props) return null;
  const c = n.props.children;
  return typeof c === "string" ? c : null;
}

describe("highlightText", () => {
  it("无区间时原样返回字符串", () => {
    expect(highlightText("abc", [], "k")).toBe("abc");
  });

  it("单区间切出 <mark>,文案与原文一致", () => {
    const nodes = highlightText("foo bar", [[4, 7]], "k") as unknown[];
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toBe("foo ");
    expect(markText(nodes[1])).toBe("bar");
  });

  it("含 emoji 的行不会从代理对中间切开", () => {
    const text = "😀err";
    const nodes = highlightText(text, [[4, 7]], "k") as unknown[];
    expect(nodes[0]).toBe("😀");
    expect(markText(nodes[1])).toBe("err");
  });

  it("重叠区间被防御性跳过,已高亮部分不受影响", () => {
    // [1,2] 落在 [0,3] 内部 → 被跳过
    const nodes = highlightText("abcdef", [[0, 3], [1, 2]], "k") as unknown[];
    expect(markText(nodes[0])).toBe("abc");
    expect(nodes[1]).toBe("def");
  });

  it("尾部残留文本被补回:nodes 拼接 = 原文", () => {
    const text = "中文ERROR中文";
    const nodes = highlightText(text, [[6, 11]], "k") as unknown[];
    const flat = nodes.map((n) => markText(n) ?? (n as string)).join("");
    expect(flat).toBe(text);
  });
});
