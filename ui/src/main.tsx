import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import FilterPopout from "./components/FilterPopout";
import SidebarPopout from "./components/SidebarPopout";
import { initSettingsBridge } from "./utils/settings";
import "./styles/global.css";

// 设置桥(三窗口共用):挂载即应用外观(主题/字体/字号 —— 修复 popout 永远 dark),
// 并监听 settings_changed 跨窗口同步
initSettingsBridge();

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
