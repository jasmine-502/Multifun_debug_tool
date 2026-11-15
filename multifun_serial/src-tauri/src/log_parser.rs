use std::fmt;

/// ESP-IDF 日志级别。Unknown 对应"没有级别前缀"的普通输出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Error,
    Warning,
    Info,
    Debug,
    Verbose,
    Unknown,
}

impl Level {
    pub fn as_str(&self) -> &'static str {
        match self {
            Level::Error => "Error",
            Level::Warning => "Warning",
            Level::Info => "Info",
            Level::Debug => "Debug",
            Level::Verbose => "Verbose",
            Level::Unknown => "None",
        }
    }
}

impl fmt::Display for Level {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 去掉 `[11:43:00.872] ` 这类时间戳前缀，返回用于判级别的部分
fn strip_timestamp(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix('[') {
        if let Some(index) = rest.find("] ") {
            return &rest[index + 2..];
        }
    }
    text
}

/// 级别判定完全沿用 `esp32_log_tab.py` 的前缀规则，保证两版过滤结果一致
pub fn level_of(text: &str) -> Level {
    let body = strip_timestamp(text);
    if body.starts_with("E (") {
        Level::Error
    } else if body.starts_with("W (") {
        Level::Warning
    } else if body.starts_with("I (") {
        Level::Info
    } else if body.starts_with("D (") {
        Level::Debug
    } else if body.starts_with("V (") {
        Level::Verbose
    } else {
        Level::Unknown
    }
}

/// 日志名：`) ` 与之后第一个 `: ` 之间的内容
pub fn tag_of(text: &str) -> Option<String> {
    let start = text.find(") ")? + 2;
    let rest = &text[start..];
    let end = rest.find(": ")?;
    let tag = rest[..end].trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

pub fn parse(text: &str) -> (Level, Option<String>) {
    (level_of(text), tag_of(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_idf_line() {
        let (level, tag) = parse("I (3126) EmojiConfig: state -> RUN");
        assert_eq!(level, Level::Info);
        assert_eq!(tag.as_deref(), Some("EmojiConfig"));
    }

    #[test]
    fn parses_line_with_timestamp() {
        let (level, tag) = parse("[11:43:00.872] E (12) Backlight: pwm fail");
        assert_eq!(level, Level::Error);
        assert_eq!(tag.as_deref(), Some("Backlight"));
    }

    #[test]
    fn unknown_prefix_stays_unknown() {
        let (level, tag) = parse("ets Jun  8 2016 00:22:57");
        assert_eq!(level, Level::Unknown);
        assert!(tag.is_none());
    }
}
