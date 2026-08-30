// 长行换行测量:按可用宽度估算折行数(Canvas measureText,与 UI 字体近似)。
// 测量策略:对整段用 measureText 二分找每行断点,每"视觉行"约 log n 次测量。
let mlCanvas: HTMLCanvasElement | null = null;
export function measureLines(text: string, availWidth: number, font: string): number {
  if (availWidth <= 10) return 1;
  if (!text) return 1;
  if (!mlCanvas) mlCanvas = document.createElement("canvas");
  const ctx = mlCanvas.getContext("2d");
  if (!ctx) return 1;
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
