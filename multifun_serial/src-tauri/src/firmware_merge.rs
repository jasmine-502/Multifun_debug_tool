//! ESP-IDF 固件合并：把 build 目录里的多个 bin 按偏移地址拼成一整片，
//! 用于从 0x0 一次烧录。
//!
//! 行为对齐 `debug_tool/tool/release_output_binV2.py` + `app/firmware_merge_tab.py`：
//! - 优先读 `build/flasher_args.json` 的 `flash_files`（key 恒为十六进制偏移）；
//! - 读不到就按 ESP-IDF 常见文件名回退猜测偏移；
//! - 版本号 / 项目名从项目根目录的 `CMakeLists.txt` 解析；
//! - 合并时先建全零缓冲，后面的条目可以覆盖前面的（与旧版逐字节 copy 一致）。
//!
//! 与旧版的有意差异：用户直接选中 `build` 目录时，CMakeLists.txt 改从上级目录找；
//! 另外对合并后的大小设了上限，避免手填 `0xFFFFFFFF` 把内存吃光。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// 合并结果的内存上限，超过就拒绝，避免一个手误直接把进程打死
const MAX_MERGED_BYTES: u64 = 512 * 1024 * 1024;

/// 没有 flasher_args.json 时的回退清单：(相对 build 的路径, 偏移)
const FALLBACK_FILES: &[(&str, u32)] = &[
    ("bootloader/bootloader.bin", 0x0000),
    ("bootloader.bin", 0x0000),
    ("partition_table/partition-table.bin", 0x8000),
    ("partitions.bin", 0x8000),
    ("firmware.bin", 0x10000),
    ("minimax.bin", 0x200000),
    ("generated_assets.bin", 0xA00000),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FwEntry {
    /// 形如 `0x10000`；扫描到的额外 bin 没有偏移，这里给空串等用户填
    pub offset: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    /// flasher = 来自 flasher_args.json；fallback = 按文件名猜的；extra = build 里多出来的
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanLog {
    pub text: String,
    /// info | warn | error | ok
    pub level: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub build_dir: String,
    pub chip: String,
    pub flash_size: String,
    pub flash_freq: String,
    pub version: Option<String>,
    pub project_name: Option<String>,
    pub entries: Vec<FwEntry>,
    pub logs: Vec<ScanLog>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeEntry {
    /// 表格里的原文，形如 `0x10000` 或 `65536`；解析规则只在 [`parse_user_offset`] 里实现一份
    pub offset: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub output: String,
    pub size: u64,
    pub count: usize,
    /// 相邻条目交叠的提示（后写的覆盖先写的，与旧版一致）
    pub overlaps: Vec<String>,
}

struct ScanLogBuilder(Vec<ScanLog>);

impl ScanLogBuilder {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn info(&mut self, text: impl Into<String>) {
        self.0.push(ScanLog { text: text.into(), level: "info".into() });
    }

    fn warn(&mut self, text: impl Into<String>) {
        self.0.push(ScanLog { text: text.into(), level: "warn".into() });
    }

    fn finish(self) -> Vec<ScanLog> {
        self.0
    }
}

/* ---------------- 偏移解析 ---------------- */

/// 用户手填的偏移：带 `0x` 按十六进制，否则按十进制 —— 与 PySide6 版一致，
/// 所以 `10000` 表示一万而不是 0x10000。前端只传原文，解析只在这里做一次。
fn parse_user_offset(text: &str) -> Option<u32> {
    let trimmed = text.trim().replace('_', "");
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        Some(hex) => u32::from_str_radix(hex, 16).ok(),
        None => trimmed.parse::<u32>().ok(),
    }
}

/// flasher_args.json 的 key 恒为十六进制（旧版直接 `int(key, 16)`），
/// 有的 IDF 版本会带 `0x`，有的不带。
fn parse_hex_offset(text: &str) -> Option<u32> {
    let trimmed = text.trim();
    let digits = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    u32::from_str_radix(digits, 16).ok()
}

/* ---------------- CMakeLists 解析 ---------------- */

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// 收集所有 `name(...)` 调用的参数（已按空白/逗号切分并去掉引号）。
/// 不用正则库：CMakeLists 里要处理的只有 `set(PROJECT_VER ...)` 和 `project(...)` 两种形态。
fn call_args(content: &str, name: &str) -> Vec<Vec<String>> {
    let bytes = content.as_bytes();
    let mut result = Vec::new();
    let mut from = 0usize;
    while let Some(found) = content[from..].find(name) {
        let start = from + found;
        from = start + name.len();
        // 关键字前面不能是标识符字符，否则 `my_project(...)` 会被当成 project()
        if start > 0 && is_ident_byte(bytes[start - 1]) {
            continue;
        }
        let Some(inner) = content[from..].trim_start().strip_prefix('(') else {
            continue;
        };
        // CMakeLists 的 set()/project() 里基本不会嵌括号，取第一个 `)` 就够
        let Some(close) = inner.find(')') else {
            continue;
        };
        result.push(split_args(&inner[..close]));
    }
    result
}

fn split_args(inner: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in inner.chars() {
        match quote {
            Some(end) if ch == end => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() || ch == ',' => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// `set(VAR value)` 里的 value
fn cmake_set_value(content: &str, var: &str) -> Option<String> {
    call_args(content, "set").into_iter().find_map(|args| {
        if args.first().map(String::as_str) == Some(var) {
            args.get(1).cloned()
        } else {
            None
        }
    })
}

/// `project(name)` 里的 name
fn cmake_project_name(content: &str) -> Option<String> {
    call_args(content, "project")
        .into_iter()
        .find_map(|args| args.into_iter().next())
}

/* ---------------- flasher_args.json ---------------- */

struct FlasherData {
    files: Vec<(u32, String)>,
    chip: String,
    flash_size: String,
    flash_freq: String,
}

/// 返回 Ok(None) 表示文件不存在（走回退扫描），Err 表示存在但解析不了。
fn read_flasher_args(build_dir: &Path) -> Result<Option<FlasherData>, String> {
    let path = build_dir.join("flasher_args.json");
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|err| format!("读取失败: {err}"))?;
    let json: Value = serde_json::from_str(&text).map_err(|err| format!("JSON 格式错误: {err}"))?;

    let mut files = Vec::new();
    if let Some(map) = json.get("flash_files").and_then(Value::as_object) {
        for (key, value) in map {
            if let (Some(offset), Some(rel)) = (parse_hex_offset(key), value.as_str()) {
                // json 里的路径相对 build 目录，统一成当前平台分隔符
                files.push((offset, rel.replace('/', std::path::MAIN_SEPARATOR_STR)));
            }
        }
    }
    files.sort_by_key(|(offset, _)| *offset);

    let text_of = |head: Option<&Value>, key: &str| -> String {
        head.and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .unwrap_or("未知")
            .to_string()
    };

    Ok(Some(FlasherData {
        files,
        chip: text_of(json.get("extra_esptool_args"), "chip"),
        flash_size: text_of(json.get("flash_settings"), "flash_size"),
        flash_freq: text_of(json.get("flash_settings"), "flash_freq"),
    }))
}

/* ---------------- 扫描 ---------------- */

fn resolve_build_dir(root: &Path) -> Option<PathBuf> {
    let itself_is_build = root
        .file_name()
        .map(|name| name.eq_ignore_ascii_case("build"))
        .unwrap_or(false);
    if itself_is_build && root.is_dir() {
        return Some(root.to_path_buf());
    }
    let candidate = root.join("build");
    candidate.is_dir().then_some(candidate)
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn make_entry(offset: Option<u32>, path: &Path, build_dir: &Path) -> FwEntry {
    let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    FwEntry {
        offset: offset.map(|value| format!("0x{value:X}")).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        name: path
            .strip_prefix(build_dir)
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_name_of(path)),
        size,
        source: String::new(),
    }
}

pub fn scan(root: &str) -> Result<ScanResult, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("请先选择项目根目录".into());
    }
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err(format!("目录不存在: {root}"));
    }
    let build_dir = resolve_build_dir(&root_path)
        .ok_or_else(|| format!("未找到 build 目录（已查找: {}）", root_path.join("build").display()))?;

    // 允许用户直接选 build 目录：此时 CMakeLists.txt 在上一级
    let project_root = if build_dir == root_path {
        root_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root_path.clone())
    } else {
        root_path.clone()
    };

    let mut logs = ScanLogBuilder::new();
    logs.info(format!("开始扫描: {}", build_dir.display()));

    let cmake = fs::read_to_string(project_root.join("CMakeLists.txt")).unwrap_or_default();
    let version = cmake_set_value(&cmake, "PROJECT_VER");
    let project_name = cmake_project_name(&cmake);
    if let Some(value) = &version {
        logs.info(format!("已读取版本号: V{value}"));
    }
    if let Some(value) = &project_name {
        logs.info(format!("已读取项目名称: {value}"));
    }

    let mut entries: Vec<FwEntry> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut chip = "未知".to_string();
    let mut flash_size = "未知".to_string();
    let mut flash_freq = "未知".to_string();

    let flasher = match read_flasher_args(&build_dir) {
        Ok(value) => value,
        Err(err) => {
            logs.warn(format!("解析 flasher_args.json 失败: {err}，将回退到默认扫描方式"));
            None
        }
    };

    match flasher {
        Some(data) => {
            logs.info(format!(
                "发现配置文件: {}",
                build_dir.join("flasher_args.json").display()
            ));
            chip = data.chip;
            flash_size = data.flash_size;
            flash_freq = data.flash_freq;
            logs.info(format!("解析到芯片信息: {chip}, Flash: {flash_size}, 频率: {flash_freq}"));

            for (offset, rel) in data.files {
                let full = build_dir.join(&rel);
                if full.is_file() {
                    let mut entry = make_entry(Some(offset), &full, &build_dir);
                    entry.source = "flasher".into();
                    logs.info(format!(
                        "找到: {} (偏移: 0x{offset:X})",
                        file_name_of(&full)
                    ));
                    seen.push(path_key(&full));
                    entries.push(entry);
                } else {
                    logs.warn(format!("警告: 配置文件中提到的文件不存在: {}", full.display()));
                }
            }

            // build 根目录下没被 json 覆盖的 bin，偏移留给用户填
            for extra in list_build_bins(&build_dir, &seen) {
                let mut entry = make_entry(None, &extra, &build_dir);
                entry.source = "extra".into();
                logs.warn(format!(
                    "找到额外文件: {} (未指定偏移地址，需手动填写偏移才会参与合并)",
                    file_name_of(&extra)
                ));
                seen.push(path_key(&extra));
                entries.push(entry);
            }

            logs.info(format!("扫描完成，共添加 {} 个文件。", entries.len()));
        }
        None => {
            logs.info("未找到 flasher_args.json，使用默认特征文件扫描...");
            for (rel, offset) in FALLBACK_FILES {
                let full = build_dir.join(rel);
                if !full.is_file() || seen.contains(&path_key(&full)) {
                    continue;
                }
                let mut entry = make_entry(Some(*offset), &full, &build_dir);
                entry.source = "fallback".into();
                logs.info(format!("找到: {} (偏移: 0x{offset:X})", file_name_of(&full)));
                seen.push(path_key(&full));
                entries.push(entry);
            }
            if entries.is_empty() {
                logs.warn("未在 build 目录下找到常见的预设 bin 文件，您可以手动添加。");
            } else {
                logs.info(format!("扫描完成，找到 {} 个文件。", entries.len()));
            }
        }
    }

    Ok(ScanResult {
        build_dir: build_dir.to_string_lossy().into_owned(),
        chip,
        flash_size,
        flash_freq,
        version,
        project_name,
        entries,
        logs: logs.finish(),
    })
}

fn list_build_bins(build_dir: &Path, seen: &[String]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(read_dir) = fs::read_dir(build_dir) else {
        return found;
    };
    for item in read_dir.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let is_bin = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("bin"))
            .unwrap_or(false);
        if is_bin && !seen.contains(&path_key(&path)) {
            found.push(path);
        }
    }
    found.sort();
    found
}

/* ---------------- 合并 ---------------- */

pub fn merge(
    entries: &[MergeEntry],
    root: &str,
    output_dir: &str,
    filename: &str,
) -> Result<MergeResult, String> {
    if entries.is_empty() {
        return Err("没有有效的合并项".into());
    }
    let filename = filename.trim();
    if filename.is_empty() {
        return Err("输出文件名为空".into());
    }
    if filename.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("输出文件名不能包含路径分隔符或非法字符".into());
    }

    let mut sorted: Vec<(u32, PathBuf)> = Vec::with_capacity(entries.len());
    for entry in entries {
        let offset = parse_user_offset(&entry.offset).ok_or_else(|| {
            format!(
                "偏移地址 \"{}\" 无效，须为 0x 开头的十六进制或十进制整数",
                entry.offset
            )
        })?;
        let path = PathBuf::from(&entry.path);
        if !path.is_file() {
            return Err(format!("文件不存在: {}", entry.path));
        }
        sorted.push((offset, path));
    }
    sorted.sort_by_key(|(offset, _)| *offset);

    let mut parts: Vec<(u32, PathBuf, Vec<u8>)> = Vec::with_capacity(sorted.len());
    let mut max_end: u64 = 0;
    for (offset, path) in sorted {
        let data = fs::read(&path).map_err(|err| format!("读取 {} 失败: {err}", path.display()))?;
        let end = u64::from(offset) + data.len() as u64;
        if end > MAX_MERGED_BYTES {
            return Err(format!(
                "合并后大小 {end} 字节超过上限 {} MB，请检查偏移地址",
                MAX_MERGED_BYTES / 1024 / 1024
            ));
        }
        max_end = max_end.max(end);
        parts.push((offset, path, data));
    }

    let mut buffer = vec![0u8; max_end as usize];
    let mut overlaps = Vec::new();
    let mut previous: Option<(u64, String)> = None;
    for (offset, path, data) in &parts {
        let start = u64::from(*offset);
        let end = start + data.len() as u64;
        if let Some((prev_end, prev_name)) = &previous {
            if start < *prev_end {
                overlaps.push(format!(
                    "{prev_name} 与 {} 在 0x{start:X} 处重叠，后者覆盖前者",
                    file_name_of(path)
                ));
            }
        }
        let begin = start as usize;
        buffer[begin..begin + data.len()].copy_from_slice(data);
        previous = Some((end, file_name_of(path)));
    }

    let dir = if !output_dir.trim().is_empty() {
        PathBuf::from(output_dir.trim())
    } else if !root.trim().is_empty() {
        PathBuf::from(root.trim())
    } else {
        std::env::current_dir().map_err(|err| format!("无法确定输出目录: {err}"))?
    };
    fs::create_dir_all(&dir).map_err(|err| format!("创建输出目录失败: {err}"))?;
    let output = dir.join(filename);
    fs::write(&output, &buffer).map_err(|err| format!("写入 {} 失败: {err}", output.display()))?;

    Ok(MergeResult {
        output: output.to_string_lossy().into_owned(),
        size: buffer.len() as u64,
        count: parts.len(),
        overlaps,
    })
}

/* ---------------- 单测 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "multifun-merge-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    fn write_file(dir: &Path, rel: &str, data: &[u8]) -> PathBuf {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("创建子目录失败");
        }
        fs::write(&path, data).expect("写文件失败");
        path
    }

    #[test]
    fn user_offset_prefers_0x_for_hex() {
        assert_eq!(parse_user_offset("0x10000"), Some(0x10000));
        assert_eq!(parse_user_offset(" 0X1000 "), Some(0x1000));
        assert_eq!(parse_user_offset("65536"), Some(65536));
        assert_eq!(parse_user_offset("0x_1_0000"), Some(0x10000));
        assert_eq!(parse_user_offset(""), None);
        assert_eq!(parse_user_offset("zz"), None);
    }

    #[test]
    fn flasher_offset_is_always_hex() {
        assert_eq!(parse_hex_offset("10000"), Some(0x10000));
        assert_eq!(parse_hex_offset("0x8000"), Some(0x8000));
        assert_eq!(parse_hex_offset("0"), Some(0));
    }

    #[test]
    fn cmake_version_and_project_name() {
        let cmake = "cmake_minimum_required(VERSION 3.16)\n\
                     set(PROJECT_VER \"1.4.2\")\n\
                     project(stamp_dev)\n";
        assert_eq!(cmake_set_value(cmake, "PROJECT_VER").as_deref(), Some("1.4.2"));
        assert_eq!(cmake_project_name(cmake).as_deref(), Some("stamp_dev"));
        assert_eq!(
            cmake_set_value("set( PROJECT_VER 2.0 )", "PROJECT_VER").as_deref(),
            Some("2.0")
        );
        assert_eq!(cmake_set_value("nothing here", "PROJECT_VER"), None);
        assert_eq!(cmake_project_name("nothing here"), None);
        // 前缀相同的标识符不能误判
        assert_eq!(cmake_project_name("my_project(foo)"), None);
    }

    #[test]
    fn merge_fills_gaps_with_zeros() {
        let dir = temp_dir("merge-gap");
        let a = write_file(&dir, "a.bin", &[1, 2, 3, 4]);
        let b = write_file(&dir, "b.bin", &[9, 9]);
        let entries = vec![
            MergeEntry { offset: "0x10".into(), path: b.to_string_lossy().into_owned() },
            MergeEntry { offset: "0x0".into(), path: a.to_string_lossy().into_owned() },
        ];
        let out_dir = dir.join("out");
        let result = merge(
            &entries,
            "",
            out_dir.to_str().unwrap(),
            "merged.bin",
        )
        .expect("合并应成功");

        assert_eq!(result.size, 0x12);
        assert_eq!(result.count, 2);
        assert!(result.overlaps.is_empty());

        let data = fs::read(out_dir.join("merged.bin")).expect("读取合并结果失败");
        assert_eq!(&data[0..4], &[1, 2, 3, 4]);
        assert_eq!(&data[4..0x10], &[0u8; 12]);
        assert_eq!(&data[0x10..], &[9, 9]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_reports_overlap_and_last_wins() {
        let dir = temp_dir("merge-overlap");
        let a = write_file(&dir, "a.bin", &[1, 1, 1, 1]);
        let c = write_file(&dir, "c.bin", &[7, 7]);
        let entries = vec![
            MergeEntry { offset: "0x0".into(), path: a.to_string_lossy().into_owned() },
            MergeEntry { offset: "0x2".into(), path: c.to_string_lossy().into_owned() },
        ];
        let result = merge(&entries, "", dir.to_str().unwrap(), "o.bin").expect("合并应成功");

        assert_eq!(result.overlaps.len(), 1);
        let data = fs::read(dir.join("o.bin")).expect("读取合并结果失败");
        assert_eq!(data, vec![1, 1, 7, 7]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 十进制写法真的按十进制走：`10000` 是一万，不是 0x10000
    #[test]
    fn merge_parses_bare_number_as_decimal() {
        let dir = temp_dir("merge-decimal");
        let a = write_file(&dir, "a.bin", &[5, 5]);
        let entries = vec![MergeEntry {
            offset: "10000".into(),
            path: a.to_string_lossy().into_owned(),
        }];
        let result = merge(&entries, "", dir.to_str().unwrap(), "dec.bin").expect("合并应成功");
        assert_eq!(result.size, 10002);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_rejects_path_in_filename() {
        let dir = temp_dir("merge-name");
        let a = write_file(&dir, "a.bin", &[1]);
        let entries = vec![MergeEntry {
            offset: "0x0".into(),
            path: a.to_string_lossy().into_owned(),
        }];
        assert!(merge(&entries, "", dir.to_str().unwrap(), "../x.bin").is_err());
        assert!(merge(&entries, "", dir.to_str().unwrap(), "").is_err());
        assert!(merge(&[], "", dir.to_str().unwrap(), "x.bin").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_reads_flasher_args_in_offset_order() {
        let dir = temp_dir("scan-flasher");
        fs::write(
            dir.join("CMakeLists.txt"),
            "set(PROJECT_VER \"2.1.0\")\nproject(foo_app)\n",
        )
        .expect("写 CMakeLists 失败");
        write_file(&dir, "build/bootloader/bootloader.bin", &[0xAA; 0x100]);
        write_file(&dir, "build/partition_table/partition-table.bin", &[0xBB; 0x40]);
        write_file(&dir, "build/fw.bin", &[0xCC; 0x80]);
        write_file(&dir, "build/extra.bin", &[0xDD; 0x10]);
        fs::write(
            dir.join("build/flasher_args.json"),
            r#"{
              "flash_settings": { "flash_size": "4MB", "flash_freq": "80m" },
              "extra_esptool_args": { "chip": "esp32" },
              "flash_files": {
                "0x10000": "fw.bin",
                "0x0": "bootloader/bootloader.bin",
                "0x8000": "partition_table/partition-table.bin"
              }
            }"#,
        )
        .expect("写 flasher_args.json 失败");

        let result = scan(dir.to_str().unwrap()).expect("扫描应成功");
        assert_eq!(result.chip, "esp32");
        assert_eq!(result.flash_size, "4MB");
        assert_eq!(result.flash_freq, "80m");
        assert_eq!(result.version.as_deref(), Some("2.1.0"));
        assert_eq!(result.project_name.as_deref(), Some("foo_app"));

        let offsets: Vec<&str> = result.entries.iter().map(|e| e.offset.as_str()).collect();
        assert_eq!(offsets, vec!["0x0", "0x8000", "0x10000", ""]);
        assert_eq!(result.entries[2].size, 0x80);
        assert_eq!(result.entries[3].name, "extra.bin");
        assert_eq!(result.entries[3].source, "extra");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_falls_back_to_known_names() {
        let dir = temp_dir("scan-fallback");
        write_file(&dir, "build/bootloader.bin", &[1; 8]);
        write_file(&dir, "build/partitions.bin", &[2; 8]);

        let result = scan(dir.to_str().unwrap()).expect("扫描应成功");
        let names: Vec<&str> = result.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["bootloader.bin", "partitions.bin"]);
        assert_eq!(result.entries[0].offset, "0x0");
        assert_eq!(result.entries[1].offset, "0x8000");
        assert_eq!(result.entries[0].source, "fallback");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_accepts_build_dir_and_reads_parent_cmake() {
        let dir = temp_dir("scan-build-dir");
        fs::write(dir.join("CMakeLists.txt"), "project(from_parent)\n").expect("写 CMakeLists 失败");
        write_file(&dir, "build/partitions.bin", &[2; 8]);

        let build = dir.join("build");
        let result = scan(build.to_str().unwrap()).expect("直接选 build 目录也应成功");
        assert_eq!(result.project_name.as_deref(), Some("from_parent"));
        assert_eq!(result.entries.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_rejects_missing_dir() {
        assert!(scan("").is_err());
        assert!(scan(concat!(env!("CARGO_MANIFEST_DIR"), "/不存在的目录")).is_err());
    }
}
