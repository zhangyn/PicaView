// 剪贴板与桌面壁纸
//
// - 复制图片：解码成 RGBA 走 CF_DIB，长边超过上限先等比缩小（100MP 原图塞进剪贴板没有意义，
//   聊天软件/文档也用不上）
// - 复制文件：CF_HDROP，粘贴到资源管理器/聊天软件是"文件"而不是位图，零转码、保留原图
// - 桌面壁纸：统一转成 JPEG 再调 SystemParametersInfoW——Windows 只稳定支持 BMP/JPEG，
//   WebP/GIF 直接设会失败或显示旧图

use std::io::BufWriter;
use std::path::Path;

/// 复制图片到剪贴板，返回实际写入的像素尺寸
#[tauri::command]
pub async fn copy_image(path: String, max_side: u32) -> Result<(u32, u32), String> {
    crate::imgscan::run_blocking(move || copy_image_blocking(&path, max_side)).await
}

fn copy_image_blocking(path: &str, max_side: u32) -> Result<(u32, u32), String> {
    let (src, _) = crate::imgscan::checked_image_path(path)?;
    let img = crate::thumbs::decode_at(&src, max_side.clamp(256, 16384))?;
    let (w, h) = (img.width(), img.height());
    let rgba = img.to_rgba8();
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| format!("写入剪贴板失败: {e}"))?;
    Ok((w, h))
}

/// 把文件放到剪贴板（CF_HDROP），返回成功放入的数量
#[tauri::command]
pub async fn copy_files(paths: Vec<String>) -> Result<usize, String> {
    crate::imgscan::run_blocking(move || copy_files_blocking(&paths)).await
}

fn copy_files_blocking(paths: &[String]) -> Result<usize, String> {
    // 逐个校验，任何一个不合法就整体失败，避免剪贴板里出现"半套"文件
    let mut list: Vec<String> = Vec::new();
    for p in paths {
        let (lp, _) = crate::imgscan::checked_image_path(p)?;
        // CF_HDROP 用普通路径（不带 \\?\ 前缀），和资源管理器的写法保持一致
        list.push(lp.to_string_lossy().into_owned());
    }
    if list.is_empty() {
        return Err("没有可复制的文件".into());
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    clipboard
        .set()
        .file_list(&list)
        .map_err(|e| format!("写入剪贴板失败: {e}"))?;
    Ok(list.len())
}

/// 把当前图片设为桌面壁纸
#[tauri::command]
pub async fn set_wallpaper(app: tauri::AppHandle, path: String) -> Result<(), String> {
    crate::imgscan::run_blocking(move || set_wallpaper_blocking(&app, &path)).await
}

/// 壁纸解码上限：4K/8K 屏都够用，再大只是白占内存
const WALLPAPER_MAX_SIDE: u32 = 8192;

fn set_wallpaper_blocking(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    use tauri::Manager;

    let (src, _) = crate::imgscan::checked_image_path(path)?;
    let img = crate::thumbs::decode_at(&src, WALLPAPER_MAX_SIDE)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("wallpaper");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建壁纸目录失败: {e}"))?;

    let out = dir.join("picaview-wallpaper.jpg");
    let tmp = dir.join("picaview-wallpaper.jpg.tmp");
    write_jpeg(&img, &tmp)?;
    std::fs::rename(&tmp, &out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("壁纸文件写入失败: {e}")
    })?;
    apply_wallpaper(&out)
}

fn write_jpeg(img: &image::DynamicImage, to: &Path) -> Result<(), String> {
    let f = std::fs::File::create(to).map_err(|e| format!("创建壁纸文件失败: {e}"))?;
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(BufWriter::new(f), 92);
    img.write_with_encoder(enc)
        .map_err(|e| format!("壁纸编码失败: {e}"))
}

#[cfg(windows)]
fn apply_wallpaper(file: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER,
    };

    let wide: Vec<u16> = file
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: wide 以 NUL 结尾且在调用期间存活；pvparam 指向的就是这块缓冲区
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            wide.as_ptr() as *mut std::ffi::c_void,
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    };
    if ok == 0 {
        return Err("系统拒绝设置壁纸".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_wallpaper(_file: &Path) -> Result<(), String> {
    Err("仅 Windows 支持设为壁纸".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pv-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// decode_at 的口径：长边不超过上限、等比、EXIF 方向已摆正
    #[test]
    fn decode_at_respects_max_side() {
        let dir = temp_dir("actions");
        let p = dir.join("big.jpg");
        let img = image::RgbImage::from_fn(1200, 600, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 9])
        });
        img.save(&p).unwrap();

        let out = crate::thumbs::decode_at(&p, 400).unwrap();
        assert_eq!((out.width(), out.height()), (400, 200));

        // 小于上限时保持原样，不放大
        let out = crate::thumbs::decode_at(&p, 4096).unwrap();
        assert_eq!((out.width(), out.height()), (1200, 600));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_jpeg_produces_decodable_file() {
        let dir = temp_dir("wallpaper-enc");
        let img = image::RgbImage::from_fn(64, 32, |x, y| image::Rgb([x as u8, y as u8, 3]));
        let out = dir.join("w.jpg");
        write_jpeg(&image::DynamicImage::ImageRgb8(img), &out).unwrap();
        let dec = image::load_from_memory(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!((dec.width(), dec.height()), (64, 32));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
