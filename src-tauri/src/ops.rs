// 重命名 / 删除（回收站 / 彻底删除）

use std::path::{Path, PathBuf};

/// Windows 保留设备名（不区分大小写，带扩展名同样保留）
fn is_reserved_name(name: &str) -> bool {
    // 保留名判断只看第一个 '.' 之前的部分，且忽略其尾部空格（如 "CON .jpg"）
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
    let up = stem.to_ascii_uppercase();
    if matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    // COM1-9 / LPT1-9（含上标数字 ¹²³ 的写法，Windows 同样保留）
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = up.strip_prefix(prefix) {
            let mut it = rest.chars();
            if let (Some(c), None) = (it.next(), it.next()) {
                if matches!(c, '1'..='9' | '¹' | '²' | '³') {
                    return true;
                }
            }
        }
    }
    false
}

/// 校验并规整新文件名，返回可直接使用的名字
fn validate_new_name(new_name: &str) -> Result<String, String> {
    let name = new_name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("无效的文件名".into());
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
    {
        return Err("文件名包含非法字符".into());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("文件名不能以点或空格结尾".into());
    }
    if name.encode_utf16().count() > 255 {
        return Err("文件名过长".into());
    }
    if is_reserved_name(name) {
        return Err("文件名是系统保留名称".into());
    }
    match crate::imgscan::ext_of(Path::new(name)) {
        Some(ext) if crate::imgscan::is_image_ext(&ext) => {}
        _ => return Err("文件名必须保留图片扩展名（jpg、jpeg、png、bmp、gif、webp）".into()),
    }
    Ok(name.to_string())
}

/// 仅大小写不同（如 a.jpg → A.jpg）：在不区分大小写的文件系统上目标"已存在"其实就是源文件本身
fn is_case_only_change(old: &str, new: &str) -> bool {
    old != new && old.to_lowercase() == new.to_lowercase()
}

fn is_same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[tauri::command]
pub async fn rename_file(path: String, new_name: String) -> Result<String, String> {
    crate::imgscan::run_blocking(move || rename_blocking(&path, &new_name)).await
}

fn rename_blocking(path: &str, new_name: &str) -> Result<String, String> {
    let (src, _) = crate::imgscan::checked_image_path(path)?;
    let new_name = validate_new_name(new_name)?;
    // 返回给前端的路径保持调用方的写法（不带 \\?\ 前缀）
    let orig = Path::new(path);
    let old_name = orig
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if new_name == old_name {
        return Ok(path.to_string());
    }
    let parent = orig.parent().ok_or("无法获取父目录")?;
    let dest: PathBuf = parent.join(&new_name);
    let dest_io = PathBuf::from(crate::imgscan::long_path(&dest.to_string_lossy()));
    if dest_io.exists() && !(is_case_only_change(&old_name, &new_name) && is_same_file(&src, &dest_io)) {
        return Err("同名文件已存在".into());
    }
    std::fs::rename(&src, &dest_io).map_err(|e| format!("重命名失败: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn delete_file(path: String, permanent: bool) -> Result<(), String> {
    crate::imgscan::run_blocking(move || {
        let (lp, _) = crate::imgscan::checked_image_path(&path)?;
        if permanent {
            std::fs::remove_file(&lp).map_err(|e| format!("删除失败: {e}"))
        } else {
            // 回收站走 Shell API，对 \\?\ 前缀兼容性差，这里改用无前缀的普通路径
            trash::delete(crate::imgscan::plain_path(&path))
                .map_err(|e| format!("移入回收站失败: {e}"))
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_names() {
        assert_eq!(validate_new_name("photo.jpg").unwrap(), "photo.jpg");
        assert_eq!(validate_new_name("  photo.PNG  ").unwrap(), "photo.PNG");
        assert_eq!(validate_new_name("中文 名字 (1).webp").unwrap(), "中文 名字 (1).webp");
        assert_eq!(validate_new_name("a.b.c.gif").unwrap(), "a.b.c.gif");
        assert_eq!(validate_new_name("CONSOLE.jpg").unwrap(), "CONSOLE.jpg");
        assert_eq!(validate_new_name("COM10.jpg").unwrap(), "COM10.jpg");
        assert_eq!(validate_new_name("LPT.jpg").unwrap(), "LPT.jpg");
    }

    #[test]
    fn rejects_empty_and_dots() {
        for n in ["", "   ", ".", ".."] {
            assert!(validate_new_name(n).is_err(), "{n:?}");
        }
    }

    #[test]
    fn rejects_illegal_chars() {
        for n in ["a<b.jpg", "a>b.jpg", "a:b.jpg", "a\"b.jpg", "a/b.jpg", "a\\b.jpg", "a|b.jpg", "a?b.jpg", "a*b.jpg", "a\tb.jpg", "a\nb.jpg", "a\0b.jpg"] {
            assert_eq!(validate_new_name(n).unwrap_err(), "文件名包含非法字符", "{n:?}");
        }
    }

    #[test]
    fn rejects_trailing_dot_or_space() {
        assert!(validate_new_name("a.jpg.").is_err());
        assert!(validate_new_name("a.jpg..").is_err());
        // 首尾空白会先被 trim，不会残留
        assert_eq!(validate_new_name("a.jpg ").unwrap(), "a.jpg");
    }

    #[test]
    fn rejects_reserved_names() {
        for n in [
            "CON.jpg", "con.jpg", "Prn.png", "AUX.gif", "nul.bmp", "NUL.tar.jpg",
            "COM1.jpg", "com9.png", "LPT1.jpg", "lpt9.webp", "COM².jpg", "CON .jpg",
        ] {
            assert_eq!(validate_new_name(n).unwrap_err(), "文件名是系统保留名称", "{n:?}");
        }
    }

    #[test]
    fn requires_image_extension() {
        for n in ["photo", "photo.txt", "photo.exe", "photo.jpg.exe", ".jpg", "photo.jpgx", "photo.tiff"] {
            let e = validate_new_name(n).unwrap_err();
            assert!(e.contains("图片扩展名"), "{n:?} → {e}");
        }
        // 允许在图片扩展名之间变化，大小写不敏感
        for n in ["a.JPG", "a.JpEg", "a.Png", "a.BMP", "a.gif", "a.WEBP"] {
            assert!(validate_new_name(n).is_ok(), "{n:?}");
        }
    }

    #[test]
    fn rejects_overlong_names() {
        let ok = format!("{}.jpg", "a".repeat(251));
        assert!(validate_new_name(&ok).is_ok());
        let too_long = format!("{}.jpg", "a".repeat(252));
        assert_eq!(validate_new_name(&too_long).unwrap_err(), "文件名过长");
    }

    #[test]
    fn case_only_change_detection() {
        assert!(is_case_only_change("a.jpg", "A.jpg"));
        assert!(is_case_only_change("Photo.JPG", "photo.jpg"));
        assert!(!is_case_only_change("a.jpg", "a.jpg"));
        assert!(!is_case_only_change("a.jpg", "b.jpg"));
        assert!(!is_case_only_change("a.jpg", "a.png"));
    }

    #[test]
    fn rename_end_to_end_in_temp_dir() {
        let dir = std::env::temp_dir().join(format!("pv-ops-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        std::fs::write(&a, b"A").unwrap();
        std::fs::write(&b, b"B").unwrap();
        let a_str = a.to_string_lossy().into_owned();

        // 目标已存在且不是同一个文件 → 拒绝
        assert_eq!(rename_blocking(&a_str, "b.jpg").unwrap_err(), "同名文件已存在");
        // 非图片扩展名 → 拒绝，文件未动
        assert!(rename_blocking(&a_str, "a.txt").is_err());
        assert!(a.exists());
        // 仅改大小写 → 成功（Windows 上目标"已存在"也不应判重名）
        let renamed = rename_blocking(&a_str, "A.jpg").unwrap();
        assert_eq!(Path::new(&renamed), dir.join("A.jpg"));
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"A.jpg".to_string()), "{names:?}");
        assert!(!names.contains(&"a.jpg".to_string()), "{names:?}");
        // 普通改名
        let renamed2 = rename_blocking(&renamed, "c.png").unwrap();
        assert_eq!(std::fs::read(&renamed2).unwrap(), b"A");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
