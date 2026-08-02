import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import FilterPopout from "./components/FilterPopout";
import SidebarPopout from "./components/SidebarPopout";
import "./styles/global.css";

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
