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
    /// 整词匹配:命中两侧必须是词边界(ASCII 定义,见 `is_word_byte`)
    pub whole_word: bool,
    /// 命中上限,达到即中止并标记 truncated(防御性上限,防千万级命中撑爆内存)
    pub max_hits: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            regex: false,
            case_sensitive: false,
            whole_word: false,
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

/// 编译后的匹配器。正则分支的整词包裹与子串分支的整词判定必须语义等价
/// (同一套 `is_word_byte`),否则"切一下 `.*` 开关结果就变"。
#[derive(Debug)]
enum Matcher {
    /// 空查询:永不命中(免去调用方特判)
    Never,
    Regex(Regex),
    Sub {
        needle: Vec<u8>,
        case_sensitive: bool,
        whole_word: bool,
    },
}

impl Matcher {
    fn find_ranges(&self, line: &[u8]) -> Vec<MatchRange> {
        match self {
            Matcher::Never => Vec::new(),
            Matcher::Regex(re) => re
                .find_iter(line)
                .map(|m| MatchRange {
                    start: m.start(),
                    end: m.end(),
                })
                .collect(),
            Matcher::Sub {
                needle,
                case_sensitive,
                whole_word,
            } => {
                let mut out = Vec::new();
                let mut from = 0;
                while let Some(p) = sub_find_at(line, needle, *case_sensitive, *whole_word, from) {
                    out.push(MatchRange {
                        start: p,
                        end: p + needle.len(),
                    });
                    from = p + needle.len();
                }
                out
            }
        }
    }

    /// 排除判定只要"有没有",不必收集区间
    fn is_match(&self, line: &[u8]) -> bool {
        match self {
            Matcher::Never => false,
            Matcher::Regex(re) => re.is_match(line),
            Matcher::Sub {
                needle,
                case_sensitive,
                whole_word,
            } => sub_find_at(line, needle, *case_sensitive, *whole_word, 0).is_some(),
        }
    }
}

/// 编译后的检索式:命中 `main` 且不命中 `exclude` 的行才算命中。
///
/// 编译与扫描分离,是为了让"正则非法"成为**编译期错误**而不是静默退化 ——
/// 老实现在 `Regex::new(..).ok()` 失败后按子串继续跑,用户以为在用正则,
/// 实际在搜字面量,据此得出的排查结论是错的。
#[derive(Debug)]
pub struct SearchQuery {
    main: Matcher,
    exclude: Option<Matcher>,
    max_hits: usize,
}

impl SearchQuery {
    /// `exclude` 为空串表示不排除:空正则会匹配每个位置,当正则用会把所有行都排掉。
    pub fn compile(query: &str, exclude: &str, opts: &SearchOptions) -> Result<SearchQuery, String> {
        let main = compile_matcher(query, "主查询", opts)?;
        let exclude = if exclude.is_empty() {
            None
        } else {
            Some(compile_matcher(exclude, "排除词", opts)?)
        };
        Ok(SearchQuery {
            main,
            exclude,
            max_hits: opts.max_hits,
        })
    }

    /// 空查询(没有任何可匹配内容)
    pub fn is_empty(&self) -> bool {
        matches!(self.main, Matcher::Never)
    }

    pub fn is_excluded(&self, line: &[u8]) -> bool {
        self.exclude.as_ref().map_or(false, |m| m.is_match(line))
    }

    pub fn find_ranges(&self, line: &[u8]) -> Vec<MatchRange> {
        self.main.find_ranges(line)
    }
}

fn compile_matcher(pat: &str, label: &str, opts: &SearchOptions) -> Result<Matcher, String> {
    if pat.is_empty() {
        return Ok(Matcher::Never);
    }
    if opts.regex {
        let pattern = regex_pattern(pat, opts);
        Regex::new(&pattern)
            .map(Matcher::Regex)
            .map_err(|e| format!("{label}正则非法:{}", flatten(&e.to_string())))
    } else {
        let needle = if opts.case_sensitive {
            pat.as_bytes().to_vec()
        } else {
            pat.to_ascii_lowercase().into_bytes()
        };
        Ok(Matcher::Sub {
            needle,
            case_sensitive: opts.case_sensitive,
            whole_word: opts.whole_word,
        })
    }
}

/// 整词用 **ASCII 半边界**:`regex` 的 `\b` 默认是 Unicode 词边界,CJK 全算词字符,
/// 于是 `\b(?:错误)\b` 在 `日志错误日志` 里永不命中,而且含中文的行会逐行走慢速引擎
/// (Unicode 词边界让 DFA 失效)。半边界只约束邻居一侧,正好等价于子串分支的判定。
fn regex_pattern(q: &str, opts: &SearchOptions) -> String {
    // 不用 format! 拼 pattern:用户正则里的花括号会被当成占位符
    let mut p = String::with_capacity(q.len() + 32);
    if !opts.case_sensitive {
        p.push_str("(?i)");
    }
    if opts.whole_word {
        p.push_str(r"(?-u:\b{start-half})(?:");
        p.push_str(q);
        p.push_str(r")(?-u:\b{end-half})");
    } else {
        p.push_str(q);
    }
    p
}

/// regex 的报错是多行(带 pattern 与 `^` 指示),状态栏是单行,压平
fn flatten(msg: &str) -> String {
    msg.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 在调用方提供的线程上执行;`cancel` 置位后尽快停止。
pub fn search(
    doc: &Document,
    q: &SearchQuery,
    cancel: &AtomicBool,
    mut on_hit: impl FnMut(Hit),
    mut on_progress: impl FnMut(u64, u64),
) -> SearchStats {
    let total = doc.line_count();
    let mut stats = SearchStats {
        total_lines: total,
        ..Default::default()
    };

    if q.is_empty() {
        return stats;
    }

    // 顺序扫描必须用 lines_from(每行 O(1));逐行 line(i) 会从检查点重扫,慢数百倍
    for (i, line) in doc.lines_from(0) {
        if cancel.load(Ordering::Relaxed) {
            stats.cancelled = true;
            break;
        }
        // 上限计"排除之后"的命中数,否则 search_done 的权威计数会比实际下发的行数多
        if stats.hits >= q.max_hits {
            stats.truncated = true;
            break;
        }
        if !q.is_excluded(line) {
            let ranges = q.find_ranges(line);
            if !ranges.is_empty() {
                stats.hits += 1;
                on_hit(Hit {
                    line_no: i,
                    ranges,
                });
            }
        }
        // 被排除的行也要走到这里:否则进度停住、scanned_lines 与实际不符
        stats.scanned_lines = i + 1;
        if i % 4096 == 0 || i + 1 == total {
            on_progress(stats.scanned_lines as u64, total as u64);
        }
    }
    stats
}

/// ASCII 词字符,与正则分支的 `(?-u:\b{start-half})` 是同一套定义。
///
/// 刻意不用 Unicode 词边界:本应用要读 GBK 文件,而检索跑在 mmap 原始字节上,
/// 解码不可靠;且 Unicode 语义下 CJK 之间不存在边界,中文日志整词会全废。
/// 已知代价:needle `错误` 在 `错误500` 里不算整词(右邻 `5` 是词字符)。
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn boundary_ok(hay: &[u8], p: usize, nlen: usize, whole_word: bool) -> bool {
    if !whole_word {
        return true;
    }
    let left_ok = p == 0 || !is_word_byte(hay[p - 1]);
    let end = p + nlen;
    let right_ok = end == hay.len() || !is_word_byte(hay[end]);
    left_ok && right_ok
}

/// 从 `from` 起找下一个(可选整词)子串匹配的起始下标。
///
/// memchr SIMD 定位首字节,只在候选位置做完整比较:对每个起始位置都完整比较是
/// O(n·m),百 MB 文件会慢到十几秒。case_sensitive=false 时 needle 已预转小写。
///
/// 候选被拒时游标只前进 1(不是 needle 长度):`a-a` 在 `xa-a-a` 里,位置 1 左邻
/// `x` 是词字符被拒,位置 3 才是合法整词命中 —— 跳 nlen 会漏掉它。
fn sub_find_at(
    hay: &[u8],
    needle: &[u8],
    case_sensitive: bool,
    whole_word: bool,
    mut from: usize,
) -> Option<usize> {
    let nlen = needle.len();
    if nlen == 0 || hay.len() < nlen {
        return None;
    }
    while from + nlen <= hay.len() {
        let p = if case_sensitive {
            from + memchr::memchr(needle[0], &hay[from..])?
        } else {
            // 候选首字节可能是小写或其大写形式(needle 已小写化)
            let first = needle[0];
            from + memchr::memchr2_iter(first, first.to_ascii_uppercase(), &hay[from..]).next()?
        };
        let hit = hay[p..].get(..nlen).map_or(false, |s| {
            if case_sensitive {
                s == needle
            } else {
                s.eq_ignore_ascii_case(needle)
            }
        });
        if hit && boundary_ok(hay, p, nlen, whole_word) {
            return Some(p);
        }
        from = p + 1;
    }
    None
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

    fn q_of(query: &str, opts: &SearchOptions) -> SearchQuery {
        SearchQuery::compile(query, "", opts).unwrap()
    }

    fn collect(doc: &Document, query: &str, opts: &SearchOptions) -> Vec<Hit> {
        let mut hits = Vec::new();
        search(doc, &q_of(query, opts), &AtomicBool::new(false), |h| hits.push(h), |_, _| {});
        hits
    }

    /// 带排除词的检索
    fn collect_ex(doc: &Document, query: &str, exclude: &str, opts: &SearchOptions) -> Vec<Hit> {
        let mut hits = Vec::new();
        let q = SearchQuery::compile(query, exclude, opts).unwrap();
        search(doc, &q, &AtomicBool::new(false), |h| hits.push(h), |_, _| {});
        hits
    }

    fn run(doc: &Document, query: &str, exclude: &str, opts: &SearchOptions) -> SearchStats {
        let q = SearchQuery::compile(query, exclude, opts).unwrap();
        search(doc, &q, &AtomicBool::new(false), |_| {}, |_, _| {})
    }

    fn hit_lines(hits: &[Hit]) -> Vec<usize> {
        hits.iter().map(|h| h.line_no).collect()
    }

    /// 整词 opts(正则/子串由 `regex` 决定)
    fn word_opts(regex: bool) -> SearchOptions {
        SearchOptions {
            regex,
            whole_word: true,
            ..Default::default()
        }
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
    fn invalid_regex_is_reported() {
        let opts = SearchOptions {
            regex: true,
            ..Default::default()
        };
        // 老实现把 "(" 的编译失败静默退化成子串匹配:用户以为在用正则,实际在搜字面量
        let err = SearchQuery::compile("(", "", &opts).unwrap_err();
        assert!(err.contains("主查询"), "报错要指明是哪个输入框: {err}");
        assert!(err.contains("正则非法"), "{err}");
        // 排除词非法要单独报,否则用户看着两个输入框不知道改哪个
        let err = SearchQuery::compile("ok", "(", &opts).unwrap_err();
        assert!(err.contains("排除词"), "{err}");
        // 合法正则不受影响
        assert!(SearchQuery::compile("(", "", &SearchOptions::default()).is_ok());
    }

    #[test]
    fn empty_query_yields_nothing() {
        let (_f, doc) = doc_of("foo\nbar\n");
        let stats = search(
            &doc,
            &q_of("", &SearchOptions::default()),
            &AtomicBool::new(false),
            |_| {},
            |_, _| {},
        );
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
            &q_of("line", &SearchOptions::default()),
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
        let stats = search(&doc, &q_of("match", &opts), &AtomicBool::new(false), |_| hits += 1, |_, _| {});
        assert!(stats.truncated);
        assert_eq!(hits, 100);
    }

    // ── 排除(NOT):行命中主查询 且 不命中排除词 ──

    #[test]
    fn empty_exclude_means_no_exclusion() {
        let (_f, doc) = doc_of("error a\nerror expected\nok\n");
        let opts = SearchOptions::default();
        // 前端默认会送 exclude:"";空正则匹配每个位置,若当正则用会把所有行都排掉
        assert_eq!(hit_lines(&collect_ex(&doc, "error", "", &opts)), vec![0, 1]);
        assert_eq!(hit_lines(&collect(&doc, "error", &opts)), vec![0, 1]);
    }

    #[test]
    fn exclude_drops_matching_lines_and_keeps_main_ranges() {
        let (_f, doc) = doc_of("foo bar baz\nfoo qux baz\n");
        let hits = collect_ex(&doc, "foo", "qux", &SearchOptions::default());
        assert_eq!(hit_lines(&hits), vec![0]);
        // 存活行的高亮区间必须来自主查询(foo),排除词不参与染色
        assert_eq!(hits[0].ranges, vec![MatchRange { start: 0, end: 3 }]);
    }

    #[test]
    fn exclude_follows_case_flag() {
        let (_f, doc) = doc_of("err AA\nerr aa\n");
        // 默认不区分大小写:aa 与 AA 都被排掉
        assert!(collect_ex(&doc, "err", "aa", &SearchOptions::default()).is_empty());
        let cs = SearchOptions {
            case_sensitive: true,
            ..Default::default()
        };
        assert_eq!(hit_lines(&collect_ex(&doc, "err", "aa", &cs)), vec![0]);
    }

    #[test]
    fn exclude_can_be_regex() {
        let (_f, doc) = doc_of("oom at 1234\noom at abcd\n");
        let opts = SearchOptions {
            regex: true,
            ..Default::default()
        };
        assert_eq!(hit_lines(&collect_ex(&doc, "oom", r"\d{4}", &opts)), vec![1]);
    }

    #[test]
    fn max_hits_counts_after_exclusion() {
        // 前 150 行被排除:上限若计在排除之前,会"截断"在一堆看不见的行上
        let mut content = String::new();
        for i in 0..300 {
            let noise = if i < 150 { " skip" } else { "" };
            content.push_str(&format!("hit{noise} {i}\n"));
        }
        let (_f, doc) = doc_of(&content);
        let opts = SearchOptions {
            max_hits: 10,
            ..Default::default()
        };
        let mut delivered = 0;
        let stats = search(
            &doc,
            &SearchQuery::compile("hit", "skip", &opts).unwrap(),
            &AtomicBool::new(false),
            |_| delivered += 1,
            |_, _| {},
        );
        assert!(stats.truncated);
        assert_eq!(stats.hits, 10);
        assert_eq!(delivered, 10, "下发的行数必须等于权威计数");
        assert!(stats.scanned_lines > 150, "排除不该消耗命中配额");
    }

    #[test]
    fn excluded_lines_still_advance_scan() {
        let mut content = String::new();
        for i in 0..5_000 {
            content.push_str(&format!("noise {i}\n"));
        }
        let (_f, doc) = doc_of(&content);
        let stats = run(&doc, "hit", "noise", &SearchOptions::default());
        assert_eq!(stats.hits, 0);
        // 排除走 continue 时若不更新 scanned_lines,进度条会停住、进度与实际不符
        assert_eq!(stats.scanned_lines, stats.total_lines);
    }

    // ── 整词:子串与正则两条分支必须语义等价 ──

    #[test]
    fn whole_word_substring_ascii() {
        let (_f, doc) = doc_of("err\nfoo err bar\nerror\nerrno\nerr_code\nxerr\n");
        assert_eq!(hit_lines(&collect(&doc, "err", &word_opts(false))), vec![0, 1]);
    }

    #[test]
    fn whole_word_keeps_overlapping_candidate() {
        // 位置 1 的 "a-a" 左邻 x 是词字符被拒,位置 3 才是合法命中。
        // 候选被拒时若跳 needle 长度(而非 +1),就会漏掉位置 3。
        let (_f, doc) = doc_of("xa-a-a\n");
        let sub = collect(&doc, "a-a", &word_opts(false));
        let re = collect(&doc, "a-a", &word_opts(true));
        assert_eq!(hit_lines(&sub), vec![0]);
        assert_eq!(sub[0].ranges, vec![MatchRange { start: 3, end: 6 }]);
        // 正则分支必须给出同样的答案(事后过滤式实现会在这里漏掉)
        assert_eq!(hit_lines(&re), vec![0]);
        assert_eq!(re[0].ranges, vec![MatchRange { start: 3, end: 6 }]);
    }

    #[test]
    fn whole_word_regex_keeps_non_word_tails() {
        // 用整 `\b` 包裹时,以非词字符收尾的 pattern 会永不命中
        let (_f, doc) = doc_of("err: 1\nfoo. 2\n-foo- 3\nxerr: 4\n");
        assert_eq!(hit_lines(&collect(&doc, "err:", &word_opts(true))), vec![0]);
        assert_eq!(hit_lines(&collect(&doc, r"foo\.", &word_opts(true))), vec![1]);
        assert_eq!(hit_lines(&collect(&doc, "-foo-", &word_opts(true))), vec![2]);
    }

    #[test]
    fn whole_word_regex_anchors_and_alt() {
        let (_f, doc) = doc_of("err\nxerr\nwarn here\nerr or warn\n-----\n");
        // 锚点:^err 只认行首,行内的 err 不算
        assert_eq!(hit_lines(&collect(&doc, "^err", &word_opts(true))), vec![0, 3]);
        // 交替:必须整组包裹,否则 err|warn 会脱靶成 \berr|warn\b
        assert_eq!(hit_lines(&collect(&doc, "err|warn", &word_opts(true))), vec![0, 2, 3]);
        // .* 不该因为包裹而漏掉纯标点行
        assert_eq!(
            hit_lines(&collect(&doc, ".*", &word_opts(true))),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn whole_word_utf8_adjacency() {
        let (_f, doc) = doc_of("错误error错误\nerror9\nerror_code\n错误日志\n错误500\n");
        // 邻居是 UTF-8 续字节(≥0x80)→ 非 ASCII 词字符 → 命中;
        // 无需解码,也不会切坏字符(合法 UTF-8 的针不可能以续字节开头)
        assert_eq!(hit_lines(&collect(&doc, "error", &word_opts(false))), vec![0]);
        // 取舍:整词按 ASCII 定义,`错误` 贴 ASCII 字母/数字时算词内。
        // 行 0 两侧都是 ASCII 字母、行 4 右邻是 '5' → 都不算整词;行 3 邻居是 CJK → 命中
        assert_eq!(hit_lines(&collect(&doc, "错误", &word_opts(false))), vec![3]);
        assert_eq!(hit_lines(&collect(&doc, "错误", &word_opts(true))), vec![3]);
    }

    /// 性能回归:整词用 `(?-u:...)` 半边界。若有人改回 Unicode 的 `\b`,
    /// 含中文的行会逐行回退到慢速引擎(DFA 不支持 Unicode 词边界)。
    #[test]
    fn whole_word_cjk_regex_scan_is_linear() {
        let mut content = String::with_capacity(12 * 1024 * 1024);
        for i in 0..200_000 {
            content.push_str(&format!("2026-08-01 10:00:00 信息 缓存命中 键={i} 错误 无\n"));
        }
        let (_f, doc) = doc_of(&content);
        let t = std::time::Instant::now();
        let mut hits = 0;
        search(
            &doc,
            &q_of("错误", &word_opts(true)),
            &AtomicBool::new(false),
            |_| hits += 1,
            |_, _| {},
        );
        let secs = t.elapsed().as_secs_f64();
        println!("cjk whole-word regex: {hits} hits, {secs:.2}s");
        assert!(hits > 0);
        assert!(secs < 10.0, "整词正则退化(Unicode 词边界会毁掉 DFA):{secs:.2}s");
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
            &q_of("cache", &SearchOptions::default()),
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
