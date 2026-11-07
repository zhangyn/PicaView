// 重命名 / 删除（回收站 / 彻底删除）

use std::path::Path;

#[tauri::command]
pub async fn rename_file(path: String, new_name: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err("文件不存在".into());
    }
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name == "." || new_name == ".." {
        return Err("无效的文件名".into());
    }
    if new_name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
    {
        return Err("文件名包含非法字符".into());
    }
    let parent = p.parent().ok_or("无法获取父目录")?;
    let dest = parent.join(new_name);
    if dest.exists() {
        return Err("同名文件已存在".into());
    }
    std::fs::rename(p, &dest).map_err(|e| format!("重命名失败: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn delete_file(path: String, permanent: bool) -> Result<(), String> {
    if permanent {
        std::fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    } else {
        trash::delete(&path).map_err(|e| format!("移入回收站失败: {e}"))?;
    }
    Ok(())
}
