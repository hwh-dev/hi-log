//! CLI → GUI 单实例桥:同机 TCP 环回 + magic 校验。
//!
//! 约定:GUI 监听 `127.0.0.1:PORT`。`hi-log <file>` 启动时先尝试连接;
//! 端口已被占用(已有实例)则发送 `open` 命令并退出,否则以 GUI 方式启动。
//!
//! 安全说明:固定环回端口意味着本机任意进程都能触发"打开文件"——这是
//! 单实例类应用(VS Code/klogg 同款)的常见取舍,本机信任模型可接受。
//! 收到命令后带 magic 前缀校验,防止误连端口上的其他协议。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

/// 环回端口(不常用区段,避免与常见服务冲突)
pub const PORT: u16 = 47821;
const MAGIC: &str = "hi-log-ipc-v1";

/// 尝试连接已有实例并发送打开命令;成功转发返回 true。
pub fn try_forward(path: &str) -> bool {
    match TcpStream::connect(("127.0.0.1", PORT)) {
        Ok(mut stream) => {
            let _ = writeln!(stream, "{MAGIC} open {path}");
            true
        }
        Err(_) => false, // 无实例在跑,调用方应以 GUI 方式启动
    }
}

/// 启动监听线程;返回监听器,`None` 表示端口已被占(已有实例)。
pub fn spawn_listener() -> Option<TcpListener> {
    TcpListener::bind(("127.0.0.1", PORT)).ok()
}

/// 在后台线程服务连接;`on_open` 在收到合法 open 命令时回调(携带文件路径)。
pub fn serve(listener: TcpListener, mut on_open: impl FnMut(String) + Send + 'static) {
    thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            let Ok(clone) = conn.try_clone() else { continue };
            let mut line = String::new();
            if BufReader::new(clone).read_line(&mut line).is_ok() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix(MAGIC) {
                    if let Some(path) = rest.strip_prefix(" open ") {
                        on_open(path.to_string());
                    }
                }
            }
            let _ = writeln!(conn, "ok");
        }
    });
}
