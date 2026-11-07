// 缩略图生成 + 磁盘缓存（240px JPEG）

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::ipc::Response;
use tauri::Manager;

const THUMB_MAX: u32 = 240;

#[tauri::command]
pub async fn thumbnail(app: tauri::AppHandle, path: String) -> Result<Response, String> {
    let t0 = std::time::Instant::now();
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    // 缓存键 = hash(路径 + mtime纳秒 + 大小)，文件一变自动失效
    let p = PathBuf::from(&path);
    let md = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(e) => {
            crate::imgscan::diag_log(&app, &format!("THUMB STAT FAIL {path}: {e}"));
            return Err(e.to_string());
        }
    };
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

    match generate(&p) {
        Ok(bytes) => {
            crate::imgscan::diag_log(
                &app,
                &format!("THUMB OK {} ({}B, {}ms)", path, bytes.len(), t0.elapsed().as_millis()),
            );
            let _ = std::fs::write(&cache_file, &bytes);
            Ok(Response::new(bytes))
        }
        Err(e) => {
            crate::imgscan::diag_log(&app, &format!("THUMB FAIL {path}: {e}"));
            Err(e)
        }
    }
}

fn generate(p: &Path) -> Result<Vec<u8>, String> {
    // 按内容嗅探格式：网上下载的图常见「.png 扩展名 + JPEG 内容」
    let f = std::fs::File::open(p).map_err(|e| format!("打开失败: {e}"))?;
    let mut reader = image::ImageReader::new(std::io::BufReader::new(f));
    // 解除默认 512MB 分配上限：超大壁纸海报解码后立即缩到 240px
    let mut lim = image::Limits::default();
    lim.max_alloc = None;
    lim.max_image_width = None;
    lim.max_image_height = None;
    reader.limits(lim);
    let img = reader
        .with_guessed_format()
        .map_err(|e| format!("格式识别失败: {e}"))?
        .decode()
        .map_err(|e| format!("解码失败: {e}"))?;
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
