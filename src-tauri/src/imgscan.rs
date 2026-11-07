// 目录扫描与动图探测

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tauri::Manager;

/// 诊断日志：追加到 app 缓存目录，超 512KB 重置
pub fn diag_log(app: &tauri::AppHandle, msg: &str) {
    let Ok(dir) = app.path().app_cache_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let file = dir.join("picaview.log");
    let ts = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] {}\n", ts, msg);
    if let Ok(md) = fs::metadata(&file) {
        if md.len() > 512 * 1024 {
            let _ = fs::write(&file, line);
            return;
        }
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[derive(Serialize, Clone)]
pub struct ImageEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: Option<u64>, // 毫秒时间戳
    pub animated: bool,
}

pub fn ext_of(p: &Path) -> Option<String> {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "bmp" | "gif" | "webp")
}

/// 探测动图：多帧 GIF / 动画 WebP (ANIM/ANMF) / APNG (acTL)
pub fn detect_animated(p: &Path, ext: &str) -> bool {
    let Ok(mut f) = fs::File::open(p) else {
        return false;
    };
    match ext {
        "gif" => {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_err() {
                return false;
            }
            is_animated_gif(&buf)
        }
        "webp" => {
            let mut buf = [0u8; 128];
            let n = f.read(&mut buf).unwrap_or(0);
            let b = &buf[..n];
            b.starts_with(b"RIFF")
                && b.len() >= 12
                && &b[8..12] == b"WEBP"
                && (b.windows(4).any(|w| w == b"ANIM") || b.windows(4).any(|w| w == b"ANMF"))
        }
        "png" => {
            let mut buf = [0u8; 128];
            let n = f.read(&mut buf).unwrap_or(0);
            buf[..n].windows(4).any(|w| w == b"acTL")
        }
        _ => false,
    }
}

/// 解析 GIF 块结构，统计图像帧数
fn is_animated_gif(buf: &[u8]) -> bool {
    if buf.len() < 13 || (&buf[0..6] != b"GIF87a" && &buf[0..6] != b"GIF89a") {
        return false;
    }
    let mut i = 13usize; // 跳过头部 + 逻辑屏幕描述符
    let gct_flags = buf[10];
    if gct_flags & 0x80 != 0 {
        i += 3 * (1usize << ((gct_flags & 0x07) + 1)); // 全局色表
    }
    let mut frames = 0;
    while i < buf.len() {
        match buf[i] {
            0x21 => {
                // 扩展块：0x21 label 子块... 0x00
                i += 2;
                while i < buf.len() && buf[i] != 0 {
                    i += 1 + buf[i] as usize;
                }
                i += 1;
            }
            0x2C => {
                frames += 1;
                if frames > 1 {
                    return true;
                }
                // 图像描述符 9 字节 + 可选局部色表 + LZW 数据子块
                if i + 10 > buf.len() {
                    return false;
                }
                let lct_flags = buf[i + 9];
                i += 10;
                if lct_flags & 0x80 != 0 {
                    i += 3 * (1usize << ((lct_flags & 0x07) + 1));
                }
                i += 1; // LZW 最小码长
                while i < buf.len() && buf[i] != 0 {
                    i += 1 + buf[i] as usize;
                }
                i += 1;
            }
            0x3B => break, // 结束符
            _ => break,
        }
    }
    false
}

fn entry_from(path: &Path, md: &fs::Metadata) -> ImageEntry {
    let ext = ext_of(path).unwrap_or_default();
    let modified = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    ImageEntry {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        size: md.len(),
        modified,
        animated: detect_animated(path, &ext),
    }
}

/// 列出目录中的图片（自然排序）
#[tauri::command]
pub async fn list_images(app: tauri::AppHandle, dir: String) -> Result<Vec<ImageEntry>, String> {
    let t0 = std::time::Instant::now();
    let rd = fs::read_dir(&dir).map_err(|e| {
        diag_log(&app, &format!("LIST FAIL {dir} ({e})"));
        format!("无法读取文件夹 {dir}: {e}")
    })?;
    let mut out: Vec<ImageEntry> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(ext) = ext_of(&path) else { continue };
        if !is_image_ext(&ext) {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        out.push(entry_from(&path, &md));
    }
    out.sort_by(|a, b| natord::compare(&a.name, &b.name));
    diag_log(&app, &format!("LIST {dir} → {} 项 ({}ms)", out.len(), t0.elapsed().as_millis()));
    Ok(out)
}

/// 单文件信息（列表中不存在时兜底）
#[tauri::command]
pub async fn stat_file(path: String) -> Result<ImageEntry, String> {
    let p = PathBuf::from(&path);
    let md = fs::metadata(&p).map_err(|e| e.to_string())?;
    Ok(entry_from(&p, &md))
}

/// Windows 长路径处理：规范化分隔符并按需加 \\?\ 前缀
pub fn long_path(p: &str) -> String {
    let p = p.replace('/', "\\");
    if p.starts_with("\\\\?\\") {
        return p;
    }
    if p.starts_with("\\\\") {
        // UNC 路径 → \\?\UNC\...
        return format!("\\\\?\\UNC\\{}", &p[2..]);
    }
    // 盘符路径 (X:\...) 才加前缀；相对路径保持原样
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        format!("\\\\?\\{}", p)
    } else {
        p
    }
}

/// 读取图片字节（替代 asset 协议，规避其路径解码限制）
#[tauri::command]
pub async fn read_image(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let t0 = std::time::Instant::now();
    match fs::read(long_path(&path)) {
        Ok(bytes) => {
            diag_log(&app, &format!("READ OK {} ({}B, {}ms)", path, bytes.len(), t0.elapsed().as_millis()));
            Ok(tauri::ipc::Response::new(bytes))
        }
        Err(e) => {
            diag_log(&app, &format!("READ FAIL {} ({})", path, e));
            Err(format!("读取文件失败: {e}"))
        }
    }
}

/// 前端诊断日志入口
#[tauri::command]
pub async fn append_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    diag_log(&app, &msg);
    Ok(())
}
