import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import FilterPopout from "./components/FilterPopout";
import SidebarPopout from "./components/SidebarPopout";
import { initSettingsBridge } from "./utils/settings";
import "./styles/global.css";

// 前端未捕获异常/Promise 拒绝 → 写入后端崩溃日志(便于反馈定位)
function reportError(message: string) {
  let stack: string | null = null;
  try {
    stack = new Error().stack ?? null;
  } catch {
    stack = null;
  }
  void invoke("log_js_error", { message: String(message).slice(0, 4000), stack }).catch(() => {});
}
window.addEventListener("error", (e) => reportError(e.message));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  reportError(r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r));
});

// 设置桥(三窗口共用):挂载即应用外观(主题/字体/字号 —— 修复 popout 永远 dark),
// 并监听 settings_changed 跨窗口同步
initSettingsBridge();

// 全局屏蔽 web 默认右键菜单:日志行自定义菜单已自行 preventDefault + 渲染,
// 其余区域(搜索输入框/侧栏空白/弹窗等)不再弹浏览器右键,统一极客交互
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 多窗口:主窗口渲染完整应用,独立面板窗口按 label 分流渲染对应面板
const label = getCurrentWindow().label;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {label === "filter-popout" ? (
      <FilterPopout />
    ) : label === "sidebar-popout" ? (
      <SidebarPopout />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
