import { describe, expect, it } from "vitest";
import { buildSearchOpts, sameSearchSpec, searchFlagsLabel, type SearchSpec } from "./search";

const spec = (p: Partial<SearchSpec> = {}): SearchSpec => ({
  query: "ERROR",
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  exclude: "",
  ...p,
});

describe("buildSearchOpts", () => {
  it("空排除词不下发(空正则当排除会排掉所有行)", () => {
    expect(buildSearchOpts(spec())).toEqual({
      regex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(buildSearchOpts(spec({ exclude: "   " }))).not.toHaveProperty("exclude");
  });

  it("有排除词时去掉首尾空白", () => {
    expect(buildSearchOpts(spec({ exclude: " expected " })).exclude).toBe("expected");
  });

  it("整词开关按 camelCase 传出", () => {
    expect(buildSearchOpts(spec({ wholeWord: true })).wholeWord).toBe(true);
  });
});

describe("sameSearchSpec", () => {
  it("五个字段任一不同都不算同一次检索", () => {
    const base = spec();
    expect(sameSearchSpec(base, spec())).toBe(true);
    const diffs: Partial<SearchSpec>[] = [
      { query: "WARN" },
      { regex: true },
      { caseSensitive: true },
      { wholeWord: true },
      { exclude: "debug" },
    ];
    for (const d of diffs) {
      expect(sameSearchSpec(base, spec(d)), JSON.stringify(d)).toBe(false);
    }
  });

  it("排除词只差首尾空白视为同一次", () => {
    expect(sameSearchSpec(spec({ exclude: "x" }), spec({ exclude: " x " }))).toBe(true);
  });
});

describe("searchFlagsLabel", () => {
  it("无选项时为空串", () => {
    expect(searchFlagsLabel(spec())).toBe("");
  });

  it("按 开关 → 排除词 顺序拼接", () => {
    expect(searchFlagsLabel(spec({ regex: true, caseSensitive: true, wholeWord: true }))).toBe(
      ".* Aa \\b",
    );
    expect(searchFlagsLabel(spec({ exclude: "timeout" }))).toBe("⊘timeout");
    expect(searchFlagsLabel(spec({ caseSensitive: true, exclude: " x " }))).toBe("Aa ⊘x");
  });
});
