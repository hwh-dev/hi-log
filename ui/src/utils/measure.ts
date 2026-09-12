// 长行折行数估算(与 .log-line.wrap 的 white-space:pre-wrap + word-break:break-all 对齐)。
//
// 默认字体是等宽栈(Cascadia Code / JetBrains Mono / Consolas / monospace),因此:
//   · 纯可打印 ASCII 行(日志绝大多数)→ 折行数 = ceil(字符数 / 每行可容纳列数),
//     O(1) 算术,无需任何 measureText —— 亿级行索引构建的关键;
//   · 非等宽字体 / 含制表符或宽字符的行 → 回退到 Canvas 二分测量(精确)。
let mlCanvas: HTMLCanvasElement | null = null;
let mlFont = "";
/** >0 表示当前字体是等宽;值为单列宽(px)。0 = 非等宽,走精确路径。 */
let mlCharW = 0;

/** 必须走精确测量:出现制表符/控制符/非 ASCII(宽字符宽度与列宽模型不符) */
const ML_EXACT_RE = /[^\x20-\x7e]/;

/** 当前字体的单列宽(px);**非等宽字体返回 0**。
    用于把可用宽度换算成"每视觉行可容纳列数",交给后端算折行数。 */
export function fontCharWidth(font: string): number {
  if (!mlCanvas) mlCanvas = document.createElement("canvas");
  const ctx = mlCanvas.getContext("2d");
  if (!ctx) return 0;
  if (mlFont !== font) {
    ctx.font = font;
    mlFont = font;
    // 'M' 与 'i' 等宽 ⇒ 视为等宽字体
    const wM = ctx.measureText("M").width;
    const wi = ctx.measureText("i").width;
    mlCharW = wM > 0 && Math.abs(wM - wi) < 0.01 ? wM : 0;
  }
  return mlCharW;
}

export function measureLines(text: string, availWidth: number, font: string): number {
  if (availWidth <= 10) return 1;
  if (!text) return 1;
  if (!mlCanvas) mlCanvas = document.createElement("canvas");
  const ctx = mlCanvas.getContext("2d");
  if (!ctx) return 1;
  fontCharWidth(font);
  // 等宽 + 纯 ASCII:每行正好容纳 floor(availWidth / 列宽) 个字符,直接算
  if (mlCharW > 0 && !ML_EXACT_RE.test(text)) {
    const cols = Math.max(1, Math.floor(availWidth / mlCharW));
    return Math.max(1, Math.ceil(text.length / cols));
  }
  // 精确路径:Canvas 二分找每行断点
  ctx.font = font;
  const n = text.length;
  let lines = 1;
  let i = 0;
  while (i < n) {
    if (ctx.measureText(text.slice(i)).width <= availWidth) break;
    let lo = i + 1;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ctx.measureText(text.slice(i, mid)).width <= availWidth) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    i = lo;
    if (i >= n) break;
    lines++;
  }
  return Math.max(1, lines);
}
