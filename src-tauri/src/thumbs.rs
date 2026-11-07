// 缩略图生成 + 磁盘缓存（240px JPEG）

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::ipc::Response;
use tauri::Manager;

const THUMB_MAX: u32 = 240;

#[tauri::command]
pub async fn thumbnail(app: tauri::AppHandle, path: String) -> Result<Response, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    // 缓存键 = hash(路径 + mtime纳秒 + 大小)，文件一变自动失效
    let p = PathBuf::from(&path);
    let md = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let mtime = md
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    mtime.hash(&mut h);
    md.len().hash(&mut h);
    let cache_file = cache_dir.join(format!("{:016x}.jpg", h.finish()));

    if let Ok(bytes) = std::fs::read(&cache_file) {
        if !bytes.is_empty() {
            return Ok(Response::new(bytes));
        }
    }

    let bytes = generate(&p)?;
    let _ = std::fs::write(&cache_file, &bytes);
    Ok(Response::new(bytes))
}

fn generate(p: &Path) -> Result<Vec<u8>, String> {
    let img = image::open(p).map_err(|e| format!("解码失败: {e}"))?;
    let img = crate::exifinfo::oriented_dynamic(img, &p.to_string_lossy());
    let small = if img.width().max(img.height()) > THUMB_MAX {
        img.thumbnail(THUMB_MAX, THUMB_MAX) // box 滤镜，缩略图足够
    } else {
        img
    };
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    small.write_with_encoder(enc).map_err(|e| e.to_string())?;
    Ok(out)
}
