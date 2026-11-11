// 用户设置：显示开关、排序方式等，存于 app_config_dir/settings.json
//
// 只存"下次启动还想保持"的东西：窗口几何、缩放位置这类随会话变化的状态不落盘。
// 读失败/字段缺失/内容损坏一律退化成默认值，绝不让设置把软件卡住。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::imgscan::SortMode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// 打开图片即进入全屏灯箱（关掉则用普通窗口看图）
    pub lightbox: bool,
    /// 胶片条默认显示
    pub filmstrip: bool,
    /// 信息浮层默认显示
    pub infobar: bool,
    /// 目录排序方式
    pub sort: SortMode,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            lightbox: true,
            filmstrip: true,
            infobar: true,
            sort: SortMode::Name,
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
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, s.to_json()).map_err(|e| format!("写设置失败: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("保存设置失败: {e}")
    })
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
            filmstrip: false,
            infobar: false,
            sort: SortMode::Modified,
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
    }
}
