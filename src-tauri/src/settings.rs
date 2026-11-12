// 用户设置：显示开关、排序方式等，存于 app_config_dir/settings.json
//
// 只存"下次启动还想保持"的东西：窗口几何、缩放位置这类随会话变化的状态不落盘。
// 读失败/字段缺失/内容损坏一律退化成默认值，绝不让设置把软件卡住。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::imgscan::SortMode;

/// 旋转方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RotateMode {
    /// 只旋转显示，绝不改写图片文件（默认）
    #[default]
    View,
    /// 直接把结果写回文件（JPEG 走无损变换）
    File,
}

/// 仅显示的旋转记录：按 路径 + 大小 + 修改时间 校验，文件一变（外部修改/替换）即失效
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RotationMark {
    pub path: String,
    /// 顺时针 90° 的次数（0..=3）
    pub quarter: u8,
    pub size: u64,
    /// 毫秒时间戳，与 ImageEntry.modified 一致
    pub mtime: u64,
}

/// 显示旋转记录的上限：超出后从最旧的开始丢
const ROTATION_MAX: usize = 1024;

/// 最近文件夹的上限
pub const RECENT_DIRS_MAX: usize = 8;

/// 滚轮行为
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WheelMode {
    /// 滚轮缩放（默认，Ctrl+滚轮也是缩放）
    #[default]
    Zoom,
    /// 滚轮翻页（Ctrl+滚轮缩放）
    Page,
}

/// 界面主题
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    /// 跟随系统（前端用 prefers-color-scheme 判断）
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// 打开图片即进入全屏灯箱（关掉则用普通窗口看图）
    pub lightbox: bool,
    /// 只看图片：隐藏标题栏（无边框窗口）
    pub frameless: bool,
    /// 胶片条默认显示
    pub filmstrip: bool,
    /// 信息浮层默认显示
    pub infobar: bool,
    /// 目录排序方式
    pub sort: SortMode,
    /// 界面主题（同时影响窗口标题栏）
    pub theme: Theme,
    /// 旋转方式：默认只改显示，不动文件
    pub rotate_mode: RotateMode,
    /// 仅显示模式的旋转记录（有序，越靠后越新）
    pub rotations: Vec<RotationMark>,
    /// 滚轮行为：缩放 / 翻页
    pub wheel: WheelMode,
    /// 启动时自动打开上次的文件夹
    pub restore_last_dir: bool,
    /// 最近打开过的文件夹（最新在前）
    pub recent_dirs: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            lightbox: true,
            frameless: false,
            filmstrip: true,
            infobar: true,
            sort: SortMode::Name,
            theme: Theme::Dark,
            rotate_mode: RotateMode::View,
            rotations: Vec::new(),
            wheel: WheelMode::Zoom,
            restore_last_dir: false,
            recent_dirs: Vec::new(),
        }
    }
}

impl Settings {
    /// 从 JSON 文本解析；缺失字段用默认值补齐，整体损坏则全部用默认值
    pub fn from_json(text: &str) -> Settings {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        // 结构简单，序列化不会失败；兜底给个空对象让下次重新走默认值
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_string())
    }
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> Settings {
    let Some(p) = settings_path(app) else {
        return Settings::default();
    };
    match fs::read_to_string(&p) {
        Ok(text) => Settings::from_json(&text),
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let Some(p) = settings_path(app) else {
        return Err("无法定位配置目录".into());
    };
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    // 原子写：先写同目录临时文件，再改名覆盖，避免写一半断电留下坏 JSON
    let mut trimmed = s.clone();
    prune_rotations(&mut trimmed.rotations);
    prune_recent(&mut trimmed.recent_dirs);
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, trimmed.to_json()).map_err(|e| format!("写设置失败: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("保存设置失败: {e}")
    })
}

/// 最近文件夹只留前 RECENT_DIRS_MAX 条（最新在前，不重排）
fn prune_recent(list: &mut Vec<String>) {
    list.truncate(RECENT_DIRS_MAX);
}

/// 只保留最近的若干条旋转记录，避免 settings.json 无限膨胀
fn prune_rotations(list: &mut Vec<RotationMark>) {
    if list.len() > ROTATION_MAX {
        let cut = list.len() - ROTATION_MAX;
        list.drain(..cut);
    }
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    load(&app)
}

#[tauri::command]
pub async fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    crate::imgscan::run_blocking(move || save(&app, &settings)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_lightbox_and_strip_on() {
        let d = Settings::default();
        assert!(d.lightbox);
        assert!(d.filmstrip);
        assert!(d.infobar);
        assert_eq!(d.sort, SortMode::Name);
    }

    #[test]
    fn roundtrip_keeps_all_fields() {
        let s = Settings {
            lightbox: false,
            frameless: true,
            filmstrip: false,
            infobar: false,
            sort: SortMode::Modified,
            theme: Theme::Light,
            rotate_mode: RotateMode::File,
            rotations: vec![RotationMark {
                path: "c:\\a.jpg".into(),
                quarter: 1,
                size: 123,
                mtime: 456,
            }],
            wheel: WheelMode::Page,
            restore_last_dir: true,
            recent_dirs: vec!["c:\\pics".into(), "d:\\img".into()],
        };
        assert_eq!(Settings::from_json(&s.to_json()), s);
    }

    #[test]
    fn missing_fields_fall_back_to_default() {
        let s = Settings::from_json(r#"{"filmstrip": false}"#);
        assert!(!s.filmstrip);
        assert!(s.lightbox, "缺失字段应取默认值");
        assert!(s.infobar);
        assert_eq!(s.sort, SortMode::Name);
        assert_eq!(s.theme, Theme::Dark);
        // 默认不改动文件、也不隐藏标题栏
        assert_eq!(s.rotate_mode, RotateMode::View);
        assert!(s.rotations.is_empty());
        assert!(!s.frameless);
        assert_eq!(s.wheel, WheelMode::Zoom);
        assert!(!s.restore_last_dir);
        assert!(s.recent_dirs.is_empty());
    }

    #[test]
    fn rotation_marks_are_pruned_to_newest() {
        let mut list: Vec<RotationMark> = (0..ROTATION_MAX + 5)
            .map(|i| RotationMark {
                path: format!("c:\\{i}.jpg"),
                quarter: 1,
                size: i as u64,
                mtime: i as u64,
            })
            .collect();
        prune_rotations(&mut list);
        assert_eq!(list.len(), ROTATION_MAX);
        // 保留的是最新的那批
        assert_eq!(list.first().unwrap().path, "c:\\5.jpg");
        assert_eq!(
            list.last().unwrap().path,
            format!("c:\\{}.jpg", ROTATION_MAX + 4)
        );
    }

    #[test]
    fn recent_dirs_keep_newest_first_and_get_capped() {
        let mut list: Vec<String> = (0..RECENT_DIRS_MAX + 4)
            .map(|i| format!("c:\\dir{i}"))
            .collect();
        prune_recent(&mut list);
        assert_eq!(list.len(), RECENT_DIRS_MAX);
        // 最新在前：截断只丢尾部
        assert_eq!(list.first().unwrap(), "c:\\dir0");
        assert_eq!(
            list.last().unwrap(),
            &format!("c:\\dir{}", RECENT_DIRS_MAX - 1)
        );
        // 不足上限时原样保留
        let mut few = vec!["c:\\a".to_string()];
        prune_recent(&mut few);
        assert_eq!(few, vec!["c:\\a".to_string()]);
    }

    #[test]
    fn wheel_mode_serializes_to_snake_case() {
        assert_eq!(serde_json::to_string(&WheelMode::Zoom).unwrap(), "\"zoom\"");
        assert_eq!(serde_json::to_string(&WheelMode::Page).unwrap(), "\"page\"");
    }

    #[test]
    fn rotate_mode_serializes_to_snake_case() {
        assert_eq!(serde_json::to_string(&RotateMode::View).unwrap(), "\"view\"");
        assert_eq!(serde_json::to_string(&RotateMode::File).unwrap(), "\"file\"");
    }

    #[test]
    fn broken_json_falls_back_to_default() {
        assert_eq!(Settings::from_json(""), Settings::default());
        assert_eq!(Settings::from_json("{not json"), Settings::default());
        // 未知排序值：整体退化，避免半新半旧的配置
        assert_eq!(
            Settings::from_json(r#"{"sort":"by_vibes","filmstrip":false}"#),
            Settings::default()
        );
    }

    #[test]
    fn sort_values_are_snake_case() {
        // 前端下拉框/TS 类型依赖这些字面量
        assert_eq!(serde_json::to_string(&SortMode::Name).unwrap(), "\"name\"");
        assert_eq!(
            serde_json::to_string(&SortMode::NameDesc).unwrap(),
            "\"name_desc\""
        );
        assert_eq!(
            serde_json::to_string(&SortMode::Modified).unwrap(),
            "\"modified\""
        );
        assert_eq!(serde_json::to_string(&SortMode::Size).unwrap(), "\"size\"");
        assert_eq!(serde_json::to_string(&Theme::System).unwrap(), "\"system\"");
        assert_eq!(serde_json::to_string(&Theme::Light).unwrap(), "\"light\"");
    }
}
