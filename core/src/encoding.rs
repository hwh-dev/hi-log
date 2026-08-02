//! 文本编码:采样文件头检测 + 按编码解码。
//!
//! 日志场景 UTF-8 / GBK 覆盖 99%+;UTF-16 仅通过 BOM 识别。
//! GBK 双字节尾字节 >= 0x40,不含 0x0A,行分割(按 0x0A)始终安全。

use std::borrow::Cow;

/// 采样检测窗口
const SAMPLE_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Gbk,
    Utf16Le,
    Utf16Be,
}

impl Encoding {
    /// 展示名
    pub fn name(&self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Gbk => "GBK",
            Encoding::Utf16Le => "UTF-16LE",
            Encoding::Utf16Be => "UTF-16BE",
        }
    }

    /// 采样文件头检测:UTF-8/UTF-16 BOM → 严格 UTF-8 校验 → GBK 兜底。
    pub fn detect(data: &[u8]) -> Encoding {
        let sample = &data[..data.len().min(SAMPLE_LEN)];
        if sample.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Encoding::Utf8;
        }
        if sample.starts_with(&[0xFF, 0xFE]) {
            return Encoding::Utf16Le;
        }
        if sample.starts_with(&[0xFE, 0xFF]) {
            return Encoding::Utf16Be;
        }
        if std::str::from_utf8(sample).is_ok() {
            Encoding::Utf8
        } else {
            // GBK 几乎能解任何字节序列,作为无 BOM 非 UTF-8 的兜底
            Encoding::Gbk
        }
    }

    /// 按编码解码(UTF-8 走 lossy,与旧行为一致)
    pub fn decode<'a>(&self, bytes: &'a [u8]) -> Cow<'a, str> {
        match self {
            Encoding::Utf8 => String::from_utf8_lossy(bytes),
            Encoding::Gbk => encoding_rs::GBK.decode(bytes).0,
            Encoding::Utf16Le => encoding_rs::UTF_16LE.decode(bytes).0,
            Encoding::Utf16Be => encoding_rs::UTF_16BE.decode(bytes).0,
        }
    }

    /// 剥离首行 BOM 前缀(UTF-8 3 字节 / UTF-16 2 字节)
    pub fn strip_bom<'a>(&self, bytes: &'a [u8]) -> &'a [u8] {
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            &bytes[3..]
        } else if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
            &bytes[2..]
        } else {
            bytes
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8_plain() {
        assert_eq!(Encoding::detect(b"hello \xe4\xb8\xad\xe6\x96\x87"), Encoding::Utf8);
    }

    #[test]
    fn detects_utf8_bom() {
        assert_eq!(Encoding::detect(b"\xef\xbb\xbfhello"), Encoding::Utf8);
    }

    #[test]
    fn detects_gbk_fallback() {
        // "中文" 的 GBK 编码非法 UTF-8
        assert_eq!(Encoding::detect(b"\xd6\xd0\xce\xc4"), Encoding::Gbk);
    }

    #[test]
    fn detects_utf16_bom() {
        assert_eq!(Encoding::detect(b"\xff\xfe\x00a"), Encoding::Utf16Le);
        assert_eq!(Encoding::detect(b"\xfe\xffa\x00"), Encoding::Utf16Be);
    }

    #[test]
    fn decodes_gbk() {
        assert_eq!(Encoding::Gbk.decode(b"\xd6\xd0\xce\xc4"), "中文");
    }

    #[test]
    fn strips_boms() {
        assert_eq!(Encoding::Utf8.strip_bom(b"\xef\xbb\xbfabc"), b"abc");
        assert_eq!(Encoding::Utf16Le.strip_bom(b"\xff\xfe\x00a"), b"\x00a");
        assert_eq!(Encoding::Gbk.strip_bom(b"abc"), b"abc");
    }
}
