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

/// 制表符列宽(与 CSS 默认 tab-size 一致)
const TAB_COLS: u32 = 8;

/// 是否宽字符(CJK / 全角):渲染占 2 列
fn is_wide(c: char) -> bool {
    matches!(
        c as u32,
        0x1100..=0x115F      // 韩文字母
        | 0x2E80..=0xA4CF    // CJK 部首/汉字/日文假名等
        | 0xAC00..=0xD7A3    // 韩文音节
        | 0xF900..=0xFAFF    // CJK 兼容汉字
        | 0xFE30..=0xFE6F    // CJK 兼容形式
        | 0xFF00..=0xFF60    // 全角形式
        | 0xFFE0..=0xFFE6    // 全角符号
    )
}

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
        Self::open_with_encoding(path, None)
    }

    /// 打开文件;`force` 指定时覆盖自动编码检测(设置项"强制编码"用)。
    /// 注意:编码只影响解码(行文本),行分割始终按 0x0A,与编码无关。
    pub fn open_with_encoding(
        path: impl AsRef<Path>,
        force: Option<Encoding>,
    ) -> io::Result<Self> {
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
        let encoding = force.unwrap_or_else(|| Encoding::detect(mmap.as_deref().unwrap_or(&[])));
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
    ///
    /// 用 `lines_from` 顺序迭代(每行 O(1)),而非逐行 `line_string`(每行从检查点
    /// 重扫块内换行符,O(count×1024))—— 视口/索引拉取在亿级行时快数百倍。
    pub fn get_lines(&self, start: usize, count: usize) -> Vec<String> {
        self.lines_from(start)
            .take(count)
            .map(|(no, b)| {
                let b = if no == 0 { self.encoding.strip_bom(b) } else { b };
                self.encoding.decode(b).into_owned()
            })
            .collect()
    }

    /// 计算 `[start, start+count)` 每行的**折行数**(行高索引)。
    ///
    /// 在后端算的原因:前端要算折行就得把整文件文本经 IPC 拉过去 —— 实测 465MB
    /// 文件光这一步就 ~17s。此处只回传每行一个 u32。
    ///
    /// 列宽模型与前端渲染一致(等宽字体 + `white-space:pre-wrap; word-break:break-all`):
    /// 半角 1 列、宽字符(CJK/全角)2 列、制表符推进到 [`TAB_COLS`] 的倍数;贪心装箱。
    pub fn wrap_counts(&self, start: usize, count: usize, cols: u32) -> Vec<u32> {
        let cols = cols.max(1);
        self.lines_from(start)
            .take(count)
            .map(|(_, b)| self.wrap_count_line(b, cols))
            .collect()
    }

    /// 单行折行数(见 [`Document::wrap_counts`])
    fn wrap_count_line(&self, bytes: &[u8], cols: u32) -> u32 {
        // 快路径:纯半角且无制表符 → 每个视觉行正好容纳 cols 个字符(日志绝大多数)。
        // 空行也要占 1 个视觉行,故 max(1)。
        if !bytes.iter().any(|&b| b >= 0x80 || b == b'\t') {
            let n = bytes.len() as u32;
            return ((n + cols - 1) / cols).max(1);
        }
        // 慢路径:解码后按字符宽度贪心装箱(含宽字符/制表符的行)
        let text = self.encoding.decode(bytes);
        let mut lines = 1u32;
        let mut used = 0u32;
        for ch in text.chars() {
            let w = if ch == '\t' {
                ((used / TAB_COLS) + 1) * TAB_COLS - used
            } else if is_wide(ch) {
                2
            } else {
                1
            };
            if used + w > cols {
                lines += 1;
                used = if w > cols { cols } else { w };
            } else {
                used += w;
            }
        }
        lines
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
    fn wrap_counts_ascii() {
        let (_f, doc) = doc_with(b"abcdefghij\n\nabcdefghijk\n");
        // cols=5: 10 字符 → 2 行;空行 → 1 行;11 字符 → 3 行
        assert_eq!(doc.wrap_counts(0, 3, 5), vec![2, 1, 3]);
        // cols=100:全部 1 行
        assert_eq!(doc.wrap_counts(0, 3, 100), vec![1, 1, 1]);
    }

    #[test]
    fn wrap_counts_wide_and_tab() {
        let (_f, doc) = doc_with("中文字\n\tAB\n".as_bytes());
        // 宽字符按 2 列:"中文字" = 6 列,cols=4 → 2 行(2+2 / 2 → 实际 3 字符:6 列 / 4 → 2 行)
        assert_eq!(doc.wrap_counts(0, 1, 4), vec![2]);
        // 制表符推进到 8 的倍数:tab 占 8 列 + "AB" 2 列 = 10 列,cols=8 → 2 行
        assert_eq!(doc.wrap_counts(1, 1, 8), vec![2]);
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

    // ── 强制编码(open_with_encoding)──

    #[test]
    fn open_with_none_equals_auto_detection() {
        let (_f, doc1) = doc_with(b"hello\nworld\n");
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"hello\nworld\n").unwrap();
        f.flush().unwrap();
        let doc2 = Document::open_with_encoding(f.path(), None).unwrap();
        assert_eq!(doc1.encoding(), doc2.encoding());
        assert_eq!(doc1.line_count(), doc2.line_count());
        assert_eq!(doc1.line_string(0), doc2.line_string(0));
    }

    #[test]
    fn force_utf8_overrides_gbk_detection() {
        // GBK 字节(自动检测判 GBK);强制 UTF-8 打开:编码记录为 UTF-8,
        // 解码按 lossy 出乱码但不 panic
        let gbk_bytes = encoding_rs::GBK.encode("中文日志").0.into_owned();
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&gbk_bytes).unwrap();
        f.flush().unwrap();
        let doc = Document::open_with_encoding(f.path(), Some(Encoding::Utf8)).unwrap();
        assert_eq!(doc.encoding(), Encoding::Utf8);
        let text = doc.line_string(0).unwrap();
        assert_ne!(text, "中文日志");
        // 对照:自动检测为 GBK 且正常解码
        let auto = Document::open(f.path()).unwrap();
        assert_eq!(auto.encoding(), Encoding::Gbk);
        assert_eq!(auto.line_string(0).unwrap(), "中文日志");
    }

    #[test]
    fn force_utf16_decodes_bomless_utf16() {
        // UTF-16LE 无 BOM("AB\n" = 42 00 43 00 0A 00);自动检测会误判 GBK
        let bytes: Vec<u8> = vec![0x41, 0x00, 0x42, 0x00, 0x0A, 0x00];
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        f.flush().unwrap();
        let auto = Document::open(f.path()).unwrap();
        assert_ne!(auto.encoding(), Encoding::Utf16Le);
        let doc = Document::open_with_encoding(f.path(), Some(Encoding::Utf16Le)).unwrap();
        assert_eq!(doc.encoding(), Encoding::Utf16Le);
        assert_eq!(doc.line_string(0).unwrap(), "AB");
    }
}
