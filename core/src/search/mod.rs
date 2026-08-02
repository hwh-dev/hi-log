//! 流式检索引擎:顺序扫描 + 正则/子串匹配,支持取消与进度回调。
//!
//! 不做倒排索引:日志是追加型数据,顺序扫 mmap(SSD 约 3-5s/10GB)并流式
//! 推送结果即可满足交互。命中结果按行号保存在调用方,二次查看零成本。

use std::sync::atomic::{AtomicBool, Ordering};

use regex::bytes::Regex;

use crate::document::Document;

#[derive(Debug, Clone, Copy)]
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    /// 命中上限,达到即中止并标记 truncated(防御性上限,防千万级命中撑爆内存)
    pub max_hits: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            regex: false,
            case_sensitive: false,
            max_hits: 1_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MatchRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct Hit {
    /// 0-based 行号
    pub line_no: usize,
    pub ranges: Vec<MatchRange>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SearchStats {
    pub scanned_lines: usize,
    pub total_lines: usize,
    pub hits: usize,
    pub cancelled: bool,
    pub truncated: bool,
}

/// 在调用方提供的线程上执行;`cancel` 置位后尽快停止。
pub fn search(
    doc: &Document,
    query: &str,
    opts: &SearchOptions,
    cancel: &AtomicBool,
    mut on_hit: impl FnMut(Hit),
    mut on_progress: impl FnMut(u64, u64),
) -> SearchStats {
    let total = doc.line_count();
    let mut stats = SearchStats {
        total_lines: total,
        ..Default::default()
    };

    if query.is_empty() {
        return stats;
    }

    // 正则优先:先编译,失败则退化为子串匹配
    let re = if opts.regex {
        let pattern = if opts.case_sensitive {
            query.to_owned()
        } else {
            format!("(?i){query}")
        };
        Regex::new(&pattern).ok()
    } else {
        None
    };
    let needle: Vec<u8> = if opts.case_sensitive {
        query.as_bytes().to_vec()
    } else {
        query.to_ascii_lowercase().into_bytes()
    };

    // 顺序扫描必须用 lines_from(每行 O(1));逐行 line(i) 会从检查点重扫,慢数百倍
    for (i, line) in doc.lines_from(0) {
        if cancel.load(Ordering::Relaxed) {
            stats.cancelled = true;
            break;
        }
        if stats.hits >= opts.max_hits {
            stats.truncated = true;
            break;
        }
        let ranges = match &re {
            Some(re) => re
                .find_iter(line)
                .map(|m| MatchRange {
                    start: m.start(),
                    end: m.end(),
                })
                .collect(),
            None => find_sub(line, &needle, opts.case_sensitive),
        };
        if !ranges.is_empty() {
            stats.hits += 1;
            on_hit(Hit {
                line_no: i,
                ranges,
            });
        }
        stats.scanned_lines = i + 1;
        if i % 4096 == 0 || i + 1 == total {
            on_progress(stats.scanned_lines as u64, total as u64);
        }
    }
    stats
}

/// 子串匹配(无分配):memchr SIMD 定位首字节,只在候选位置做完整比较。
///
/// 对每个可能的起始位置做完整比较是 O(n·m),百 MB 文件会慢到十几秒;
/// 用 memchr 跳过绝大多数无关位置后,常见命中率下接近线性。
/// case_sensitive=false 时 needle 已预转小写。
fn find_sub(hay: &[u8], needle: &[u8], case_sensitive: bool) -> Vec<MatchRange> {
    if needle.is_empty() || hay.len() < needle.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let nlen = needle.len();
    let mut from = 0;
    if case_sensitive {
        while from + nlen <= hay.len() {
            let Some(p) = memchr::memchr(needle[0], &hay[from..]) else { break };
            let p = from + p;
            if hay[p..].starts_with(needle) {
                out.push(MatchRange {
                    start: p,
                    end: p + nlen,
                });
                from = p + nlen;
            } else {
                from = p + 1;
            }
        }
    } else {
        // 候选首字节可能是小写或其大写形式(needle 已小写化)
        let first = needle[0];
        let first_upper = first.to_ascii_uppercase();
        while from + nlen <= hay.len() {
            let Some(p) = memchr::memchr2_iter(first, first_upper, &hay[from..]).next() else {
                break;
            };
            let p = from + p;
            if hay[p..].get(..nlen).map_or(false, |s| s.eq_ignore_ascii_case(needle)) {
                out.push(MatchRange {
                    start: p,
                    end: p + nlen,
                });
                from = p + nlen;
            } else {
                from = p + 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn doc_of(content: &str) -> (tempfile::NamedTempFile, Document) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        let doc = Document::open(f.path()).unwrap();
        (f, doc)
    }

    fn collect(doc: &Document, q: &str, opts: &SearchOptions) -> Vec<Hit> {
        let mut hits = Vec::new();
        search(doc, q, opts, &AtomicBool::new(false), |h| hits.push(h), |_, _| {});
        hits
    }

    #[test]
    fn plain_substring_with_ranges() {
        let (_f, doc) = doc_of("foo bar\nbar baz\nnothing\n");
        let hits = collect(&doc, "bar", &SearchOptions::default());
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line_no, 0);
        assert_eq!(hits[0].ranges[0], MatchRange { start: 4, end: 7 });
        assert_eq!(hits[1].line_no, 1);
    }

    #[test]
    fn case_insensitive_by_default() {
        let (_f, doc) = doc_of("Hello World\nhello\nHELLO\n");
        let hits = collect(&doc, "hello", &SearchOptions::default());
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn case_sensitive_mode() {
        let (_f, doc) = doc_of("Hello\nhello\n");
        let opts = SearchOptions {
            case_sensitive: true,
            ..Default::default()
        };
        let hits = collect(&doc, "Hello", &opts);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line_no, 0);
    }

    #[test]
    fn regex_mode() {
        let (_f, doc) = doc_of("err 100\nok\nERR 200\nerr 300\n");
        let opts = SearchOptions {
            regex: true,
            ..Default::default()
        };
        let hits = collect(&doc, r"err\s+\d+", &opts);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].line_no, 0);
        assert_eq!(hits[2].line_no, 3);
    }

    #[test]
    fn regex_case_sensitive_off_default() {
        let (_f, doc) = doc_of("ERROR 1\n");
        let opts = SearchOptions {
            regex: true,
            ..Default::default()
        };
        let hits = collect(&doc, r"^error", &opts);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn invalid_regex_falls_back_to_substring() {
        let (_f, doc) = doc_of("foo ( bar\nfoo\n");
        let opts = SearchOptions {
            regex: true,
            ..Default::default()
        };
        // "(" 编译失败 → 退化为子串匹配,仍应命中
        let hits = collect(&doc, "(", &opts);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn empty_query_yields_nothing() {
        let (_f, doc) = doc_of("foo\nbar\n");
        let stats = search(&doc, "", &SearchOptions::default(), &AtomicBool::new(false), |_| {}, |_, _| {});
        assert_eq!(stats.hits, 0);
    }

    #[test]
    fn cancellation_stops_early() {
        let mut content = String::new();
        for i in 0..100_000 {
            content.push_str(&format!("line {i}\n"));
        }
        let (_f, doc) = doc_of(&content);
        let cancel = AtomicBool::new(false);
        let mut hits = 0;
        let mut first = true;
        let stats = search(
            &doc,
            "line",
            &SearchOptions::default(),
            &cancel,
            |_| hits += 1,
            |_, _| {
                if first {
                    first = false;
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert!(stats.cancelled);
        assert!(stats.scanned_lines < 100_000);
        assert!(hits < 100_000);
    }

    #[test]
    fn max_hits_truncates() {
        let mut content = String::new();
        for _ in 0..10_000 {
            content.push_str("match\n");
        }
        let (_f, doc) = doc_of(&content);
        let opts = SearchOptions {
            max_hits: 100,
            ..Default::default()
        };
        let mut hits = 0;
        let stats = search(&doc, "match", &opts, &AtomicBool::new(false), |_| hits += 1, |_, _| {});
        assert!(stats.truncated);
        assert_eq!(hits, 100);
    }

    /// 性能回归:52MB 日志样式文件线性扫描必须接近实时
    /// (旧的 O(n·m) 实现此处需要几十秒,memchr 版应在秒级)
    #[test]
    fn substring_scan_is_linear() {
        let mut content = String::with_capacity(52 * 1024 * 1024);
        for i in 0..1_000_000 {
            content.push_str(&format!(
                "2026-08-01 10:00:0{}  INFO cache store hit: key={}\n",
                i % 10,
                i
            ));
        }
        let (_f, doc) = doc_of(&content);
        let t = std::time::Instant::now();
        let mut hits = 0;
        search(
            &doc,
            "cache",
            &SearchOptions::default(),
            &AtomicBool::new(false),
            |_| hits += 1,
            |_, _| {},
        );
        let secs = t.elapsed().as_secs_f64();
        println!("scanned 1M lines, {hits} hits, {secs:.2}s");
        assert!(hits > 0);
        assert!(secs < 15.0, "search took {secs:.2}s — linear scan regression?");
    }
}
