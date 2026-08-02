//! 大文件文档:mmap 加载 + 稀疏行索引。
//!
//! 内部行号一律 0-based;IPC / UI 层负责转换为 1-based 显示。

mod index;

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use memmap2::Mmap;

pub use index::{LineIndex, LinesFrom};

use crate::encoding::Encoding;

/// 一个已打开的日志文件。内容不读入内存,由 OS 按需分页。
pub struct Document {
    path: PathBuf,
    /// 空文件无法 mmap,以 None 兜底
    mmap: Option<Mmap>,
    size: u64,
    index: LineIndex,
    encoding: Encoding,
}

impl Document {
    /// 打开文件并同步构建稀疏行索引。
    ///
    /// 索引耗时与文件大小成正比(memchr 扫描,约数 GB/s)。需要
    /// "边索引边浏览"时应在后台线程调用(Tauri 壳负责),本函数保持纯粹。
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let file = File::open(&path)?;
        let size = file.metadata()?.len();
        // SAFETY: 日志查看场景下文件被外部修改是可接受的(klogg 同);
        // 文件追加由后续 tail 模式显式处理。
        let mmap = if size == 0 {
            None
        } else {
            Some(unsafe { Mmap::map(&file)? })
        };
        let index = LineIndex::build(mmap.as_deref().unwrap_or(&[]));
        let encoding = Encoding::detect(mmap.as_deref().unwrap_or(&[]));
        Ok(Document {
            path,
            mmap,
            size,
            index,
            encoding,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn line_count(&self) -> usize {
        self.index.line_count()
    }

    /// 检测到的文本编码
    pub fn encoding(&self) -> Encoding {
        self.encoding
    }

    fn data(&self) -> &[u8] {
        self.mmap.as_deref().unwrap_or(&[])
    }

    /// 取一行(0-based),不含换行符;CRLF 的 `\r` 一并剥除。
    pub fn line(&self, no: usize) -> Option<&[u8]> {
        self.index.line(self.data(), no)
    }

    /// 取一行并按文件编码解码(仅首行剥离 BOM)。
    pub fn line_string(&self, no: usize) -> Option<String> {
        self.line(no).map(|b| {
            let b = if no == 0 { self.encoding.strip_bom(b) } else { b };
            self.encoding.decode(b).into_owned()
        })
    }

    /// 顺序读取迭代器:从 `start` 行开始逐行返回 (行号, 行内容)。
    ///
    /// 复用上一行结束位置,每行只需一次 memchr;全量顺序扫描(如检索)
    /// 必须用它,逐行 [`line`](Self::line) 在亿级行时慢数百倍。
    pub fn lines_from(&self, start: usize) -> LinesFrom<'_> {
        self.index.lines_from(self.data(), start)
    }

    /// 视口批量拉取:从 `start` 起最多 `count` 行;接近 EOF 时返回更短。
    pub fn get_lines(&self, start: usize, count: usize) -> Vec<String> {
        (start..start.saturating_add(count))
            .map_while(|i| self.line_string(i))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn doc_with(content: &[u8]) -> (tempfile::NamedTempFile, Document) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        let doc = Document::open(f.path()).unwrap();
        (f, doc)
    }

    #[test]
    fn empty_file_has_zero_lines() {
        let (_f, doc) = doc_with(b"");
        assert_eq!(doc.line_count(), 0);
        assert_eq!(doc.line(0), None);
    }

    #[test]
    fn simple_lines() {
        let (_f, doc) = doc_with(b"first\nsecond\nthird\n");
        assert_eq!(doc.line_count(), 3);
        assert_eq!(doc.line(0), Some(&b"first"[..]));
        assert_eq!(doc.line(2), Some(&b"third"[..]));
        assert_eq!(doc.line(3), None);
    }

    #[test]
    fn last_line_without_newline_still_counts() {
        let (_f, doc) = doc_with(b"a\nb");
        assert_eq!(doc.line_count(), 2);
        assert_eq!(doc.line(1), Some(&b"b"[..]));
    }

    #[test]
    fn crlf_is_stripped() {
        let (_f, doc) = doc_with(b"one\r\ntwo\r\n");
        assert_eq!(doc.line(0), Some(&b"one"[..]));
        assert_eq!(doc.line(1), Some(&b"two"[..]));
    }

    #[test]
    fn lookup_across_checkpoints() {
        let mut content = Vec::new();
        for i in 0..5000 {
            content.extend_from_slice(format!("line-{i}\n").as_bytes());
        }
        let (_f, doc) = doc_with(&content);
        assert_eq!(doc.line_count(), 5000);
        for &no in &[0usize, 1, 1023, 1024, 1025, 2048, 4999] {
            assert_eq!(doc.line_string(no).unwrap(), format!("line-{no}"));
        }
        assert_eq!(doc.line(5000), None);
    }

    #[test]
    fn unicode_roundtrip() {
        let (_f, doc) = doc_with("你好,世界\n日志②\n".as_bytes());
        assert_eq!(doc.line_string(0).unwrap(), "你好,世界");
        assert_eq!(doc.line_string(1).unwrap(), "日志②");
    }

    #[test]
    fn get_lines_truncates_at_eof() {
        let (_f, doc) = doc_with(b"a\nb\nc\n");
        assert_eq!(doc.get_lines(1, 10), vec!["b".to_string(), "c".to_string()]);
        assert!(doc.get_lines(3, 5).is_empty());
    }

    #[test]
    fn lines_from_matches_line_and_crosses_checkpoints() {
        let mut content = Vec::new();
        for i in 0..5000 {
            content.extend_from_slice(format!("line-{i}\n").as_bytes());
        }
        let (_f, doc) = doc_with(&content);
        let seq: Vec<(usize, String)> = doc
            .lines_from(0)
            .map(|(no, b)| (no, String::from_utf8_lossy(b).into_owned()))
            .collect();
        assert_eq!(seq.len(), 5000);
        for (no, text) in &seq {
            assert_eq!(doc.line_string(*no).as_deref(), Some(text.as_str()));
        }
        // 从中间任意行开始也正确
        let mid: Vec<String> = doc
            .lines_from(2047)
            .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
            .collect();
        assert_eq!(mid.len(), 5000 - 2047);
        assert_eq!(mid[0], "line-2047");
        assert_eq!(mid.last().unwrap(), "line-4999");
    }

    #[test]
    fn lines_from_handles_crlf_and_no_trailing_newline() {
        let (_f, doc) = doc_with(b"one\r\ntwo\r\nthree");
        let got: Vec<String> = doc
            .lines_from(0)
            .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
            .collect();
        assert_eq!(got, vec!["one", "two", "three"]);
    }
}
