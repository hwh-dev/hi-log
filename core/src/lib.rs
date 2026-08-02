//! hi-log-core:hi-log 的核心库,与 UI 完全解耦。
//!
//! - [`document`]:mmap 文件加载 + 稀疏行索引,支撑亿级行的低成本视口拉取
//! - [`search`]:流式检索引擎(正则/子串),支持取消与进度
//! - [`marks`]:标记系统(颜色分组 + 备注),SQLite 持久化
//! - [`encoding`]:文本编码检测(UTF-8/GBK/UTF-16)与解码

pub mod document;
pub mod encoding;
pub mod marks;
pub mod search;

pub use document::Document;
pub use encoding::Encoding;
