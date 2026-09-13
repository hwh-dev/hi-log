/**
 * 检索式的唯一形态来源:主查询 + 四个选项(正则/大小写/整词/排除词)。
 *
 * 前端有 4 个地方要把它送到后端(手动搜索、tail 重扫、导出命中、弹窗转发),
 * 全部从这里派生 —— 避免"新加一个选项、漏改某个调用点"。那类漏改不会报错,
 * 只会让某处静默按旧选项重扫,结果与屏幕上看到的对不上。
 */
export interface SearchSpec {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** 排除词(NOT):命中的行里再滤掉含它的;空 = 不排除 */
  exclude: string;
}

/** 选项部分(会话/历史条目都能直接当这个用) */
export type SearchFlags = Pick<SearchSpec, "regex" | "caseSensitive" | "wholeWord" | "exclude">;

/** 后端 `start_search` / `export_hits` 的 opts 参数(serde camelCase) */
export interface SearchOptsPayload {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  exclude?: string;
}

/** 排除词去首尾空白;空串不下发(后端也把空串当"不排除",两边都兜一层) */
export function buildSearchOpts(s: SearchFlags): SearchOptsPayload {
  const exclude = s.exclude.trim();
  return {
    regex: s.regex,
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    ...(exclude ? { exclude } : {}),
  };
}

/**
 * 会话复用 / 幂等判断:任一字段不同就是另一次检索。
 * 漏比一个字段的后果:"ERROR 排除 timeout" 会复用到 "ERROR 排除 debug" 的会话,
 * 而该会话里存的仍是旧选项 —— 导出与 tail 重扫会拿旧选项跑出与屏幕不一致的结果。
 */
export function sameSearchSpec(a: SearchSpec, b: SearchSpec): boolean {
  return (
    a.query === b.query &&
    a.regex === b.regex &&
    a.caseSensitive === b.caseSensitive &&
    a.wholeWord === b.wholeWord &&
    a.exclude.trim() === b.exclude.trim()
  );
}

/** 一行旗标(历史项 / 会话 chip):让"结果怎么少了一截"有迹可循 */
export function searchFlagsLabel(s: SearchFlags): string {
  const parts: string[] = [];
  if (s.regex) parts.push(".*");
  if (s.caseSensitive) parts.push("Aa");
  if (s.wholeWord) parts.push("\\b");
  const exclude = s.exclude.trim();
  if (exclude) parts.push(`⊘${exclude}`);
  return parts.join(" ");
}
