# hi-log 设计文档

> 状态:**已确认** · 2026-08-01
> 本文档描述 hi-log 的实现思路与 UI 布局,确认后作为开发基线。

## 1. 技术栈定案

| 层 | 技术 | 理由 |
| --- | --- | --- |
| 核心库 | Rust + memmap2 + regex-automata | 性能、内存安全、UI 无关可测试 |
| 桌面壳 | Tauri 2 | 多端一致、生态丰富、打包/更新/通知开箱即用 |
| 前端 | React 18 + TypeScript + Vite | 生态最大,组件最多,AI 辅助开发效率最高 |
| 持久化 | SQLite(rusqlite) | 标记/快照结构化存储,单文件,零依赖 |
| CLI↔GUI | 本地 socket(named pipe / unix socket) | 单实例转发,低延迟 |

## 2. 仓库结构(Cargo workspace)

```
hi-log/
├── Cargo.toml          # workspace 根
├── core/               # hi-log-core:纯 Rust 核心库,不依赖 Tauri
│   └── src/
│       ├── document/   # mmap 加载、稀疏行索引、编码检测
│       ├── search/     # 流式检索引擎、快照(压缩行号集)
│       ├── marks/      # 标记模型 + SQLite 持久化
│       └── watch/      # tail 模式:文件追加监听(notify)
├── src-tauri/          # Tauri 壳:commands、events、单实例、socket server
├── cli/                # hi-log-cli:命令行入口,转发到运行中的 GUI
├── ui/                 # React + TS + Vite 前端
└── docs/
```

原则:**core 不知道 UI 的存在**。Tauri 壳只是把 core 能力暴露成 commands/events;CLI 与 GUI 平级,都通过同一套接口驱动 core。将来换 UI 框架,core 与 cli 零改动。

## 3. UI 布局

```
+--------------------------------------------------------------------+
| hi-log   [app.log] [nginx.log] [+]                       -  []  x  |  (1)
+--------------------------------------------------------------------+
| Search: OOM|OutOfMemory     [.*] [Aa] [Pin] [scope v] [history v]  |  (2)
+---------------+----------------------------------------------------+
| MARKS         |  1024 10:23:01 INFO  server started on :8080       |
| # OOM-first   |  1025 10:23:01 DEBUG conn pool init (8)            |
|   L1026  [n]  ||*1026 10:23:03 ERROR OOM killer invoked       [n]  |  (3)(4)
| # slow-sql    |  1027 10:23:03 INFO  retrying connection...        |
|   L88741      |  1028 ...                                          |
|               |                                                    |
| SNAPSHOTS     |   <- 虚拟滚动 · 行号 · 标记色槽 · 命中高亮          |
| * ERROR x1024 |                                                    |
| * timeout x23 |                                                    |
+---------------+----------------------------------------------------+
| FILTER: ERROR - 1,024 hits    (x) matches only  ( ) +/-3 ctx   [-] |  (5)
||*1026 10:23:03 ERROR OOM killer invoked                            |
||*4099 10:41:55 ERROR OOM killer invoked      double-click -> jump  |
+--------------------------------------------------------------------+
| app.log | 10.2 GB | 86,421,033 lines | indexed | UTF-8             |  (6)
+--------------------------------------------------------------------+
```

**(1) 标签栏**:打开的文件以 tab 排列;**自定义标题栏**(VS Code 风格,tab 融入标题栏节省纵向空间),P0 起即采用。
**(2) 检索栏**:正则开关 `.*`、大小写 `Aa`、📌固定为快照、范围(全文/选中/标记范围)、历史下拉。输入防抖 300ms 即输即搜。
**(3) 左侧边栏**(可折叠):**标记分组**(按颜色分组,可自定义组名,显示行号 + 备注图标)与**快照列表**。单击 → 主视图跳转居中。
**(4) 主视图**:虚拟滚动,行号列,行首标记色槽(`|*`),命中词高亮,当前行底色,行右键菜单(标记颜色/写备注/复制/定位)。
**(5) 底部过滤视图**(可收起、可拖高度):当前检索或选中快照的命中行,可切"仅匹配行 / ±N 行上下文",双击跳回主视图对应行。
**(6) 状态栏**:文件名、大小、行数、索引进度、命中数、编码。

### 关键交互

- 检索时:主视图高亮 + 底部增量出结果 + 状态栏命中数实时滚动,三者同步
- 点 📌:当前检索条件 + 结果集存为快照 → 出现在左侧快照列表,底部可切换查看;主日志继续追加不影响快照
- CLI 打标:主视图色条与左侧面板实时出现;窗口未激活时发系统通知

## 4. 核心数据流

1. **打开文件**:GUI → core 打开(mmap + 编码检测)→ 后台线程建稀疏行索引 → 前端按视口行范围拉取。索引未完成时也可浏览(已索引部分即时可用)。
2. **检索**:前端输入 → `start_search` → core 后台顺序扫描,命中分批以 event 推送 → 前端增量渲染;主视图跳转用"下一命中"直接查结果集,不重扫。
3. **快照**:`pin_snapshot` → core 保存查询条件 + 压缩行号集合(Roaring Bitmap,千万级命中只占 MB 级内存)。
4. **标记**:GUI 右键或 CLI → core 写 SQLite + 内存索引 → event 广播 → 所有视图刷新。
5. **tail**:notify 监听文件增长 → 追加索引 → 推送新行;若有过滤视图开启,新行增量匹配。

## 5. IPC 接口草案

```rust
// ── Tauri commands(前端 → 后端)──
open_file(path)              -> FileMeta { id, size, est_lines, encoding }
get_lines(file_id, start, n) -> LineBatch      // 视口拉取,含标记/命中区间
start_search(file_id, query, opts) -> search_id // 异步,结果走 event
stop_search(search_id)
pin_snapshot(search_id, name) -> snapshot_id
add_mark(file_id, line, color, note?) -> mark_id
update_mark(mark_id, ...) / remove_mark(mark_id)
list_marks(file_id) -> Vec<Mark>

// ── Tauri events(后端 → 前端推送)──
search_progress { search_id, hits, scanned_bytes, done }
search_chunk    { search_id, line_nos: [...] }   // 增量命中
file_appended   { file_id, total_lines }
marks_changed   { file_id }

// ── CLI ↔ GUI(本地 socket,JSON Lines)──
// 命令与 commands 同构;GUI 启动时监听,CLI 发现无实例则拉起 GUI 再转发
```

**行数据协议**:`get_lines` 初版用 JSON 批量(每包 ~200 行,滚动时预取前后各一屏);文本与样式分离(text + 高亮区间数组)。预留升级为二进制编码的口子,初版不提前优化。

## 6. 性能策略(关键决策)

| 问题 | 决策 |
| --- | --- |
| 亿级行的行索引 | **稀疏索引**:每 1024 行记一个偏移检查点,定位任意行 = 找检查点 + 块内顺扫(~100KB),索引内存从 800MB 降到 <1MB |
| 大文件全文检索 | **不做倒排索引**,顺序扫 mmap(SSD ~3-5s/10GB)流式出结果;结果集压缩缓存,二次查看秒出(klogg 同款思路) |
| 长行 | 单行 >64KB 截断显示,悬停看全部,避免一行撑爆渲染 |
| 虚拟滚动 | 固定行高(等宽字体 JetBrains Mono / Cascadia Code),行号 ↔ 像素 O(1) 换算,滚动 60fps |
| 前端拉取 | 视口 ±1 屏预取 + 滚动防抖,未命中的拉取请求可取消 |

## 7. 开发阶段(对齐 README Roadmap)

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **P0 骨架** | workspace + Tauri 工程 + mmap 打开 + 稀疏行索引 + `get_lines` + 前端虚拟滚动 | 10GB 文件秒开,滚动流畅 |
| **P1 检索** | 流式正则检索 + 高亮 + 底部过滤视图 + 进度显示 | 10GB 检索流畅出结果,可随时中断 |
| **P2 标记** | 标记模型 + SQLite + 左侧栏 + 右键菜单 + 跳转 | 标记增删改查、重开恢复 |
| **P3 CLI** | socket 协议 + open/mark/search/goto + 单实例 | CLI 打标,GUI 实时可见 |
| **P4 快照+tail** | 📌固定快照 + 文件追加跟踪 | 快照并存切换;tail 增量匹配 |
| **P5 打磨** | 主题、编码检测完善、性能调优、三端打包 | 达成 README 性能指标 |

## 8. 决策记录(2026-08-01 确认)

1. 快照入口:**左侧列表**(与标记面板共享侧栏)
2. 标记组织:**颜色分组 + 自定义组名**
3. 前端框架:**React 18 + TypeScript**
4. 标题栏:**自定义**(VS Code 风格,P0 起)

## 9. 多窗口(弹窗)设计(实现阶段追加,2026-08)

底部过滤视图与侧栏可弹出为独立窗口(popout),多窗口间状态实时同步。

### 9.1 窗口拓扑与路由

- 主窗口 label `main`(tauri.conf.json 默认);弹窗固定两个 label:`filter-popout`、`sidebar-popout`。
- 三个窗口加载同一 `index.html`,`ui/src/main.tsx` 按 `getCurrentWindow().label` 分流渲染 App / FilterPopout / SidebarPopout。

### 9.2 弹窗生命周期(平台差异,src-tauri/src/main.rs)

| 平台 | 创建 | 关闭 | 原因 |
| --- | --- | --- | --- |
| Windows | 启动时预创建 2 个隐藏窗口(setup) | 拦截 CloseRequested:`prevent_close()` + `hide()` + 广播 `panel_closed`,webview 永不销毁 | wry 0.55.x(WebView2)运行时创建的第二个 webview 控制器永不导航(空白窗);JS `onCloseRequested`/`destroy()` 路径在异常环境下可能卡死整个应用,故用 Rust 侧 prevent+hide |
| Linux / macOS | 首次 `open_panel` 时懒创建 | 不拦截,正常销毁,关闭前广播 `panel_closed` | WebKitGTK / WKWebView 无 wry 空白 bug;常驻隐藏 webkit 进程仍持续合成渲染 + 全程收事件,是 Linux 弹窗卡顿的根源。销毁后 label 自动释放,重开重建 |

实现:`create_popout_window()` 统一封装创建+关闭拦截,平台差异用 `#[cfg(target_os = "windows")]` 隔离;`open_panel` 先查 `get_webview_window`,存在则 show/focus,不存在(Linux 销毁后 / Windows 兜底)才创建。

### 9.3 状态同步(事件桥,全在 JS 侧)

- **快照握手**:弹窗挂载 emit `panel_ready {kind}` → 主窗口回发 `filter_snapshot {fileId, sessions, activeId}` / `sidebar_snapshot {fileId}`;`openPanel` 每次打开后也主动重发 filter_snapshot(Windows 常驻窗口关闭期间错过的事件由此补齐,Linux 首次打开兜底)。
- **搜索增量**:主窗口把 Rust 全局事件 `search_chunk/progress/done` 定向转发 `search_chunk_fwd/*_fwd`(带 `search_id`,前端按 id 丢弃过期残留);**仅弹窗打开时转发**(`popoutOpenRef` 门控,避免常驻隐藏窗口收事件)。
- **会话操作**:弹窗发起 `panel_session_activate/close/clear` → 主窗口统一执行状态 → 广播回弹窗,两端一致。
- **跳转**:弹窗点击命中行 `emitTo("main","goto_line")` → 主视图滚动+聚焦。
- **全局广播**(Rust `app.emit`,各窗口自行监听):`marks_changed` / `pins_changed` / `snapshots_changed` / `panel_closed`。
- **节流**:主窗口命中合并 80ms 节流(App.tsx flushHits);弹窗转发不节流,故 FilterPopout 同样做 80ms 节流,`search_done_fwd` 时冲刷残余。

### 9.4 Linux 卡顿排查(如仍有)

- 已消除:启动即常驻的 2 个隐藏 webkit 进程(合成渲染 + 事件处理)、隐藏窗口收事件风暴、弹窗逐 chunk setState。
- 若在特定显卡/合成器下仍有卡顿(WebKitGTK 渲染层问题):尝试
  `WEBKIT_DISABLE_COMPOSITING_MODE=1`(禁用合成,软件渲染)或
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`(Mesa dmabuf 缺陷导致的花屏/卡顿)。
- debug 构建下弹窗创建/关闭有 `[hi-log] popout ...` stderr 日志,可据此确认平台走了哪条生命周期路径。

### 9.5 WSLg 窗口不出现(2026-08-21 实测确认)

**症状**:WSL2 + WSLg 下 `hi-log` 进程存活,但桌面无窗口;stderr 出现
`MESA: error: ZINK: failed to choose pdev`、`egl: failed to create dri2 screen`。

**根因**:WSLg 注入 `WAYLAND_DISPLAY=wayland-0`,GTK3 默认选 **Wayland** 后端;
WebKitGTK 2.52 在该环境下 EGL/Mesa(zink)初始化失败,窗口从未映射。
实测 `GDK_BACKEND=x11` 强制走 X11 后端后窗口正常出现(仅剩无害的 DRI3 警告)。
`WEBKIT_DISABLE_DMABUF_RENDERER=1` / `WEBKIT_DISABLE_COMPOSITING_MODE=1`
单独使用无效(仍需 x11);`LIBGL_ALWAYS_SOFTWARE=1` 可去掉 DRI3 警告(软件渲染兜底)。

**修复**:启动脚本 `scripts/wsl-run.sh`(WSL 内检测到 microsoft 内核时自动设
`GDK_BACKEND=x11`);或手动 `export GDK_BACKEND=x11`。

**附带发现**:WSL 里直接 `cargo build`(未走 tauri-cli)产出的是 dev 模式二进制
(未启用 `custom-protocol` feature),会去连 `devUrl`(localhost:5173),无 vite 服务
时窗口显示 "Could not connect to localhost"。需 `cargo build --features tauri/custom-protocol`
嵌入 `ui/dist` 前端资源,或改用 `tauri dev`。
