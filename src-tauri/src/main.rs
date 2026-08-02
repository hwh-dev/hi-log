// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;
mod mcp;

use hi_log_core::document::Document as CoreDocument;
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
    /// 文档以 Arc 共享:后台搜索线程与 UI 线程可并发只读访问
    documents: Mutex<HashMap<String, Arc<CoreDocument>>>,
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

#[tauri::command]
fn open_file(state: State<AppState>, path: String) -> Result<FileMeta, String> {
    let doc = CoreDocument::open(&path).map_err(|e| format!("open: {e}"))?;
    let meta = FileMeta {
        id: path.clone(),
        size: doc.size(),
        lines: doc.line_count(),
        encoding: doc.encoding().name().to_string(),
    };
    state
        .documents
        .lock()
        .unwrap()
        .insert(path, Arc::new(doc));
    Ok(meta)
}

/// tail 模式的轻量轮询:只 stat 文件大小,不变就不重建索引
#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("stat: {e}"))
}

#[tauri::command]
fn get_lines(
    state: State<AppState>,
    file_id: String,
    start: usize,
    count: usize,
) -> Result<Vec<LineData>, String> {
    let doc = state
        .documents
        .lock()
        .unwrap()
        .get(&file_id)
        .cloned()
        .ok_or_else(|| "file not open".to_string())?;
    let lines: Vec<LineData> = (start..start.saturating_add(count))
        .map_while(|i| {
            doc.line_string(i).map(|text| LineData {
                text,
                line_no: i + 1,
            })
        })
        .collect();
    Ok(lines)
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
        .lock()
        .unwrap()
        .get(&file_id)
        .cloned()
        .ok_or_else(|| "file not open".to_string())?;

    // 强制单扫描:取消并清空所有旧任务。即使前端漏调 stop_search
    // (或竞态下旧线程已越过取消点),也保证同一时刻只有一个全量扫描在跑,
    // 避免 N 份扫描叠加把用户感知的耗时放大 N 倍。
    {
        let mut tasks = search_state.tasks.lock().unwrap();
        for flag in tasks.drain().map(|(_, f)| f) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    let id = search_state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    search_state.tasks.lock().unwrap().insert(id, cancel.clone());
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
        tasks.lock().unwrap().remove(&id);
    });

    Ok(id)
}

#[tauri::command]
fn stop_search(search_state: State<SearchState>, search_id: u32) {
    if let Some(cancel) = search_state.tasks.lock().unwrap().get(&search_id) {
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
) -> Result<MarkPayload, String> {
    let mark = state
        .store
        .lock()
        .unwrap()
        .add(&file_id, line_no, color, &note.unwrap_or_default())
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
        .lock()
        .unwrap()
        .update(mark_id, color, note.as_deref())
        .map_err(|e| e.to_string())?;
    emit_marks_changed(&app);
    Ok(())
}

#[tauri::command]
fn remove_mark(app: AppHandle, state: State<MarkState>, mark_id: i64) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .remove(mark_id)
        .map_err(|e| e.to_string())?;
    emit_marks_changed(&app);
    Ok(())
}

#[tauri::command]
fn list_marks(state: State<MarkState>, file_id: String) -> Result<Vec<MarkPayload>, String> {
    state
        .store
        .lock()
        .unwrap()
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
        .lock()
        .unwrap()
        .add_pin(&file_id, line_no, group_id, &name)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(pin.into())
}

#[tauri::command]
fn remove_pin(app: AppHandle, state: State<MarkState>, pin_id: i64) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .remove_pin(pin_id)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(())
}

#[tauri::command]
fn rename_pin(app: AppHandle, state: State<MarkState>, pin_id: i64, name: String) -> Result<PinPayload, String> {
    let pin = state
        .store
        .lock()
        .unwrap()
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
        .lock()
        .unwrap()
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
        .lock()
        .unwrap()
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
        .lock()
        .unwrap()
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
        .lock()
        .unwrap()
        .reorder_pins(&file_id, group_id, &ids)
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
        .lock()
        .unwrap()
        .move_pin_to_group(pin_id, &file_id, group_id)
        .map_err(|e| e.to_string())?;
    emit_pins_changed(&app);
    Ok(())
}

// ── 独立面板窗口: 搜索命中 / 快照+标记 可弹出为单独窗口 ──

/// 打开(或聚焦)一个独立面板窗口。窗口前端复用同一 index.html,
/// 由 main.tsx 按 window label 分流渲染不同面板。
#[tauri::command]
fn open_panel(app: AppHandle, kind: String) -> Result<(), String> {
    let (label, title, width, height) = match kind.as_str() {
        "filter" => ("filter-popout", "搜索命中 — hi-log", 760.0, 520.0),
        "sidebar" => ("sidebar-popout", "快照与标记 — hi-log", 400.0, 680.0),
        _ => return Err(format!("unknown panel kind: {kind}")),
    };
    // 窗口在启动时预创建(setup),这里只负责显示/聚焦;
    // 关闭=隐藏(见 setup),窗口与 webview 永远存活
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    // 兜底(正常流程不会走到):运行时创建在 wry 当前版本下可能空白
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(320.0, 240.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `hi-log export marks <file> [--format json]` — 直读 SQLite 导出标记与固定。
/// 不依赖 GUI:AI/脚本可直接消费 JSON。
fn cli_export(args: &[String]) -> Result<(), String> {
    let what = args.first().map(String::as_str).unwrap_or("");
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

fn main() {
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
            documents: Mutex::new(HashMap::new()),
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

            // 弹窗窗口启动时预创建(隐藏):wry 当前版本下"运行时创建的第二个 webview"
            // 控制器永不导航(空白窗),启动时创建则正常。因此弹窗生命周期=常驻:
            // 关闭改成隐藏(webview 存活),open_panel 只负责 show/focus。
            for (label, title, w, h) in [
                ("filter-popout", "搜索命中 — hi-log", 760.0, 520.0),
                ("sidebar-popout", "快照与标记 — hi-log", 400.0, 680.0),
            ] {
                let win = match tauri::WebviewWindowBuilder::new(
                    app,
                    label,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title(title)
                .inner_size(w, h)
                .min_inner_size(320.0, 240.0)
                .visible(false)
                .build()
                {
                    Ok(w) => w,
                    Err(e) => {
                        eprintln!("panel {label} pre-create failed: {e}");
                        continue;
                    }
                };
                // 关闭 = 隐藏 + 广播 panel_closed(主窗口恢复内嵌面板)。
                // 不注册 JS onCloseRequested 监听(那会让关闭走 JS destroy 流程,
                // 运行时销毁路径同样可能卡死/失效);Rust 侧 prevent + hide 最稳。
                {
                    let app2 = app.handle().clone();
                    let label2 = label;
                    let win2 = win.clone();
                    win.on_window_event(move |event| match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = win2.hide();
                            let _ = app2.emit("panel_closed", &label2);
                        }
                        _ => {}
                    });
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
            file_size,
            get_lines,
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
            move_pin_to_group,
            open_panel
        ])
        .run(tauri::generate_context!())
        .expect("error while running hi-log");
}
