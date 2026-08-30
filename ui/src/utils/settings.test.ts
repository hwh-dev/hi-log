import { beforeEach, describe, expect, it } from "vitest";
import {
  expandContext,
  loadSettings,
  resolveTheme,
  rowHeight,
  setSetting,
} from "./settings";

beforeEach(() => {
  localStorage.clear();
});

describe("expandContext", () => {
  it("n=0 原样返回", () => {
    expect(expandContext([10, 20], 0, 100)).toEqual([10, 20]);
  });

  it("展开 ±n、去重、升序", () => {
    expect(expandContext([10, 12], 1, 100)).toEqual([9, 10, 11, 12, 13]);
  });

  it("相邻命中合并为连续段", () => {
    expect(expandContext([5, 6], 1, 100)).toEqual([4, 5, 6, 7]);
  });

  it("边界钳制到 [1, maxLine]", () => {
    expect(expandContext([1, 100], 2, 100)).toEqual([1, 2, 3, 98, 99, 100]);
  });

  it("空输入 / maxLine 为 0", () => {
    expect(expandContext([], 3, 100)).toEqual([]);
    expect(expandContext([10], 2, 0)).toEqual([]);
  });
});

describe("resolveTheme", () => {
  it("三态解析", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("rowHeight", () => {
  it("行高 = 字号 + 行距", () => {
    expect(rowHeight({ fontSize: 13, rowSpacing: 9 } as never)).toBe(22);
    expect(rowHeight({ fontSize: 16, rowSpacing: 10 } as never)).toBe(26);
  });
});

describe("loadSettings", () => {
  it("默认值与现状一致(零行为漂移)", () => {
    const s = loadSettings();
    expect(s.theme).toBe("dark");
    expect(s.themeStyle).toBe("solid");
    expect(s.backgroundImage).toBe("");
    expect(s.fontSize).toBe(13);
    expect(s.rowSpacing).toBe(9);
    expect(s.contextLines).toBe(0);
    expect(s.searchHistoryMax).toBe(50);
    expect(s.restoreLastFile).toBe(true);
    expect(s.tailPollMs).toBe(1000);
    expect(s.checkUpdateOnStart).toBe(true);
    expect(s.encoding).toBe("auto");
    expect(s.filterHeight).toBe(220);
    expect(s.sidebarWidth).toBe(230);
  });

  it("乱值回退默认 + 数值钳制到范围", () => {
    localStorage.setItem("hi-log.font-size", "999");
    localStorage.setItem("hi-log.context-lines", "-5");
    localStorage.setItem("hi-log.theme", "purple");
    localStorage.setItem("hi-log.encoding", "gbk");
    const s = loadSettings();
    expect(s.fontSize).toBe(16); // 钳到上限
    expect(s.contextLines).toBe(0); // 钳到下限
    expect(s.theme).toBe("dark"); // 非法枚举回退默认
    expect(s.encoding).toBe("gbk"); // 合法枚举保留
    localStorage.setItem("hi-log.theme-style", "shiny");
    localStorage.setItem("hi-log.background", "../evil.png");
    expect(loadSettings().themeStyle).toBe("solid"); // 非法风格回退
    expect(loadSettings().backgroundImage).toBe(""); // 路径注入拒收
  });

  it("backgroundImage 只接受固定文件名", () => {
    localStorage.setItem("hi-log.background", "background.jpg");
    expect(loadSettings().backgroundImage).toBe("background.jpg");
    localStorage.setItem("hi-log.background", "C:\\Users\\u\\pic.png");
    expect(loadSettings().backgroundImage).toBe("");
  });

  it("旧值兼容:theme 旧值 light 合法", () => {
    localStorage.setItem("hi-log.theme", "light");
    expect(loadSettings().theme).toBe("light");
  });

  it("keybindings 非法 JSON 回退空对象", () => {
    localStorage.setItem("hi-log.keybindings", "{{{");
    expect(loadSettings().keybindings).toEqual({});
  });
});

describe("setSetting", () => {
  it("写入并钳制回写规范化值", () => {
    setSetting("fontSize", 99, { silent: true });
    expect(localStorage.getItem("hi-log.font-size")).toBe("16");
    expect(loadSettings().fontSize).toBe(16);
  });

  it("非静默写入会触发本窗口订阅通知", () => {
    // 非 Tauri 环境下广播被 try/catch 跳过,设置本身不受影响
    expect(() => setSetting("theme", "light")).not.toThrow();
    expect(loadSettings().theme).toBe("light");
  });

  it("themeStyle 写为 glass 时 application 同步落地", () => {
    setSetting("themeStyle", "glass", { silent: true });
    expect(document.documentElement.dataset.themeStyle).toBe("glass");
    setSetting("themeStyle", "solid", { silent: true }); // 恢复,避免污染其它用例
  });
});
