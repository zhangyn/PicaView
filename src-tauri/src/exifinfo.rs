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

fn load(path: &str) -> Option<exif::Exif> {
    let file = std::fs::File::open(path).ok()?;
    let mut br = BufReader::new(file);
    exif::Reader::new().read_from_container(&mut br).ok()
}

fn find_tag<'a>(ex: &'a exif::Exif, tag: exif::Tag) -> Option<&'a exif::Field> {
    ex.fields().find(|f| f.tag == tag)
}

fn orientation_of(ex: &exif::Exif) -> u32 {
    find_tag(ex, exif::Tag::Orientation)
        .and_then(|f| f.value.get_uint(0))
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
    let ex = load(&path)?;
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
    let Some(ex) = load(&path) else {
        return Ok(Response::new(Vec::new()));
    };
    let Some(thumb) = embedded_thumbnail(&ex) else {
        return Ok(Response::new(Vec::new()));
    };
    let Ok(img) = image::load_from_memory(thumb) else {
        return Ok(Response::new(Vec::new()));
    };
    let img = apply_orientation(img, orientation_of(&ex));
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    img.write_with_encoder(enc).map_err(|e| e.to_string())?;
    Ok(Response::new(out))
}

/// 按 EXIF 方向摆正动态图像（仅对 JPEG 路径生效）
pub fn oriented_dynamic(img: DynamicImage, path: &str) -> DynamicImage {
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".jpg") && !lower.ends_with(".jpeg") {
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
