//! TCP / UDP 共用的字节编解码。
//!
//! 两个页面各有一排发送输入框，但「HEX 里怎么算一个字节」只能有一套规则：
//! 复制两份的话，迟早出现同样输入在 TCP 发得出去、在 UDP 却报错的情况。

/// 原始字节 → 大写十六进制，空格分隔
pub fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(bytes.len() * 3);
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        let _ = write!(out, "{byte:02X}");
    }
    out
}

/// 把输入框内容还原成字节。
///
/// HEX 模式等价于 Python 的 `bytes.fromhex`：忽略空白和逗号，
/// 奇数位和非法字符都要给中文提示——直接抛英文报错用户只会来问「为什么发不出去」。
pub fn parse_send_payload(text: &str, hex: bool) -> Result<Vec<u8>, String> {
    if !hex {
        return Ok(text.as_bytes().to_vec());
    }

    let mut bytes = Vec::with_capacity(text.len() / 2);
    let mut high: Option<u8> = None;
    for ch in text.chars() {
        if ch.is_whitespace() || ch == ',' {
            continue;
        }
        let value = ch
            .to_digit(16)
            .ok_or_else(|| format!("HEX 数据包含非法字符: {ch}"))? as u8;
        match high.take() {
            None => high = Some(value),
            Some(high_nibble) => bytes.push((high_nibble << 4) | value),
        }
    }
    if high.is_some() {
        return Err("HEX 数据长度不是偶数（每字节需要两位十六进制）".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_payload_is_utf8_bytes() {
        // 中文按 UTF-8 编码，和 Qt 版 `s.encode('utf-8')` 一致
        assert_eq!(parse_send_payload("温度", false).unwrap(), "温度".as_bytes());
    }

    #[test]
    fn hex_payload_ignores_separators() {
        assert_eq!(
            parse_send_payload("AA bb,0D\n0A", true).unwrap(),
            vec![0xAA, 0xBB, 0x0D, 0x0A]
        );
        assert!(parse_send_payload("  ", true).unwrap().is_empty());
    }

    #[test]
    fn hex_payload_rejects_bad_input() {
        assert!(parse_send_payload("ABC", true).is_err());
        assert!(parse_send_payload("GG", true).is_err());
    }

    #[test]
    fn hex_of_uses_uppercase_with_spaces() {
        assert_eq!(hex_of(&[0x00, 0x1A, 0xFF]), "00 1A FF");
        assert_eq!(hex_of(&[]), "");
    }
}
