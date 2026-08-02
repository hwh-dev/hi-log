//! 稀疏行索引:每 [`CHECKPOINT_INTERVAL`] 行记录一个字节偏移检查点。
//!
//! 全量行偏移表(u64 数组)在亿级行时约占 800MB;稀疏索引压到
//! `行数 / 1024 * 8` 字节,定位任意行的代价是块内顺扫(平均 ~100KB)。

use memchr::{memchr, memchr_iter};

/// 检查点间隔(行)
pub const CHECKPOINT_INTERVAL: usize = 1024;

pub struct LineIndex {
    /// 第 i 个检查点 = 第 `i * CHECKPOINT_INTERVAL` 行的起始字节偏移
    checkpoints: Vec<u64>,
    line_count: usize,
}

impl LineIndex {
    /// 单遍扫描构建索引(memchr 向量化,约数 GB/s)。
    pub fn build(data: &[u8]) -> Self {
        let mut checkpoints = vec![0u64];
        let mut line_count = 0usize;
        for pos in memchr_iter(b'\n', data) {
            line_count += 1;
            if line_count % CHECKPOINT_INTERVAL == 0 {
                checkpoints.push(pos as u64 + 1);
            }
        }
        // 非空且不以 \n 结尾:末尾无换行符的部分也算一行
        if data.last().is_some_and(|&b| b != b'\n') {
            line_count += 1;
        }
        LineIndex {
            checkpoints,
            line_count,
        }
    }

    pub fn line_count(&self) -> usize {
        self.line_count
    }

    /// 第 `no` 行(0-based)的起始字节偏移
    fn line_start(&self, data: &[u8], no: usize) -> Option<usize> {
        if no >= self.line_count {
            return None;
        }
        let cp = no / CHECKPOINT_INTERVAL;
        let mut offset = self.checkpoints[cp] as usize;
        for _ in cp * CHECKPOINT_INTERVAL..no {
            // 目标行存在 ⇒ 它之前的每一行都以 \n 结尾,块内必然找得到
            offset += memchr(b'\n', &data[offset..])? + 1;
        }
        Some(offset)
    }

    /// 取一行(0-based),不含换行符;剥离 CRLF 的 `\r`。
    pub fn line<'a>(&self, data: &'a [u8], no: usize) -> Option<&'a [u8]> {
        let start = self.line_start(data, no)?;
        let end = memchr(b'\n', &data[start..]).map_or(data.len(), |p| start + p);
        let mut s = &data[start..end];
        if s.last() == Some(&b'\r') {
            s = &s[..s.len() - 1];
        }
        Some(s)
    }

    /// 从 `no` 行开始顺序迭代 (行号, 行内容)。
    ///
    /// 复用上一行结束位置,每行只需一次 memchr;逐行 [`line`](Self::line)
    /// 每次都要从检查点重扫块内换行符,顺序扫描时慢数百倍,不要用于全量扫描。
    pub fn lines_from<'a>(&'a self, data: &'a [u8], no: usize) -> LinesFrom<'a> {
        LinesFrom {
            index: self,
            data,
            next: no,
            offset: 0,
        }
    }
}

/// 顺序行迭代器(见 [`LineIndex::lines_from`])。
pub struct LinesFrom<'a> {
    index: &'a LineIndex,
    data: &'a [u8],
    next: usize,
    offset: usize,
}

impl<'a> Iterator for LinesFrom<'a> {
    type Item = (usize, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        let no = self.next;
        if no >= self.index.line_count {
            return None;
        }
        // 起始位置未知(offset=0)时经检查点定位一次,之后顺序推进
        let start = if self.offset == 0 {
            self.index.line_start(self.data, no)?
        } else {
            self.offset
        };
        let end = memchr(b'\n', &self.data[start..]).map_or(self.data.len(), |p| start + p);
        let mut s = &self.data[start..end];
        if s.last() == Some(&b'\r') {
            s = &s[..s.len() - 1];
        }
        self.next = no + 1;
        self.offset = if end < self.data.len() { end + 1 } else { end };
        Some((no, s))
    }
}
