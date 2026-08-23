//! MCP Server(AI 工具集成):`hi-log mcp` 以 stdio 提供 JSON-RPC 2.0 服务。
//!
//! 独立进程模式,不依赖 GUI:直接 mmap 文件、直读 SQLite,
//! AI 助手(Claude Code 等)可调用 open_file / search / get_lines /
//! mark_line / list_marks / pin_line 完成"分析日志 → 落标记"闭环。
//!
//! 多文件:可 open 任意多个文件(互不影响);其余工具用 `file_id`
//! 指定文件(缺省作用于最近打开的)。file_id = open_file 返回的路径。
//!
//! 协议:MCP 2024-11-05(initialize → tools/list → tools/call),
//! stdio 行分隔 JSON。每条工具调用的结果以 text 形式返回 JSON。
//! initialize 返回 instructions 引导 AI 使用方法。

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::Arc;

use hi_log_core::document::Document;
use hi_log_core::marks::MarkStore;
use hi_log_core::search::{search as core_search, SearchOptions};
use serde_json::{json, Value};

/// 应用数据目录(与 Tauri 的 app_data_dir 一致):%APPDATA%/{identifier} 等。
pub fn app_data_dir() -> std::path::PathBuf {
    let ident = "dev.hilog.app";
    let dir = if cfg!(target_os = "windows") {
        std::env::var("APPDATA").map(std::path::PathBuf::from).unwrap_or_default()
    } else if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|h| std::path::Path::new(&h).join("Library/Application Support").to_path_buf())
            .unwrap_or_default()
    } else {
        std::env::var("XDG_DATA_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .map(|h| std::path::Path::new(&h).join(".local/share").to_path_buf())
                    .ok()
            })
            .unwrap_or_default()
    };
    dir.join(ident)
}

/// MCP 标记数据库路径(与 GUI 同源);CLI 导出复用
pub fn marks_db_path() -> std::path::PathBuf {
    app_data_dir().join("hi-log.db")
}

/// 服务端状态:多文件文档表(file_id=path)+ 最近打开 + 标记仓库(懒加载)
struct McpState {
    docs: HashMap<String, Arc<Document>>,
    current: Option<String>,
    store: Option<MarkStore>,
}

impl McpState {
    fn store(&mut self) -> Result<&MarkStore, String> {
        if self.store.is_none() {
            if let Some(dir) = app_data_dir().parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            self.store = Some(
                MarkStore::open(marks_db_path()).map_err(|e| format!("marks db: {e}"))?,
            );
        }
        Ok(self.store.as_ref().unwrap())
    }

    /// 解析 file_id:显式给出则用之,缺省取最近打开的文件
    fn file_id(&self, file_id: Option<&str>) -> Result<String, String> {
        if let Some(fid) = file_id {
            if !fid.is_empty() {
                return Ok(fid.to_string());
            }
        }
        self.current
            .clone()
            .ok_or_else(|| "no file open (call open_file first)".to_string())
    }

    /// 取指定文件的文档(Arc 克隆,便于与 store() 的借用共存)
    fn doc_for(&self, file_id: Option<&str>) -> Result<Arc<Document>, String> {
        let fid = self.file_id(file_id)?;
        self.docs
            .get(&fid)
            .cloned()
            .ok_or_else(|| format!("file not open: {fid} (call open_file first)"))
    }
}

/// AI 使用引导(initialize instructions,客户端会注入模型上下文)
const INSTRUCTIONS: &str = "\
hi-log MCP:分析日志文件并在 GUI 中留下标记。

基本流程:
1. open_file 打开日志(可反复调用打开多个文件,互不影响);返回的 file_id 就是该文件路径。
2. 其余工具(search / get_lines / mark_line / list_marks / pin_line / list_pins)
   用 file_id 参数指定文件;省略 file_id 时作用于最近打开的文件。
3. 分析出关键行后:mark_line 打颜色标记+备注(写清结论/原因),pin_line 固定书签;
   人在 GUI 中点击标记即可定位确认。

注意:
- 行号为 1-based;mark_line 的 color 取 0-7(4=蓝);备注建议说明为什么标记这一行。
- 已打开多个文件时,操作前最好显式传 file_id,避免误作用到别的文件。";

/// 工具定义(供 tools/list)
fn tool_defs() -> Value {
    json!([
        {
            "name": "open_file",
            "description": "打开日志文件并构建行索引(可打开多个文件,互不影响)。返回 file_id(即文件路径),后续搜索/标记用它指定文件;缺省时工具作用于最近打开的。",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "日志文件路径" }
            }, "required": ["path"] }
        },
        {
            "name": "search",
            "description": "全文检索指定文件(缺省最近打开的);返回命中行号(可带行内容)",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "检索词(默认子串,不区分大小写)" },
                "file_id": { "type": "string", "description": "open_file 返回的文件路径;缺省=最近打开" },
                "regex": { "type": "boolean", "description": "按正则匹配" },
                "case_sensitive": { "type": "boolean" },
                "with_content": { "type": "boolean", "description": "同时返回命中行内容(默认 true)" },
                "max_hits": { "type": "integer", "description": "命中上限(默认 1000)" }
            }, "required": ["query"] }
        },
        {
            "name": "get_lines",
            "description": "按行号批量取指定文件的行内容(1-based)",
            "inputSchema": { "type": "object", "properties": {
                "start": { "type": "integer", "description": "起始行号(1-based)" },
                "count": { "type": "integer", "description": "行数(默认 20)" },
                "file_id": { "type": "string", "description": "open_file 返回的文件路径;缺省=最近打开" }
            }, "required": ["start"] }
        },
        {
            "name": "mark_line",
            "description": "给指定文件的某行打标记(颜色+备注);同一行重复标记即更新。GUI 中立即可见",
            "inputSchema": { "type": "object", "properties": {
                "line_no": { "type": "integer", "description": "1-based 行号" },
                "file_id": { "type": "string", "description": "open_file 返回的文件路径;缺省=最近打开" },
                "color": { "type": "integer", "description": "色板下标 0-7(默认 4=蓝)" },
                "note": { "type": "string", "description": "备注(结论/待办等,建议写明原因)" }
            }, "required": ["line_no"] }
        },
        {
            "name": "list_marks",
            "description": "列出指定文件的全部标记",
            "inputSchema": { "type": "object", "properties": {
                "file_id": { "type": "string", "description": "open_file 返回的文件路径;缺省=最近打开" }
            } }
        },
        {
            "name": "pin_line",
            "description": "固定指定文件的某行(书签)到分组并可命名;一行只能固定一次",
            "inputSchema": { "type": "object", "properties": {
                "line_no": { "type": "integer", "description": "1-based 行号" },
                "file_id": { "type": "string", "description": "open_file 返回的文件路径;缺省=最近打开" },
                "group": { "type": "string", "description": "分组名(缺省进'默认'组,自动创建)" },
                "name": { "type": "string", "description": "固定名称(可空)" }
            }, "required": ["line_no"] }
        },
        {
            "name": "list_pins",
            "description": "列出指定文件的全部固定(分组+行号+名称)",
            "inputSchema": { "type": "object", "properties": {
                "file_id": { "type": "string", "description": "open_file 返回的文件路径;缺省=最近打开" }
            } }
        }
    ])
}

fn handle(state: &mut McpState, req: &Value) -> Option<Value> {
    let id = req.get("id")?.clone(); // 无 id = 通知,不响应
    let method = req.get("method")?.as_str()?;
    let params = req.get("params").cloned().unwrap_or(json!({}));

    let result = match method {
        "initialize" => json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "hi-log", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_defs() }),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(state, name, &args) {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(e) => json!({
                    "content": [{ "type": "text", "text": format!("error: {e}") }],
                    "isError": true
                }),
            }
        }
        _ => {
            return Some(json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            }))
        }
    };

    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn call_tool(state: &mut McpState, name: &str, args: &Value) -> Result<String, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let b = |k: &str, d: bool| args.get(k).and_then(|v| v.as_bool()).unwrap_or(d);
    let i = |k: &str, d: i64| args.get(k).and_then(|v| v.as_i64()).unwrap_or(d);
    // file_id 参数(可选;None/空 → 缺省最近打开)
    let fid_arg = args.get("file_id").and_then(|v| v.as_str());

    match name {
        "open_file" => {
            let path = s("path");
            if path.is_empty() {
                return Err("path required".into());
            }
            let doc = Document::open(&path).map_err(|e| format!("open: {e}"))?;
            let meta = json!({
                "file_id": path.clone(),
                "lines": doc.line_count(),
                "size": doc.size(),
                "encoding": doc.encoding().name()
            });
            state.docs.insert(path.clone(), Arc::new(doc));
            state.current = Some(path);
            Ok(serde_json::to_string_pretty(&meta).unwrap())
        }
        "search" => {
            let query = s("query");
            if query.is_empty() {
                return Err("query required".into());
            }
            let doc = state.doc_for(fid_arg)?;
            let opts = SearchOptions {
                regex: b("regex", false),
                case_sensitive: b("case_sensitive", false),
                max_hits: i("max_hits", 1000) as usize,
            };
            let with_content = b("with_content", true);
            let t0 = std::time::Instant::now();
            let mut hits: Vec<Value> = Vec::new();
            let stats = core_search(&doc, &query, &opts, &std::sync::atomic::AtomicBool::new(false),
                |hit| {
                    let mut v = json!({ "line_no": hit.line_no + 1 });
                    if with_content {
                        v["content"] = json!(doc.line_string(hit.line_no).unwrap_or_default());
                    }
                    hits.push(v);
                },
                |_, _| {},
            );
            let out = json!({
                "hits": hits,
                "hit_count": stats.hits,
                "total_lines": stats.total_lines,
                "truncated": stats.truncated,
                "time_ms": t0.elapsed().as_millis()
            });
            Ok(serde_json::to_string_pretty(&out).unwrap())
        }
        "get_lines" => {
            let doc = state.doc_for(fid_arg)?;
            let start = i("start", 1) as usize;
            let count = i("count", 20) as usize;
            let lines: Vec<Value> = (start..start.saturating_add(count))
                .map_while(|no| {
                    doc.line_string(no - 1).map(|text| json!({ "line_no": no, "text": text }))
                })
                .collect();
            Ok(serde_json::to_string_pretty(&json!({ "lines": lines })).unwrap())
        }
        "mark_line" => {
            let file_id = state.file_id(fid_arg)?;
            let line_no = i("line_no", 0) as usize;
            if line_no == 0 {
                return Err("line_no required".into());
            }
            let color = i("color", 4) as u8;
            let mark = state
                .store()?
                .add(&file_id, line_no, color, &s("note"))
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&json!({
                "id": mark.id, "line_no": mark.line_no, "color": mark.color, "note": mark.note
            }))
            .unwrap())
        }
        "list_marks" => {
            let file_id = state.file_id(fid_arg)?;
            let marks = state.store()?.list(&file_id).map_err(|e| e.to_string())?;
            let list: Vec<Value> = marks
                .iter()
                .map(|m| json!({ "id": m.id, "line_no": m.line_no, "color": m.color, "note": m.note }))
                .collect();
            Ok(serde_json::to_string_pretty(&json!({ "marks": list })).unwrap())
        }
        "pin_line" => {
            let file_id = state.file_id(fid_arg)?;
            let line_no = i("line_no", 0) as usize;
            if line_no == 0 {
                return Err("line_no required".into());
            }
            let store = state.store()?;
            let group = s("group");
            let gid = if group.is_empty() {
                None
            } else {
                Some(store.create_pin_group(&file_id, &group).map_err(|e| e.to_string())?.id)
            };
            let pin = store
                .add_pin(&file_id, line_no, gid, &s("name"))
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&json!({
                "id": pin.id, "line_no": pin.line_no, "group_id": pin.group_id, "name": pin.name
            }))
            .unwrap())
        }
        "list_pins" => {
            let file_id = state.file_id(fid_arg)?;
            let all = state.store()?.list_pins(&file_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&json!({
                "groups": all.groups.iter().map(|g| json!({ "id": g.id, "name": g.name })).collect::<Vec<_>>(),
                "pins": all.pins.iter().map(|p| json!({ "id": p.id, "line_no": p.line_no, "group_id": p.group_id, "name": p.name })).collect::<Vec<_>>()
            }))
            .unwrap())
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

/// 启动 stdio 服务循环(阻塞至 EOF)。
pub fn serve() {
    let stdin = std::io::stdin();
    let mut state = McpState {
        docs: HashMap::new(),
        current: None,
        store: None,
    };
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(line) else {
            continue; // 非 JSON 行(如日志输出)静默跳过
        };
        let mut out = std::io::stdout().lock();
        if let Some(resp) = handle(&mut state, &req) {
            let _ = writeln!(out, "{resp}");
            let _ = out.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, params: Value, id: i64) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    fn empty_state() -> McpState {
        McpState { docs: HashMap::new(), current: None, store: None }
    }

    fn call_text(s: &mut McpState, name: &str, args: Value) -> String {
        let r = handle(s, &req("tools/call", json!({ "name": name, "arguments": args }), 1)).unwrap();
        r["result"]["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn initialize_handshake() {
        let mut s = empty_state();
        let r = handle(&mut s, &req("initialize", json!({}), 1)).unwrap();
        assert_eq!(r.get("result").unwrap().get("protocolVersion").unwrap(), "2024-11-05");
        assert_eq!(r.get("result").unwrap().get("serverInfo").unwrap().get("name").unwrap(), "hi-log");
        // AI 使用引导存在
        assert!(r["result"]["instructions"].as_str().unwrap().contains("open_file"));
    }

    #[test]
    fn tools_list_contains_core_tools() {
        let mut s = empty_state();
        let r = handle(&mut s, &req("tools/list", json!({}), 1)).unwrap();
        let tools = r.get("result").unwrap().get("tools").unwrap().as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t.get("name").and_then(|n| n.as_str())).collect();
        for want in ["open_file", "search", "get_lines", "mark_line", "list_marks", "pin_line"] {
            assert!(names.contains(&want), "missing tool {want}");
        }
    }

    #[test]
    fn notification_is_ignored() {
        let mut s = empty_state();
        assert!(handle(&mut s, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
    }

    #[test]
    fn unknown_method_errors() {
        let mut s = empty_state();
        let r = handle(&mut s, &req("bogus", json!({}), 1)).unwrap();
        assert_eq!(r.get("error").unwrap().get("code").unwrap(), -32601);
    }

    #[test]
    fn open_and_search_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.log");
        std::fs::write(&path, "hello world\nOOM at line 2\noom again\n").unwrap();
        let mut s = empty_state();

        let text = call_text(&mut s, "open_file", json!({ "path": path.to_string_lossy() }));
        assert!(text.contains("\"lines\": 3"));
        assert!(text.contains("\"file_id\""));

        let text = call_text(&mut s, "search", json!({ "query": "oom" }));
        assert!(text.contains("\"hit_count\": 2"), "got {text}");

        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["hits"][0]["content"], "OOM at line 2");

        let text = call_text(&mut s, "get_lines", json!({ "start": 2, "count": 2 }));
        assert!(text.contains("OOM at line 2"));
        assert!(text.contains("oom again"));
    }

    #[test]
    fn multi_file_with_file_id() {
        // 打开两个文件,分别用显式 file_id 检索/标记,互不干扰
        let dir = tempfile::tempdir().unwrap();
        let pa = dir.path().join("a.log");
        let pb = dir.path().join("b.log");
        std::fs::write(&pa, "alpha beta\ngamma\n").unwrap();
        std::fs::write(&pb, "delta\nalpha delta\n").unwrap();
        let mut s = empty_state();

        call_text(&mut s, "open_file", json!({ "path": pa.to_string_lossy() }));
        call_text(&mut s, "open_file", json!({ "path": pb.to_string_lossy() }));

        // 显式 file_id 搜各自文件(最近打开是 b)
        let t = call_text(&mut s, "search", json!({ "query": "alpha", "file_id": pa.to_string_lossy() }));
        let v: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["hit_count"], 1);
        let t = call_text(&mut s, "search", json!({ "query": "alpha", "file_id": pb.to_string_lossy() }));
        let v: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["hit_count"], 1);
        // 缺省 = 最近打开(b):"delta" 在 b 命中 2 行("delta" 与 "alpha delta")
        let t = call_text(&mut s, "search", json!({ "query": "delta" }));
        let v: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["hit_count"], 2);

        // 分别标记,再按 file_id 列出,互不串
        call_text(&mut s, "mark_line", json!({ "line_no": 1, "file_id": pa.to_string_lossy(), "note": "A-1" }));
        call_text(&mut s, "mark_line", json!({ "line_no": 2, "file_id": pb.to_string_lossy(), "note": "B-2" }));
        let t = call_text(&mut s, "list_marks", json!({ "file_id": pa.to_string_lossy() }));
        assert!(t.contains("A-1"));
        assert!(!t.contains("B-2"));
    }

    #[test]
    fn mark_and_pin_via_mcp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.log");
        std::fs::write(&path, "a\nb\nc\n").unwrap();
        let mut s = empty_state();
        call_text(&mut s, "open_file", json!({ "path": path.to_string_lossy() }));

        let text = call_text(&mut s, "mark_line", json!({ "line_no": 2, "color": 6, "note": "关键" }));
        assert!(text.contains("\"line_no\": 2"));

        let text = call_text(&mut s, "pin_line", json!({ "line_no": 3, "group": "崩溃", "name": "第三行" }));
        assert!(text.contains("\"name\": \"第三行\""));

        let t = call_text(&mut s, "list_marks", json!({}));
        assert!(t.contains("关键"));
        let t = call_text(&mut s, "list_pins", json!({}));
        assert!(t.contains("崩溃"));
    }
}
