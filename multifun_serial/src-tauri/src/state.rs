use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::JoinHandle;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// 过滤条件：级别开关 + 日志名称白名单（逗号分隔，精确匹配，与 Qt 版一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Filters {
    pub levels: HashMap<String, bool>,
    pub tags: String,
    /// 通用串口模式：行内没有 ESP-IDF 的级别/日志名，`tags` 降级为关键字包含过滤
    #[serde(default)]
    pub generic: bool,
}

impl Default for Filters {
    fn default() -> Self {
        let mut levels = HashMap::new();
        for level in ["Error", "Warning", "Info", "Debug", "Verbose"] {
            levels.insert(level.to_string(), true);
        }
        Self {
            levels,
            tags: String::new(),
            generic: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters(generic: bool, tags: &str) -> Filters {
        Filters {
            levels: HashMap::new(),
            tags: tags.to_string(),
            generic,
        }
    }

    #[test]
    fn generic_mode_matches_keyword_anywhere() {
        let guard = filters(true, "error");
        assert!(guard.line_allowed("prefix ERROR suffix", None, "None"));
        assert!(guard.line_allowed("Error: something broke", None, "None"));
        assert!(!guard.line_allowed("all good", None, "None"));
        // 只匹配子串，不做前缀/整行匹配
        assert!(!guard.line_allowed("ERR: something broke", None, "None"));
    }

    #[test]
    fn esp_mode_still_filters_by_tag() {
        let guard = filters(false, "wifi");
        assert!(guard.line_allowed("I (1) wifi: ok", Some("wifi"), "Info"));
        assert!(!guard.line_allowed("I (1) audio: ok", Some("audio"), "Info"));
        // 没有日志名的行不能被白名单吃掉
        assert!(guard.line_allowed("ets Jun  8 2016 00:22:57", None, "None"));
    }

    #[test]
    fn empty_keyword_list_passes_everything() {
        let guard = filters(true, "  ");
        assert!(guard.line_allowed("anything", None, "None"));
    }
}

impl Filters {
    pub fn level_enabled(&self, level: &str) -> bool {
        *self.levels.get(level).unwrap_or(&true)
    }

    pub fn tag_allowed(&self, tag: Option<&str>) -> bool {
        let raw = self.tags.trim();
        if raw.is_empty() {
            return true;
        }
        match tag {
            // 没有日志名的行（例如裸打印）一律放行，避免过滤把关键输出吃掉
            None => true,
            Some(name) => raw.split(',').map(str::trim).any(|item| item == name),
        }
    }

    /// 通用串口下没有级别/日志名可比，`tags` 改成“行内包含任一关键字”的语义。
    /// `raw` 是整个切包内容，`None` 级别的行同样要受这个关键字约束，
    /// 否则填写过滤条件对普通设备完全无效。
    ///
    /// 比较时不区分 ASCII 大小写：普通设备的输出格式完全不受控，
    /// 用户填 `error` 却匹不到 `ERROR` 只会反复踩空。
    pub fn keyword_allowed(&self, raw: &str) -> bool {
        let raw_tags = self.tags.trim();
        if raw_tags.is_empty() {
            return true;
        }
        // 绝大多数行没有大写字母，只有出现大写时才付一次转小写的分配
        let lowered;
        let haystack = if raw.bytes().any(|byte| byte.is_ascii_uppercase()) {
            lowered = raw.to_ascii_lowercase();
            lowered.as_str()
        } else {
            raw
        };
        raw_tags
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .any(|item| haystack.contains(&item.to_ascii_lowercase()))
    }

    /// 单行的完整过滤判定（两种模式共用同一个入口，避免两边规则漂移）
    pub fn line_allowed(&self, raw: &str, tag: Option<&str>, level: &str) -> bool {
        if !self.level_enabled(level) {
            return false;
        }
        if self.generic {
            return self.keyword_allowed(raw);
        }
        self.tag_allowed(tag)
    }
}

/// 自动保存控制：由读线程轮询，避免每行日志都跨线程加锁写文件
#[derive(Debug, Clone, Default)]
pub struct AutosaveControl {
    pub enabled: bool,
    pub dir: Option<PathBuf>,
    /// 落盘格式跟随界面显示：HEX 视图下继续写原始字节，
    /// 用户用记事本打开 `.txt` 只会看到一大片乱码
    pub hex: bool,
    /// 每行前面加 `HH:MM:SS.mmm `
    pub timestamp: bool,
}

pub struct Session {
    pub stop: Arc<AtomicBool>,
    pub handle: JoinHandle<()>,
}

pub struct AppState {
    pub session: Mutex<Option<Session>>,
    pub filters: Arc<Mutex<Filters>>,
    pub autosave: Arc<Mutex<AutosaveControl>>,
    pub blacklist: Arc<Mutex<Vec<String>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            filters: Arc::new(Mutex::new(Filters::default())),
            autosave: Arc::new(Mutex::new(AutosaveControl::default())),
            blacklist: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
