import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  findBindingConflicts,
  formatBinding,
  matchBinding,
  parseBinding,
  resolveBindings,
} from "./commands";

const kb = (partial: Partial<KeyboardEvent>) =>
  ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...partial }) as KeyboardEvent;

describe("parseBinding", () => {
  it("解析修饰键组合", () => {
    expect(parseBinding("Ctrl+Shift+F6")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: "F6",
    });
  });

  it("单键无修饰", () => {
    expect(parseBinding("F6")).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      key: "F6",
    });
  });

  it("字母统一大写", () => {
    expect(parseBinding("Ctrl+k")?.key).toBe("K");
  });

  it("拒绝保留键( Esc / Enter / Tab / Space )", () => {
    expect(parseBinding("Esc")).toBeNull();
    expect(parseBinding("Ctrl+Enter")).toBeNull();
    expect(parseBinding("Ctrl+Tab")).toBeNull();
    expect(parseBinding("Space")).toBeNull();
  });

  it("拒绝纯修饰键与残缺串", () => {
    expect(parseBinding("Ctrl")).toBeNull();
    expect(parseBinding("Ctrl+")).toBeNull();
    expect(parseBinding("")).toBeNull();
    expect(parseBinding("Ctrl+Bad+Key")).toBeNull();
  });

  it("拒绝重复修饰键", () => {
    expect(parseBinding("Ctrl+Ctrl+K")).toBeNull();
  });

  it("符号键(等号/减号)", () => {
    expect(parseBinding("Ctrl+=")?.key).toBe("=");
    expect(parseBinding("Ctrl+-")?.key).toBe("-");
  });
});

describe("formatBinding / matchBinding", () => {
  it("format 往返", () => {
    const b = parseBinding("Ctrl+Alt+Shift+F6");
    expect(b).not.toBeNull();
    expect(formatBinding(b!)).toBe("Ctrl+Alt+Shift+F6");
  });

  it("事件匹配(键名规范化)", () => {
    const b = parseBinding("Ctrl+F")!;
    expect(matchBinding(kb({ ctrlKey: true, key: "f" }), b)).toBe(true);
    expect(matchBinding(kb({ ctrlKey: true, altKey: true, key: "f" }), b)).toBe(false);
    expect(matchBinding(kb({ ctrlKey: true, key: "g" }), b)).toBe(false);
  });

  it("方向键规范化", () => {
    const b = parseBinding("Ctrl+Up")!;
    expect(matchBinding(kb({ ctrlKey: true, key: "ArrowUp" }), b)).toBe(true);
  });
});

describe("resolveBindings", () => {
  it("默认表覆盖全部命令", () => {
    for (const c of COMMANDS) {
      expect(DEFAULT_BINDINGS[c.id]).not.toBeUndefined();
    }
    const r = resolveBindings({});
    for (const c of COMMANDS) {
      expect(r[c.id]).toBe(DEFAULT_BINDINGS[c.id]);
    }
  });

  it("用户覆盖 / 显式解除 / 非法值回退默认", () => {
    const r = resolveBindings({ openSettings: "F9", toggleTheme: null, zoomIn: "not a binding" });
    expect(r.openSettings).toBe("F9");
    expect(r.toggleTheme).toBeNull();
    expect(r.zoomIn).toBe(DEFAULT_BINDINGS.zoomIn);
  });

  it("未知命令 id 忽略", () => {
    const r = resolveBindings({ nope: "Ctrl+X" } as Record<string, string | null>);
    expect(Object.keys(r)).not.toContain("nope");
  });
});

describe("findBindingConflicts", () => {
  it("检测撞键并排除自身", () => {
    const r = resolveBindings({});
    const b = parseBinding(DEFAULT_BINDINGS.toggleTheme!)!; // Ctrl+Shift+T
    const conflicts = findBindingConflicts(r, "toggleTail", b);
    expect(conflicts).toContain("toggleTheme");
    expect(conflicts).not.toContain("toggleTail");
  });

  it("无冲突返回空", () => {
    const r = resolveBindings({});
    const b = parseBinding("Ctrl+F12")!;
    expect(findBindingConflicts(r, "openSettings", b)).toEqual([]);
  });
});
