//! MCP Server(AI 工具集成):`hi-log mcp` 以 stdio 提供 JSON-RPC 2.0 服务。
//!
//! 独立进程模式,不依赖 GUI:直接 mmap 文件、直读 SQLite,
//! AI 助手(Claude Code 等)可调用 open_file / search / get_lines /
//! mark_line / list_marks / pin_line 完成"分析日志 → 落标记"闭环。
//!
//! 协议:MCP 2024-11-05(initialize → tools/list → tools/call),
//! stdio 行分隔 JSON。每条工具调用的结果以 text 形式返回 JSON。

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

/// 服务端状态:当前打开的文件 + 标记仓库(懒加载)
struct McpState {
    doc: Option<Arc<Document>>,
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

    fn doc(&self) -> Result<&Document, String> {
        self.doc.as_deref().ok_or_else(|| "no file open".to_string())
    }
}

/// 工具定义(供 tools/list)
fn tool_defs() -> Value {
    json!([
        {
            "name": "open_file",
            "description": "打开(或重新加载)日志文件并构建行索引,返回行数/大小/编码",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "日志文件路径" }
            }, "required": ["path"] }
        },
        {
            "name": "search",
            "description": "全文检索当前文件;返回命中行号列表(可带行内容)",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "检索词(默认子串,不区分大小写)" },
                "regex": { "type": "boolean", "description": "按正则匹配" },
                "case_sensitive": { "type": "boolean" },
                "with_content": { "type": "boolean", "description": "同时返回命中行内容(默认 true)" },
                "max_hits": { "type": "integer", "description": "命中上限(默认 1000)" }
            }, "required": ["query"] }
        },
        {
            "name": "get_lines",
            "description": "按行号批量取行内容(1-based)",
            "inputSchema": { "type": "object", "properties": {
                "start": { "type": "integer", "description": "起始行号(1-based)" },
                "count": { "type": "integer", "description": "行数(默认 20)" }
            }, "required": ["start"] }
        },
        {
            "name": "mark_line",
            "description": "给某行打标记(颜色+备注);同一行重复标记即更新",
            "inputSchema": { "type": "object", "properties": {
                "line_no": { "type": "integer", "description": "1-based 行号" },
                "color": { "type": "integer", "description": "色板下标 0-7(默认 4=蓝)" },
                "note": { "type": "string", "description": "备注(结论/待办等)" }
            }, "required": ["line_no"] }
        },
        {
            "name": "list_marks",
            "description": "列出当前文件全部标记",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "pin_line",
            "description": "固定某行(书签)到分组并可命名;一行只能固定一次",
            "inputSchema": { "type": "object", "properties": {
                "line_no": { "type": "integer", "description": "1-based 行号" },
                "group": { "type": "string", "description": "分组名(缺省进'默认'组,自动创建)" },
                "name": { "type": "string", "description": "固定名称(可空)" }
            }, "required": ["line_no"] }
        },
        {
            "name": "list_pins",
            "description": "列出当前文件全部固定(分组+行号+名称)",
            "inputSchema": { "type": "object", "properties": {} }
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
            "serverInfo": { "name": "hi-log", "version": env!("CARGO_PKG_VERSION") }
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

    match name {
        "open_file" => {
            let path = s("path");
            if path.is_empty() {
                return Err("path required".into());
            }
            let doc = Document::open(&path).map_err(|e| format!("open: {e}"))?;
            let meta = json!({
                "path": path,
                "lines": doc.line_count(),
                "size": doc.size(),
                "encoding": doc.encoding().name()
            });
            state.doc = Some(Arc::new(doc));
            Ok(serde_json::to_string_pretty(&meta).unwrap())
        }
        "search" => {
            let query = s("query");
            let doc = state.doc()?;
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
            let doc = state.doc()?;
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
            let file_id = state.doc()?.path().to_string_lossy().into_owned();
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
            let file_id = state.doc()?.path().to_string_lossy().into_owned();
            let marks = state.store()?.list(&file_id).map_err(|e| e.to_string())?;
            let list: Vec<Value> = marks
                .iter()
                .map(|m| json!({ "id": m.id, "line_no": m.line_no, "color": m.color, "note": m.note }))
                .collect();
            Ok(serde_json::to_string_pretty(&json!({ "marks": list })).unwrap())
        }
        "pin_line" => {
            let file_id = state.doc()?.path().to_string_lossy().into_owned();
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
            let file_id = state.doc()?.path().to_string_lossy().into_owned();
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
    let mut state = McpState { doc: None, store: None };
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

    #[test]
    fn initialize_handshake() {
        let mut s = McpState { doc: None, store: None };
        let r = handle(&mut s, &req("initialize", json!({}), 1)).unwrap();
        assert_eq!(r.get("result").unwrap().get("protocolVersion").unwrap(), "2024-11-05");
        assert_eq!(r.get("result").unwrap().get("serverInfo").unwrap().get("name").unwrap(), "hi-log");
    }

    #[test]
    fn tools_list_contains_core_tools() {
        let mut s = McpState { doc: None, store: None };
        let r = handle(&mut s, &req("tools/list", json!({}), 1)).unwrap();
        let tools = r.get("result").unwrap().get("tools").unwrap().as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t.get("name").and_then(|n| n.as_str())).collect();
        for want in ["open_file", "search", "get_lines", "mark_line", "list_marks", "pin_line"] {
            assert!(names.contains(&want), "missing tool {want}");
        }
    }

    #[test]
    fn notification_is_ignored() {
        let mut s = McpState { doc: None, store: None };
        // 无 id 的通知 → 不响应
        assert!(handle(&mut s, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
    }

    #[test]
    fn unknown_method_errors() {
        let mut s = McpState { doc: None, store: None };
        let r = handle(&mut s, &req("bogus", json!({}), 1)).unwrap();
        assert_eq!(r.get("error").unwrap().get("code").unwrap(), -32601);
    }

    #[test]
    fn open_and_search_roundtrip() {
        // 用临时文件验证完整流程
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.log");
        std::fs::write(&path, "hello world\nOOM at line 2\noom again\n").unwrap();
        let mut s = McpState { doc: None, store: None };

        let r = handle(&mut s, &req("tools/call", json!({
            "name": "open_file", "arguments": { "path": path.to_string_lossy() }
        }), 1)).unwrap();
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"lines\": 3"));

        let r = handle(&mut s, &req("tools/call", json!({
            "name": "search", "arguments": { "query": "oom" }
        }), 2)).unwrap();
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"hit_count\": 2"), "got {text}");
        assert!(text.contains("\"line_no\": 2"));

        // 行内容随命中返回
        let v: Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["hits"][0]["content"], "OOM at line 2");

        // get_lines
        let r = handle(&mut s, &req("tools/call", json!({
            "name": "get_lines", "arguments": { "start": 2, "count": 2 }
        }), 3)).unwrap();
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("OOM at line 2"));
        assert!(text.contains("oom again"));
    }

    #[test]
    fn mark_and_pin_via_mcp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.log");
        std::fs::write(&path, "a\nb\nc\n").unwrap();
        let mut s = McpState { doc: None, store: None };
        handle(&mut s, &req("tools/call", json!({
            "name": "open_file", "arguments": { "path": path.to_string_lossy() }
        }), 1)).unwrap();

        // 标记
        let r = handle(&mut s, &req("tools/call", json!({
            "name": "mark_line", "arguments": { "line_no": 2, "color": 6, "note": "关键" }
        }), 2)).unwrap();
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("\"line_no\": 2"));

        // 固定到自定义分组
        let r = handle(&mut s, &req("tools/call", json!({
            "name": "pin_line", "arguments": { "line_no": 3, "group": "崩溃", "name": "第三行" }
        }), 3)).unwrap();
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"name\": \"第三行\""));

        // 列表
        let r = handle(&mut s, &req("tools/call", json!({
            "name": "list_marks", "arguments": {}
        }), 4)).unwrap();
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("关键"));

        let r = handle(&mut s, &req("tools/call", json!({
            "name": "list_pins", "arguments": {}
        }), 5)).unwrap();
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("崩溃"));
    }
}
