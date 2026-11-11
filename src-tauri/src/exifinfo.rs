// EXIF 读取 / 内嵌预览提取 / 方向摆正

use image::DynamicImage;
use serde::Serialize;
use std::io::BufReader;
use tauri::ipc::Response;

#[derive(Serialize)]
pub struct ExifInfo {
    pub orientation: u32,
    pub date_taken: Option<String>,
    pub camera: Option<String>,
}

pub(crate) fn load(path: &str) -> Option<exif::Exif> {
    let file = std::fs::File::open(path).ok()?;
    let mut br = BufReader::new(file);
    exif::Reader::new().read_from_container(&mut br).ok()
}

fn find_tag(ex: &exif::Exif, tag: exif::Tag) -> Option<&exif::Field> {
    ex.fields().find(|f| f.tag == tag)
}

fn orientation_of(ex: &exif::Exif) -> u32 {
    find_tag(ex, exif::Tag::Orientation)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1)
}

/// 直接从内存字节读取 EXIF 方向（省去为读方向再开一次文件）。
/// 非 JPEG 容器或解析失败一律按 1（不变换）处理。
pub fn orientation_of_bytes(data: &[u8]) -> u32 {
    if !is_jpeg_magic(data) {
        return 1;
    }
    let mut cur = std::io::Cursor::new(data);
    exif::Reader::new()
        .read_from_container(&mut cur)
        .map(|ex| orientation_of(&ex))
        .unwrap_or(1)
}

/// IFD1 内嵌缩略图（JPEGInterchangeFormat 0x0201 / Length 0x0202）
fn embedded_thumbnail(ex: &exif::Exif) -> Option<&[u8]> {
    let off = ex
        .get_field(exif::Tag(exif::Context::Tiff, 0x0201), exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let len = ex
        .get_field(exif::Tag(exif::Context::Tiff, 0x0202), exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let buf = ex.buf();
    if len == 0 || off + len > buf.len() {
        return None;
    }
    Some(&buf[off..off + len])
}

/// 读取拍摄信息（仅 JPEG 有意义）
#[tauri::command]
pub async fn read_exif(path: String) -> Option<ExifInfo> {
    tauri::async_runtime::spawn_blocking(move || read_exif_blocking(&path))
        .await
        .ok()
        .flatten()
}

fn read_exif_blocking(path: &str) -> Option<ExifInfo> {
    let (p, _) = crate::imgscan::checked_image_path(path).ok()?;
    let ex = load(&p.to_string_lossy())?;
    let date_taken = find_tag(&ex, exif::Tag::DateTimeOriginal).and_then(|f| {
        match &f.value {
            exif::Value::Ascii(v) => v
                .first()
                .and_then(|raw| exif::DateTime::from_ascii(raw).ok())
                .map(|dt| dt.to_string()),
            _ => None,
        }
    });
    let camera = find_tag(&ex, exif::Tag::Model)
        .map(|f| f.display_value().to_string())
        .map(|s| s.trim_matches('"').trim().to_string())
        .filter(|s| !s.is_empty());
    Some(ExifInfo {
        orientation: orientation_of(&ex),
        date_taken,
        camera,
    })
}

/// 提取 EXIF 内嵌缩略图（已按方向摆正，重编码为 JPEG）。
/// 返回空 Response 表示无预览。
#[tauri::command]
pub async fn extract_preview(path: String) -> Result<Response, String> {
    let bytes = crate::imgscan::run_blocking(move || extract_preview_blocking(&path)).await?;
    Ok(Response::new(bytes))
}

fn extract_preview_blocking(path: &str) -> Result<Vec<u8>, String> {
    // 路径不合法或无预览统一返回空字节，前端按"无预览"处理
    let Ok((p, _)) = crate::imgscan::checked_image_path(path) else {
        return Ok(Vec::new());
    };
    let Some(ex) = load(&p.to_string_lossy()) else {
        return Ok(Vec::new());
    };
    let Some(thumb) = embedded_thumbnail(&ex) else {
        return Ok(Vec::new());
    };
    let Ok(img) = image::load_from_memory(thumb) else {
        return Ok(Vec::new());
    };
    let img = apply_orientation(img, orientation_of(&ex));
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    img.write_with_encoder(enc).map_err(|e| e.to_string())?;
    Ok(out)
}

/// 文件头是否为 JPEG 魔数 FF D8 FF
fn is_jpeg_magic(head: &[u8]) -> bool {
    head.starts_with(&[0xFF, 0xD8, 0xFF])
}

/// 按文件头魔数判断是否 JPEG（扩展名可能不可信）
fn file_is_jpeg(path: &str) -> bool {
    use std::io::Read;
    let mut head = [0u8; 3];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok()
        && is_jpeg_magic(&head)
}

/// 按 EXIF 方向摆正动态图像（仅对 JPEG 内容生效）
pub fn oriented_dynamic(img: DynamicImage, path: &str) -> DynamicImage {
    if !file_is_jpeg(path) {
        return img;
    }
    let o = load(path).map(|ex| orientation_of(&ex)).unwrap_or(1);
    apply_orientation(img, o)
}

/// 按 orientation 值摆正（1..8，标准 EXIF 定义）
/// 注：image 0.25 无 transpose/transverse，用 rotate90 + fliph/flipv 组合
pub fn apply_orientation(img: DynamicImage, o: u32) -> DynamicImage {
    match o {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(), // transpose（主对角线翻转）
        6 => img.rotate90(),         // 顺时针 90°
        7 => img.rotate90().flipv(), // transverse（反对角线翻转）
        8 => img.rotate270(),
        _ => img,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, GrayImage, Luma};

    const W: u32 = 3;
    const H: u32 = 2;

    /// 3x2 灰度图，像素值 = y * 3 + x + 1（各不相同）
    fn sample() -> DynamicImage {
        let mut g = GrayImage::new(W, H);
        for y in 0..H {
            for x in 0..W {
                g.put_pixel(x, y, Luma([(y * W + x) as u8 + 1]));
            }
        }
        DynamicImage::ImageLuma8(g)
    }

    fn at(img: &GrayImage, x: u32, y: u32) -> u8 {
        img.get_pixel(x, y).0[0]
    }

    #[test]
    fn orientation_of_bytes_defaults_to_one() {
        assert_eq!(orientation_of_bytes(b"not a jpeg at all"), 1);
        assert_eq!(orientation_of_bytes(b"\x89PNG\r\n\x1a\n"), 1);
        assert_eq!(orientation_of_bytes(b""), 1);
    }

    #[test]
    fn apply_orientation_matches_exif_definition() {
        let src = sample().to_luma8();
        let s = |x: u32, y: u32| at(&src, x, y);
        for o in 1..=8u32 {
            let out = apply_orientation(sample(), o);
            let (ow, oh) = out.dimensions();
            let swapped = (5..=8).contains(&o);
            assert_eq!((ow, oh), if swapped { (H, W) } else { (W, H) }, "尺寸 o={o}");
            let out = out.to_luma8();
            for y in 0..oh {
                for x in 0..ow {
                    let want = match o {
                        1 => s(x, y),
                        2 => s(W - 1 - x, y),         // 水平镜像
                        3 => s(W - 1 - x, H - 1 - y), // 旋转 180°
                        4 => s(x, H - 1 - y),         // 垂直镜像
                        5 => s(y, x),                 // 沿主对角线转置
                        6 => s(y, H - 1 - x),         // 顺时针 90°
                        7 => s(W - 1 - y, H - 1 - x), // 沿副对角线转置
                        8 => s(W - 1 - y, x),         // 逆时针 90°
                        _ => unreachable!(),
                    };
                    assert_eq!(at(&out, x, y), want, "o={o} ({x},{y})");
                }
            }
        }
    }

    #[test]
    fn apply_orientation_out_of_range_is_identity() {
        for o in [0u32, 9, 42] {
            assert_eq!(apply_orientation(sample(), o).to_luma8(), sample().to_luma8());
        }
    }

    #[test]
    fn jpeg_magic_detection() {
        assert!(is_jpeg_magic(&[0xFF, 0xD8, 0xFF]));
        assert!(is_jpeg_magic(&[0xFF, 0xD8, 0xFF, 0xE1, 0x00]));
        assert!(!is_jpeg_magic(&[0x89, b'P', b'N', b'G']));
        assert!(!is_jpeg_magic(&[0xFF, 0xD8]));
        assert!(!is_jpeg_magic(&[]));
    }

    #[test]
    fn file_is_jpeg_ignores_extension() {
        let dir = std::env::temp_dir().join(format!("pv-exif-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 扩展名是 png 但内容是 JPEG；以及扩展名是 jpg 但内容是 PNG
        let a = dir.join("a.png");
        let b = dir.join("b.jpg");
        std::fs::write(&a, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).unwrap();
        std::fs::write(&b, b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(file_is_jpeg(&a.to_string_lossy()));
        assert!(!file_is_jpeg(&b.to_string_lossy()));
        assert!(!file_is_jpeg(&dir.join("missing.jpg").to_string_lossy()));
        // 非 JPEG 内容：oriented_dynamic 原样返回
        let out = oriented_dynamic(sample(), &b.to_string_lossy());
        assert_eq!(out.to_luma8(), sample().to_luma8());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
