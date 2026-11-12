// 导出 / 另存为：等比缩放 + 转格式 + JPEG 质量
//
// 不改原图：解码（复用缩略图那套"JPEG 走 DCT 缩放解码，其它格式退回通用解码"）→
// 按目标格式重编码 → 同目录临时文件 + 改名落盘。
//
// 扩展名一律以"实际写入的格式"为准（用户选 PNG 却把文件名写成 .jpg 时会被纠正），
// 避免出现扩展名与内容不符的文件。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::imgscan::{self, MAX_DIMENSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    /// 保持原格式：BMP/GIF 导出为 PNG（无损且体积小得多）
    #[default]
    Keep,
    Jpeg,
    Png,
    Webp,
}

impl ExportFormat {
    fn ext(self) -> &'static str {
        match self {
            ExportFormat::Jpeg => "jpg",
            ExportFormat::Png => "png",
            ExportFormat::Webp => "webp",
            ExportFormat::Keep => "png",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ExportFormat::Jpeg => "JPEG",
            ExportFormat::Png => "PNG",
            ExportFormat::Webp => "WebP",
            ExportFormat::Keep => "原格式",
        }
    }
}

#[derive(Serialize, Debug)]
pub struct ExportResult {
    /// 实际写入的路径（扩展名可能已被纠正）
    pub path: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

/// 源文件的真实格式（按魔数）
enum Sniff {
    Jpeg,
    Png,
    Webp,
    Other,
}

fn sniff(p: &Path) -> Sniff {
    let mut head = [0u8; 12];
    let Ok(mut f) = fs::File::open(p) else {
        return Sniff::Other;
    };
    let n = f.read(&mut head).unwrap_or(0);
    let head = &head[..n];
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Sniff::Jpeg
    } else if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Sniff::Png
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Sniff::Webp
    } else {
        Sniff::Other
    }
}

fn resolve_format(src: &Path, want: ExportFormat) -> ExportFormat {
    match want {
        ExportFormat::Keep => match sniff(src) {
            Sniff::Jpeg => ExportFormat::Jpeg,
            Sniff::Png => ExportFormat::Png,
            Sniff::Webp => ExportFormat::Webp,
            // BMP/GIF 等没有合适的同格式编码器（或编码后体积暴涨），统一导出为 PNG
            Sniff::Other => ExportFormat::Png,
        },
        f => f,
    }
}

/// 把目标路径的扩展名换成目标格式的扩展名
fn with_ext(dest: &str, fmt: ExportFormat) -> PathBuf {
    let p = Path::new(dest);
    let mut name = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if name.is_empty() {
        name = "导出".to_string();
    }
    let parent = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    parent.join(format!("{name}.{}", fmt.ext()))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// 同目录临时文件 + 改名：中途失败不会留下半个文件
fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = dest.parent().ok_or("目标路径无效")?;
    if !dir.is_dir() {
        return Err("目标文件夹不存在".into());
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.pvtmp-{}", std::process::id()));
    let tmp_long = PathBuf::from(imgscan::long_path(&tmp.to_string_lossy()));
    fs::write(&tmp_long, bytes).map_err(|e| format!("写入失败: {e}"))?;
    let dest_long = PathBuf::from(imgscan::long_path(&dest.to_string_lossy()));
    fs::rename(&tmp_long, &dest_long).map_err(|e| {
        let _ = fs::remove_file(&tmp_long);
        format!("写入失败: {e}")
    })
}

fn encode(
    img: &image::DynamicImage,
    fmt: ExportFormat,
    quality: u8,
    src: &Path,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    match fmt {
        ExportFormat::Jpeg => {
            // JPEG 没有透明通道：先把透明区域压到 RGB
            let rgb = img.to_rgb8();
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
            rgb.write_with_encoder(enc)
                .map_err(|e| format!("JPEG 编码失败: {e}"))?;
        }
        ExportFormat::Png => {
            use image::ImageEncoder as _;
            let mut enc = image::codecs::png::PngEncoder::new(&mut out);
            // 源是 PNG 时把 ICC 带过去，避免导出后色彩偏移
            if matches!(sniff(src), Sniff::Png) {
                if let Some(icc) = crate::rotate::png_icc_profile(src) {
                    let _ = enc.set_icc_profile(icc);
                }
            }
            enc.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                image::ExtendedColorType::from(img.color()),
            )
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
        }
        ExportFormat::Webp => {
            // image 的 WebP 编码器只有无损档（有损重编码会明显掉画质）
            let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            enc.encode(
                img.as_bytes(),
                img.width(),
                img.height(),
                image::ExtendedColorType::from(img.color()),
            )
            .map_err(|e| format!("WebP 编码失败: {e}"))?;
        }
        ExportFormat::Keep => unreachable!("Keep 已在 resolve_format 里解析"),
    }
    Ok(out)
}

fn export_blocking(
    src: &str,
    dest: &str,
    want: ExportFormat,
    max_side: Option<u32>,
    quality: Option<u8>,
    overwrite: bool,
    rotate: u8,
) -> Result<ExportResult, String> {
    let (src_long, _) = imgscan::checked_image_path(src)?;
    if dest.trim().is_empty() {
        return Err("请先选择保存位置".into());
    }
    let fmt = resolve_format(&src_long, want);
    let dest = with_ext(dest, fmt);
    if same_file(&src_long, &dest) {
        return Err("不能覆盖正在导出的原图".into());
    }
    if dest.exists() && !overwrite {
        return Err("目标文件已存在".into());
    }

    let limit = max_side
        .filter(|v| *v > 0)
        .map(|v| v.min(MAX_DIMENSION))
        .unwrap_or(MAX_DIMENSION);
    let img = crate::thumbs::decode_at(&src_long, limit)?;
    let img = crate::thumbs::rotate_quarter(img, rotate);
    let (w, h) = (img.width(), img.height());
    let bytes = crate::imgscan::catch_decode("导出", || {
        encode(&img, fmt, quality.unwrap_or(92).clamp(1, 100), &src_long)
    })?;
    write_atomic(&dest, &bytes)?;
    Ok(ExportResult {
        path: dest.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
        width: w,
        height: h,
        format: fmt.label().to_string(),
    })
}

/// max_side 限的是旋转后的长边（与用户看到的画面一致）
#[tauri::command]
pub async fn export_image(
    src: String,
    dest: String,
    format: ExportFormat,
    max_side: Option<u32>,
    quality: Option<u8>,
    overwrite: Option<bool>,
    rotate: Option<u8>,
) -> Result<ExportResult, String> {
    let q = rotate.unwrap_or(0);
    imgscan::run_blocking(move || {
        export_blocking(
            &src,
            &dest,
            format,
            max_side,
            quality,
            overwrite.unwrap_or(false),
            q,
        )
    })
    .await
}

/// 系统"另存为"对话框（导出时选位置）。用户取消返回 None。
/// 目录与文件名分开传：Windows 的 SetFileName 只保证吃纯文件名。
#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    dir: String,
    file_name: String,
    ext: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    imgscan::run_blocking(move || {
        let mut builder = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("导出图片")
            .set_directory(&dir)
            .set_file_name(&file_name);
        if let Some(ext) = ext.as_deref().filter(|e| !e.is_empty()) {
            builder = builder.add_filter("图片", &[ext]);
        }
        let Some(file) = builder.blocking_save_file() else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        Ok(Some(path))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pv-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let p = dir.join(name);
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 7]));
        img.save(&p).unwrap();
        p
    }

    #[test]
    fn keeps_format_for_png_and_maps_bmp_to_png() {
        let dir = temp_dir("export-fmt");
        let png = make_png(&dir, "a.png", 8, 4);
        assert_eq!(resolve_format(&png, ExportFormat::Keep), ExportFormat::Png);

        let bmp = dir.join("a.bmp");
        let img = image::RgbImage::new(4, 4);
        img.save(&bmp).unwrap();
        assert_eq!(resolve_format(&bmp, ExportFormat::Keep), ExportFormat::Png);

        let jpg = dir.join("a.jpg");
        image::RgbImage::new(4, 4).save(&jpg).unwrap();
        assert_eq!(resolve_format(&jpg, ExportFormat::Keep), ExportFormat::Jpeg);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_resizes_and_fixes_extension() {
        let dir = temp_dir("export-run");
        let src = make_png(&dir, "src.png", 200, 100);
        // 目标写成 .jpeg 也要被纠正成 .jpg
        let dest = dir.join("out.jpeg");
        let r = export_blocking(
            &src.to_string_lossy(),
            &dest.to_string_lossy(),
            ExportFormat::Jpeg,
            Some(50),
            Some(90),
            false,
            0,
        )
        .unwrap();
        assert!(r.path.ends_with("out.jpg"), "{}", r.path);
        assert_eq!((r.width, r.height), (50, 25));
        assert_eq!(r.format, "JPEG");
        let bytes = fs::read(&r.path).unwrap();
        assert_eq!(r.bytes, bytes.len() as u64);
        assert!(bytes.starts_with(&[0xFF, 0xD8, 0xFF]));
        let dec = image::load_from_memory(&bytes).unwrap();
        assert_eq!((dec.width(), dec.height()), (50, 25));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_refuses_existing_without_overwrite() {
        let dir = temp_dir("export-exists");
        let src = make_png(&dir, "src.png", 32, 32);
        let dest = dir.join("src-导出.png");
        fs::write(&dest, b"old").unwrap();
        let err = export_blocking(
            &src.to_string_lossy(),
            &dest.to_string_lossy(),
            ExportFormat::Png,
            None,
            None,
            false,
            0,
        )
        .unwrap_err();
        assert_eq!(err, "目标文件已存在");
        // 允许覆盖时会真的写进去
        let r = export_blocking(
            &src.to_string_lossy(),
            &dest.to_string_lossy(),
            ExportFormat::Png,
            None,
            None,
            true,
            0,
        )
        .unwrap();
        assert!(fs::read(&r.path).unwrap().starts_with(b"\x89PNG"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_refuses_overwriting_source() {
        let dir = temp_dir("export-self");
        let src = make_png(&dir, "self.png", 16, 16);
        let err = export_blocking(
            &src.to_string_lossy(),
            &src.to_string_lossy(),
            ExportFormat::Png,
            None,
            None,
            true,
            0,
        )
        .unwrap_err();
        assert_eq!(err, "不能覆盖正在导出的原图");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_webp_and_png_roundtrip() {
        let dir = temp_dir("export-webp");
        let src = make_png(&dir, "w.png", 40, 20);
        for (fmt, head) in [
            (ExportFormat::Webp, b"RIFF".as_slice()),
            (ExportFormat::Png, b"\x89PNG".as_slice()),
        ] {
            let dest = dir.join(format!("out-{}", fmt.ext()));
            let r = export_blocking(
                &src.to_string_lossy(),
                &dest.to_string_lossy(),
                fmt,
                None,
                None,
                false,
                0,
            )
            .unwrap();
            assert!(r.path.ends_with(fmt.ext()));
            let bytes = fs::read(&r.path).unwrap();
            assert!(bytes.starts_with(head), "{} 文件头不对", r.path);
            let dec = image::load_from_memory(&bytes).unwrap();
            assert_eq!((dec.width(), dec.height()), (40, 20));
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dest_without_extension_gets_one() {
        let dir = temp_dir("export-noext");
        let dest = with_ext(&dir.join("无扩展名").to_string_lossy(), ExportFormat::Jpeg);
        assert!(dest.to_string_lossy().ends_with("无扩展名.jpg"));
    }
}
