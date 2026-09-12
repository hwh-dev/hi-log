// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;
mod mcp;

use std::io::Write;

use hi_log_core::document::Document as CoreDocument;
use hi_log_core::encoding::Encoding as CoreEncoding;
use hi_log_core::marks::{
    Mark as CoreMark, MarkStore, Pin as CorePin, PinGroup as CorePinGroup,
};
use hi_log_core::search::{search as core_search, SearchOptions};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    /// 文档以 Arc 共享:后台搜索线程与 UI 线程可并发只读访问。
    /// 外层也 Arc:open_file 后台线程可 clone 持有,不必跨 await 持锁。
    documents: Arc<Mutex<HashMap<String, Arc<CoreDocument>>>>,
}

struct SearchState {
    next_id: AtomicU32,
    tasks: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
}

#[derive(Serialize)]
struct FileMeta {
    id: String,
    size: u64,
    lines: usize,
    encoding: String,
}

#[derive(Serialize)]
struct LineData {
    text: String,
    line_no: usize, // 1-based for display
}

/// 打开文件:mmap + 行索引在**后台线程**执行(tauri async command,
/// spawn_blocking 跑阻塞扫描),不冻结 UI 线程 —— 大文件拖拽不再卡界面。
#[tauri::command]
async fn open_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    force_encoding: Option<String>,
) -> Result<FileMeta, String> {
    // 强制编码覆盖自动检测(设置项:auto/utf8/gbk/utf16);UTF-16 统一按 LE 尝试
    let enc = match force_encoding.as_deref() {
        None | Some("auto") => None,
        Some("utf8") => Some(CoreEncoding::Utf8),
        Some("gbk") => Some(CoreEncoding::Gbk),
        Some("utf16") => Some(CoreEncoding::Utf16Le),
        Some(other) => return Err(format!("unknown encoding: {other}")),
    };
    let docs = state.documents.clone();
    let p = path.clone();
    // 阻塞的 mmap + 建索引放后台线程,await 期间 UI 线程可继续响应
    let doc = tauri::async_runtime::spawn_blocking(move || {
        CoreDocument::open_with_encoding(&p, enc).map_err(|e| format!("open: {e}"))
    })
    .await
    .map_err(|e| format!("open task join: {e}"))??;
    let meta = FileMeta {
        id: path.clone(),
        size: doc.size(),
        lines: doc.line_count(),
        encoding: doc.encoding().name().to_string(),
    };
    docs.lock().unwrap_or_else(|e| e.into_inner()).insert(path, Arc::new(doc));
    // 通知前端"文件已就绪"(前端可据此刷新状态栏/进度)
    let _ = app.emit("file_opened", &meta);
    Ok(meta)
}

/// 关闭文件:从文档表驱逐(mmap 释放);marks/pins 留在 SQLite,重开仍在
#[tauri::command]
fn close_file(state: State<AppState>, file_id: String) -> Result<(), String> {
    state.documents.lock().unwrap_or_else(|e| e.into_inner()).remove(&file_id);
    Ok(())
}

/// 前端 JS 错误(未捕获异常/未处理 Promise 拒绝)写入崩溃日志,
/// 与 Rust panic 同文件,便于完整反馈定位。
#[tauri::command]
fn log_js_error(message: String, stack: Option<String>) -> Result<(), String> {
    let dir = mcp::app_data_dir();
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("hi-log-crash.log"))
    {
        let _ = writeln!(f, "=== renderer error @ {} ===", now_unix());
        let _ = writeln!(f, "{message}");
        if let Some(s) = stack {
            let _ = writeln!(f, "{s}");
        }
        let _ = writeln!(f);
    }
    Ok(())
}

/// 分级运行日志:前端 debug 埋点(换行换算/跳转/渲染摘要)写 hi-log.log,
/// 用户复现后 `hi-log export log` 导出定位。level: debug/info/error(默认 info)。
#[tauri::command]
fn log_message(message: String, level: Option<String>) -> Result<(), String> {
    let dir = mcp::app_data_dir();
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("hi-log.log"))
    {
        let lv = level.unwrap_or_else(|| "info".into());
        let _ = writeln!(f, "[{} {}] {message}", now_unix(), lv);
    }
    Ok(())
}

/// 背景图:校验扩展名 → 拷贝到 app_data_dir/background.<ext> → 返回绝对路径。
/// 前端只存固定文件名(settings 的 hi-log.background),重选后覆盖同名文件。
#[tauri::command]
fn set_background_image(src_path: String) -> Result<String, String> {
    let ext = valid_bg_ext(&src_path).ok_or("unsupported image type")?;
    let dir = mcp::app_data_dir();
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let dest = dir.join(format!("background.{ext}"));
    std::fs::copy(&src_path, &dest).map_err(|e| format!("copy: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 背景图扩展名白名单(大小写不敏感);其余一律拒绝,防路径注入
fn valid_bg_ext(path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("png"),
        "jpg" => Some("jpg"),
        "jpeg" => Some("jpeg"),
        "webp" => Some("webp"),
        "bmp" => Some("bmp"),
        _ => None,
    }
}

/// tail 模式的轻量轮询:只 stat 文件大小,不变就不重建索引
#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("stat: {e}"))
}

#[tauri::command]
async fn get_lines(
    state: State<'_, AppState>,
    file_id: String,
    start: usize,
    count: usize,
) -> Result<Vec<LineData>, String> {
    let doc = state
        .documents
        .lock().unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned()
        .ok_or_else(|| "file not open".to_string())?;
    // 解码 + 序列化在后台线程执行,避免整块 get_lines 冻结 UI 线程
    // (行高索引构建 / 命中面板 / 固定行文本都会高频调用此命令;
    //  doc.get_lines 用顺序迭代,每行 O(1),而非逐行重建)
    tauri::async_runtime::spawn_blocking(move || {
        let lines: Vec<LineData> = doc
            .get_lines(start, count)
            .into_iter()
            .enumerate()
            .map(|(k, text)| LineData {
                text,
                line_no: start + k + 1,
            })
            .collect();
        Ok(lines)
    })
    .await
    .map_err(|e| format!("get_lines task join: {e}"))?
}

/// 行高索引:返回 `[start, start+count)` 每行的折行数(`cols` = 每视觉行可容纳列数)。
///
/// 在后端算 → 前端不必把整文件文本经 IPC 拉过去(465MB 文件实测省 ~17s),
/// 只回传每行一个 u32。折行模型见 `Document::wrap_counts`。
#[tauri::command]
async fn measure_wraps(
    state: State<'_, AppState>,
    file_id: String,
    start: usize,
    count: usize,
    cols: u32,
) -> Result<Vec<u32>, String> {
    let doc = state
        .documents
        .lock().unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned()
        .ok_or_else(|| "file not open".to_string())?;
    tauri::async_runtime::spawn_blocking(move || doc.wrap_counts(start, count, cols))
        .await
        .map_err(|e| format!("measure_wraps task join: {e}"))
}

// ── 检索 ──

#[derive(Deserialize)]
struct SearchOpts {
    regex: bool,
    #[serde(rename = "caseSensitive")]
    case_sensitive: bool,
}

#[derive(Clone, Serialize)]
struct HitPayload {
    line_no: usize, // 1-based
    ranges: Vec<(usize, usize)>,
    /// 命中行文本:随事件下发,前端直接缓存,滚动命中面板零 IPC
    content: String,
}

/// 携带 search_id:前端据此丢弃过期搜索的残留事件,
/// 避免并发扫描的事件互相污染计数与高亮。
#[derive(Clone, Serialize)]
struct ChunkPayload {
    search_id: u32,
    hits: Vec<HitPayload>,
}

#[derive(Clone, Serialize)]
struct SearchDonePayload {
    search_id: u32,
    hits: usize,
    cancelled: bool,
    truncated: bool,
}

#[tauri::command]
fn start_search(
    app: AppHandle,
    state: State<AppState>,
    search_state: State<SearchState>,
    file_id: String,
    query: String,
    opts: SearchOpts,
) -> Result<u32, String> {
    let doc = state
        .documents
        .lock().unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned()
        .ok_or_else(|| "file not open".to_string())?;

    // 强制单扫描:取消并清空所有旧任务。即使前端漏调 stop_search
    // (或竞态下旧线程已越过取消点),也保证同一时刻只有一个全量扫描在跑,
    // 避免 N 份扫描叠加把用户感知的耗时放大 N 倍。
    {
        let mut tasks = search_state.tasks.lock().unwrap_or_else(|e| e.into_inner());
        for flag in tasks.drain().map(|(_, f)| f) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    let id = search_state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    search_state.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(id, cancel.clone());
    let tasks = search_state.tasks.clone();

    std::thread::spawn(move || {
        let core_opts = SearchOptions {
            regex: opts.regex,
            case_sensitive: opts.case_sensitive,
            max_hits: 1_000_000,
        };
        let mut batch: Vec<HitPayload> = Vec::new();
        // 进度按时间节流(≥100ms 一次):避免每 4096 行的 emit 序列化+IPC
        // 把 6GB/s 的搜索线程拖慢、前端被海量 progress 事件刷爆重渲染
        let mut last_progress = Instant::now();
        let stats = core_search(
            &doc,
            &query,
            &core_opts,
            &cancel,
            |hit| {
                batch.push(HitPayload {
                    line_no: hit.line_no + 1,
                    ranges: hit.ranges.iter().map(|r| (r.start, r.end)).collect(),
                    content: doc.line_string(hit.line_no).unwrap_or_default(),
                });
                if batch.len() >= 2000 {
                    let _ = app.emit(
                        "search_chunk",
                        &ChunkPayload {
                            search_id: id,
                            hits: std::mem::take(&mut batch),
                        },
                    );
                }
            },
            |scanned, total| {
                if last_progress.elapsed().as_millis() >= 100 || scanned == total {
                    last_progress = Instant::now();
                    let _ = app.emit(
                        "search_progress",
                        &serde_json::json!({
                            "search_id": id,
                            "scanned": scanned,
                            "total": total,
                        }),
                    );
                }
            },
        );
        if !batch.is_empty() {
            let _ = app.emit(
                "search_chunk",
                &ChunkPayload {
                    search_id: id,
                    hits: batch,
                },
            );
        }
        let _ = app.emit(
            "search_done",
            &SearchDonePayload {
                search_id: id,
                hits: stats.hits,
                cancelled: stats.cancelled,
                truncated: stats.truncated,
            },
        );
        tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    });

    Ok(id)
}

#[tauri::command]
fn stop_search(search_state: State<SearchState>, search_id: u32) {
    if let Some(cancel) = search_state.tasks.lock().unwrap_or_else(|e| e.into_inner()).get(&search_id) {
        cancel.store(true, Ordering::Relaxed);
    }
}

// ── 标记 ──

struct MarkState {
    store: Mutex<MarkStore>,
}

#[derive(Clone, Serialize)]
struct MarkPayload {
    id: i64,
    file_id: String,
    line_no: usize, // 1-based
    color: u8,
    note: String,
    col: Option<usize>,
    len: Option<usize>,
    created_at: i64,
}

impl From<CoreMark> for MarkPayload {
    fn from(m: CoreMark) -> Self {
        MarkPayload {
            id: m.id,
            file_id: m.file_id,
            line_no: m.line_no,
            color: m.color,
            note: m.note,
            col: m.col,
            len: m.len,
            created_at: m.created_at,
        }
    }
}

/// 标记变更后统一广播,前端据此重新拉取当前文件的标记
fn emit_marks_changed(app: &AppHandle) {
    let _ = app.emit("marks_changed", ());
}

#[tauri::command]
fn add_mark(
    app: AppHandle,
    state: State<MarkState>,
    file_id: String,
    line_no: usize,
    color: u8,
    note: Option<String>,
    col: Option<usize>,   // 部分标记:选中文本起始偏移(可选)
    len: Option<usize>,   // 部分标记:选中文本长度(可选)
) -> Result<MarkPayload, String> {
    let mark = state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .add_range(&file_id, line_no, color, &note.unwrap_or_default(), col, len)
        .map_err(|e| e.to_string())?;
    emit_marks_changed(&app);
    Ok(mark.into())
}

#[tauri::command]
fn update_mark(
    app: AppHandle,
    state: State<MarkState>,
    mark_id: i64,
    color: Option<u8>,
    note: Option<String>,
) -> Result<(), String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .update(mark_id, color, note.as_deref())
        .map_err(|e| e.to_string())?;
    emit_marks_changed(&app);
    Ok(())
}

#[tauri::command]
fn remove_mark(app: AppHandle, state: State<MarkState>, mark_id: i64) -> Result<(), String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .remove(mark_id)
        .map_err(|e| e.to_string())?;
    emit_marks_changed(&app);
    Ok(())
}

#[tauri::command]
fn list_marks(state: State<MarkState>, file_id: String) -> Result<Vec<MarkPayload>, String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .list(&file_id)
        .map_err(|e| e.to_string())
        .map(|marks| marks.into_iter().map(Into::into).collect())
}

// ── 固定(pin):独立于颜色标记的书签功能,支持分组与拖拽排序 ──

#[derive(Clone, Serialize)]
struct PinGroupPayload {
    id: i64,
    name: String,
}

#[derive(Clone, Serialize)]
struct PinPayload {
    id: i64,
    /// 1-based 行号
    line_no: usize,
    group_id: Option<i64>,
    /// 自定义名称(可空)
    name: String,
    created_at: i64,
}

#[derive(Clone, Serialize)]
struct PinListPayload {
    groups: Vec<PinGroupPayload>,
    pins: Vec<PinPayload>,
}

impl From<CorePinGroup> for PinGroupPayload {
    fn from(g: CorePinGroup) -> Self {
        PinGroupPayload { id: g.id, name: g.name }
    }
}

impl From<CorePin> for PinPayload {
    fn from(p: CorePin) -> Self {
        PinPayload { id: p.id, line_no: p.line_no, group_id: p.group_id, name: p.name, created_at: p.created_at }
    }
}

/// 固定变更后统一广播,前端据此重新拉取当前文件的固定
fn emit_pins_changed(app: &AppHandle) {
    let _ = app.emit("pins_changed", ());
}

#[tauri::command]
fn add_pin(
    app: AppHandle,
    state: State<MarkState>,
    file_id: String,
    line_no: usize,
    group_id: Option<i64>,
    name: String,
) -> Result<PinPayload, String> {
    let pin = state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .add_pin(&file_id, line_no, group_id, &name)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(pin.into())
}

#[tauri::command]
fn remove_pin(app: AppHandle, state: State<MarkState>, pin_id: i64) -> Result<(), String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .remove_pin(pin_id)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(())
}

#[tauri::command]
fn rename_pin(app: AppHandle, state: State<MarkState>, pin_id: i64, name: String) -> Result<PinPayload, String> {
    let pin = state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .rename_pin(pin_id, &name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "pin not found".to_string())?;
    emit_pins_changed(&app);
    Ok(pin.into())
}

#[tauri::command]
fn list_pins(state: State<MarkState>, file_id: String) -> Result<PinListPayload, String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .list_pins(&file_id)
        .map_err(|e| e.to_string())
        .map(|l| PinListPayload {
            groups: l.groups.into_iter().map(Into::into).collect(),
            pins: l.pins.into_iter().map(Into::into).collect(),
        })
}

#[tauri::command]
fn create_pin_group(
    app: AppHandle,
    state: State<MarkState>,
    file_id: String,
    name: String,
) -> Result<PinGroupPayload, String> {
    let g = state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .create_pin_group(&file_id, &name)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(g.into())
}

#[tauri::command]
fn delete_pin_group(
    app: AppHandle,
    state: State<MarkState>,
    file_id: String,
    group_id: i64,
) -> Result<(), String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .delete_pin_group(&file_id, group_id)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(())
}

/// 组内全量重排(拖拽排序后调用)
#[tauri::command]
fn reorder_pins(
    app: AppHandle,
    state: State<MarkState>,
    file_id: String,
    group_id: i64,
    ids: Vec<i64>,
) -> Result<(), String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .reorder_pins(&file_id, group_id, &ids)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(())
}

/// 分组全量重排(拖拽分组顺序后调用)
#[tauri::command]
fn reorder_pin_groups(
    app: AppHandle,
    state: State<MarkState>,
    file_id: String,
    ids: Vec<i64>,
) -> Result<(), String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .reorder_pin_groups(&file_id, &ids)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(())
}

/// 跨组移动:移到目标组末尾
#[tauri::command]
fn move_pin_to_group(
    app: AppHandle,
    state: State<MarkState>,
    pin_id: i64,
    file_id: String,
    group_id: i64,
) -> Result<(), String> {
    state
        .store
        .lock().unwrap_or_else(|e| e.into_inner())
        .move_pin_to_group(pin_id, &file_id, group_id)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(())
}

// ── 独立面板窗口: 搜索命中 / 快照+标记 可弹出为单独窗口 ──

/// 弹窗窗口规格:label / 标题 / 宽 / 高
fn panel_spec(kind: &str) -> Option<(&'static str, &'static str, f64, f64)> {
    match kind {
        "filter" => Some(("filter-popout", "搜索命中 — hi-log", 760.0, 520.0)),
        "sidebar" => Some(("sidebar-popout", "快照与标记 — hi-log", 400.0, 680.0)),
        _ => None,
    }
}

/// 创建(或重建)一个独立面板窗口。前端复用同一 index.html,
/// 由 main.tsx 按 window label 分流渲染不同面板。
///
/// 平台差异(弹窗生命周期):
/// - **Windows**:启动时预创建+隐藏常驻(wry 运行时创建的第二个 webview 会
///   空白),关闭=隐藏、webview 永不销毁;open_panel 只 show/focus。
/// - **Linux / macOS**(WebKitGTK / WKWebView 无此 bug):首次打开才创建,
///   关闭即销毁、无常驻隐藏 webview。原"常驻隐藏"方案在 Linux 上卡顿的
///   根源:隐藏的 webkit 进程仍持续合成渲染 + 常驻 webview 全程收事件。
fn create_popout_window(
    app: &tauri::AppHandle,
    kind: &str,
) -> Result<tauri::WebviewWindow, String> {
    let (label, title, width, height) =
        panel_spec(kind).ok_or_else(|| format!("unknown panel kind: {kind}"))?;
    #[cfg(debug_assertions)]
    eprintln!("[hi-log] popout {label} create on {}", std::env::consts::OS);
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(title)
    .inner_size(width, height)
    .min_inner_size(320.0, 240.0)
    // 无原生边框:与主窗口一致,用自定义标题栏(popout-header)。
    // 否则弹窗同时有原生标题栏(最小/最大/关闭)和自定义 ×,出现两个关闭按钮。
    .decorations(false);
    // 仅 Windows 预创建必须隐藏,open_panel 时再 show;
    // shadow 重绑定使 Windows 独有字段不引入 unused_mut 警告(非 Windows 分支从不重赋值)
    #[cfg(target_os = "windows")]
    let builder = builder.visible(false);
    let win = builder.build().map_err(|e| e.to_string())?;
    // 关闭拦截:两平台都必须广播 panel_closed(主窗口据此恢复内嵌面板)。
    // 不注册 JS onCloseRequested 监听(那会让关闭走 JS destroy 流程,
    // Windows WebView2 异常环境下销毁可能卡死整个应用);Rust 侧处理最稳。
    {
        let app2 = app.clone();
        let label2 = label;
        #[cfg(target_os = "windows")]
        let win2 = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                #[cfg(target_os = "windows")]
                {
                    // Windows:关闭=隐藏,窗口与 webview 永远存活
                    api.prevent_close();
                    let _ = win2.hide();
                }
                // 非 Windows 平台 api 仅用于 prevent_close,此处显式忽略
                #[cfg(not(target_os = "windows"))]
                let _ = api;
                #[cfg(debug_assertions)]
                eprintln!("[hi-log] popout {label2} closed on {}", std::env::consts::OS);
                let _ = app2.emit("panel_closed", &label2);
            }
            _ => {}
        });
    }
    Ok(win)
}

/// 打开(或聚焦)一个独立面板窗口。
#[tauri::command]
fn open_panel(app: AppHandle, kind: String) -> Result<(), String> {
    let (label, _, _, _) =
        panel_spec(&kind).ok_or_else(|| format!("unknown panel kind: {kind}"))?;
    // 已存在(Windows 预创建常驻 / Linux 尚未关闭)→ 只显示/聚焦
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    // 不存在(Linux/macOS 首次打开或上次关闭已销毁)→ 运行时创建。
    // Windows 下此为兜底(正常流程启动时已预创建)。
    let win = create_popout_window(&app, &kind)?;
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// `hi-log export marks <file> [--format json]` — 直读 SQLite 导出标记与固定。
/// 不依赖 GUI:AI/脚本可直接消费 JSON。
fn cli_export(args: &[String]) -> Result<(), String> {
    let what = args.first().map(String::as_str).unwrap_or("");
    // 导出运行日志(分级埋点 + 崩溃记录,便于反馈):hi-log export log
    if what == "log" {
        let dir = mcp::app_data_dir();
        let run = dir.join("hi-log.log");
        let crash = dir.join("hi-log-crash.log");
        println!("run log:  {}", run.display());
        println!("crash:    {}", crash.display());
        if run.exists() {
            println!("{}", std::fs::read_to_string(&run).unwrap_or_default());
        }
        if crash.exists() {
            println!("--- crash ---");
            println!("{}", std::fs::read_to_string(&crash).unwrap_or_default());
        }
        return Ok(());
    }
    if what != "marks" {
        return Err("usage: hi-log export marks <file> [--format json]".into());
    }
    // args 形如 [marks, <file>, ...];跳过子命令名取文件路径
    let file = args
        .get(1)
        .filter(|a| !a.starts_with('-'))
        .ok_or_else(|| "missing file path".to_string())?;
    // 数据目录与 GUI 一致,确保存在后打开
    if let Some(dir) = mcp::app_data_dir().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let store = MarkStore::open(mcp::marks_db_path()).map_err(|e| format!("marks db: {e}"))?;
    let marks = store.list(file).map_err(|e| e.to_string())?;
    let all = store.list_pins(file).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out = serde_json::json!({
        "file": file,
        "exported_at": now,
        "marks": marks.iter().map(|m| serde_json::json!({
            "line_no": m.line_no, "color": m.color, "note": m.note
        })).collect::<Vec<_>>(),
        "pins": all.pins.iter().map(|p| serde_json::json!({
            "line_no": p.line_no,
            "group": all.groups.iter().find(|g| Some(g.id) == p.group_id)
                .map(|g| g.name.as_str()).unwrap_or(""),
            "name": p.name
        })).collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    Ok(())
}

/// 崩溃日志:panic hook 写 app_data_dir/hi-log-crash.log(release 无 console,便于反馈)
fn install_crash_hook() {
    std::panic::set_hook(Box::new(|info| {
        let dir = mcp::app_data_dir();
        if let Some(parent) = dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("hi-log-crash.log"))
        {
            let _ = writeln!(f, "=== panic @ {} ===", now_unix());
            let _ = writeln!(f, "{info}");
            let _ = writeln!(f);
        }
        // 仍打到 stderr(调试器/终端可见;release 无 console 但保留)
        eprintln!("[hi-log] panic: {info}");
    }));
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn main() {
    install_crash_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // CLI 子命令:导出(M5)/ MCP Server(M5)
        Some("export") => {
            if let Err(e) = cli_export(&args[1..]) {
                eprintln!("hi-log export: {e}");
                std::process::exit(1);
            }
            return;
        }
        Some("mcp") => {
            mcp::serve();
            return;
        }
        _ => {}
    }

    // ── CLI 入口: `hi-log <file>` ──
    // 有非选项参数且已有实例在跑 → 转发给现有窗口后退出
    let cli_path = args.iter().find(|a| !a.starts_with('-')).cloned();
    if let Some(path) = &cli_path {
        if ipc::try_forward(path) {
            return;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            documents: Arc::new(Mutex::new(HashMap::new())),
        })
        .manage(SearchState {
            next_id: AtomicU32::new(0),
            tasks: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // 单实例监听:后续 `hi-log <file>` 通过 socket 转发到这里
            if let Some(listener) = ipc::spawn_listener() {
                let handle = handle.clone();
                ipc::serve(listener, move |path| {
                    let _ = handle.emit("cli_open", &path);
                });
            }

            // 标记数据库放在用户数据目录,如 %APPDATA%/dev.hilog.app/hi-log.db
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = MarkStore::open(dir.join("hi-log.db"))
                .map_err(|e| format!("marks db open failed: {e}"))?;
            app.manage(MarkState { store: Mutex::new(store) });

            // 弹窗窗口:Windows 启动时预创建(隐藏)—— wry 当前版本下"运行时创建的
            // 第二个 webview"控制器永不导航(空白窗),启动时创建才正常;弹窗常驻,
            // 关闭=隐藏(webview 存活),open_panel 只负责 show/focus。
            // Linux/macOS 无此 bug:不预创建,首次打开才创建、关闭即销毁,避免
            // 常驻隐藏 webkit 进程(隐藏窗口仍持续合成渲染 —— Linux 卡顿根源)。
            #[cfg(target_os = "windows")]
            for kind in ["filter", "sidebar"] {
                if let Err(e) = create_popout_window(app.handle(), kind) {
                    eprintln!("panel {kind} pre-create failed: {e}");
                }
            }

            // 首个实例且带文件参数:直接打开(转发失败 ⇒ 没有先例)
            if let Some(path) = cli_path {
                let _ = handle.emit("cli_open", &path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            close_file,
            log_js_error,
            log_message,
            file_size,
            get_lines,
            measure_wraps,
            start_search,
            stop_search,
            add_mark,
            update_mark,
            remove_mark,
            list_marks,
            add_pin,
            remove_pin,
            rename_pin,
            list_pins,
            create_pin_group,
            delete_pin_group,
            reorder_pins,
            reorder_pin_groups,
            move_pin_to_group,
            open_panel,
            set_background_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running hi-log");
}

#[cfg(test)]
mod tests {
    use super::valid_bg_ext;

    #[test]
    fn bg_ext_whitelist() {
        assert_eq!(valid_bg_ext("C:\\pics\\wallpaper.png"), Some("png"));
        assert_eq!(valid_bg_ext("/home/u/pic.JPG"), Some("jpg"));
        assert_eq!(valid_bg_ext("a.webp"), Some("webp"));
        assert_eq!(valid_bg_ext("a.jpeg"), Some("jpeg"));
        assert_eq!(valid_bg_ext("a.bmp"), Some("bmp"));
    }

    #[test]
    fn bg_ext_rejects() {
        assert_eq!(valid_bg_ext("a.gif"), None);
        assert_eq!(valid_bg_ext("a.xml"), None);
        assert_eq!(valid_bg_ext("a.png.sh"), None);
        assert_eq!(valid_bg_ext("noext"), None);
        assert_eq!(valid_bg_ext(""), None);
    }
}
