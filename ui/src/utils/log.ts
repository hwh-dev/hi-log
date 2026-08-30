import { invoke } from "@tauri-apps/api/core";

// 分级运行日志:关键埋点(换算/跳转/渲染摘要)写后端 hi-log.log,
// 复现后 `hi-log export log` 导出定位。节流限制高频写入。
let lastTs = 0;
export function dbg(message: string) {
  const now = Date.now();
  if (now - lastTs < 200) return; // 200ms 节流(滚动高频时只留摘要)
  lastTs = now;
  void invoke("log_message", { message: message.slice(0, 1200), level: "debug" }).catch(() => {});
}
