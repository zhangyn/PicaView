// 图片详细信息（文件属性 / 图像参数 / EXIF 拍摄信息 / GPS）与"在资源管理器中显示"
// 全程不做完整解码：尺寸只读文件头，格式按魔数嗅探，EXIF 复用 exifinfo::load。

use std::fs;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::exifinfo;

// ---------- 返回结构（字段名 snake_case，缺失为 null） ----------

#[derive(Serialize, Debug)]
pub struct FileSection {
    pub name: String,
    /// 完整路径（不带 \\?\ 前缀）
    pub path: String,
    pub folder: Option<String>,
    pub size: u64,
    /// 毫秒时间戳
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub accessed: Option<u64>,
    pub readonly: bool,
    /// 按文件内容嗅探出的真实格式：JPEG / PNG / GIF / BMP / WebP
    pub format: Option<String>,
    /// 小写扩展名（不含点）
    pub ext: String,
    /// 扩展名与真实格式不符
    pub ext_mismatch: bool,
    pub animated: bool,
}

#[derive(Serialize, Debug)]
pub struct ImageSection {
    /// 显示宽高（JPEG 已按 EXIF 方向摆正）
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub megapixels: Option<f64>,
    /// EXIF 方向 1..=8
    pub orientation: Option<u32>,
    pub dpi_x: Option<f64>,
    pub dpi_y: Option<f64>,
    pub color_space: Option<String>,
    /// 是否内嵌 ICC 配置文件；无法判断的格式为 null
    pub has_icc: Option<bool>,
}

#[derive(Serialize, Debug, Default)]
pub struct ShotSection {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub software: Option<String>,
    pub date_taken: Option<String>,
    /// 如 "1/250 s"
    pub exposure_time: Option<String>,
    /// 如 "f/2.8"
    pub f_number: Option<String>,
    pub iso: Option<u32>,
    /// 如 "24 mm"
    pub focal_length: Option<String>,
    pub focal_length_35mm: Option<u32>,
    /// 如 "+0.7 EV"
    pub exposure_bias: Option<String>,
    pub metering_mode: Option<String>,
    pub flash: Option<String>,
    pub white_balance: Option<String>,
    pub exposure_program: Option<String>,
}

impl ShotSection {
    fn is_empty(&self) -> bool {
        self.make.is_none()
            && self.model.is_none()
            && self.lens.is_none()
            && self.software.is_none()
            && self.date_taken.is_none()
            && self.exposure_time.is_none()
            && self.f_number.is_none()
            && self.iso.is_none()
            && self.focal_length.is_none()
            && self.focal_length_35mm.is_none()
            && self.exposure_bias.is_none()
            && self.metering_mode.is_none()
            && self.flash.is_none()
            && self.white_balance.is_none()
            && self.exposure_program.is_none()
    }
}

#[derive(Serialize, Debug)]
pub struct GpsSection {
    /// 十进制度，南纬为负
    pub latitude: f64,
    /// 十进制度，西经为负
    pub longitude: f64,
    /// 海拔（米），海平面以下为负
    pub altitude: Option<f64>,
}

#[derive(Serialize, Debug)]
pub struct ImageDetails {
    pub file: FileSection,
    pub image: ImageSection,
    /// 无 EXIF（或读取失败）时为 null
    pub shot: Option<ShotSection>,
    pub gps: Option<GpsSection>,
    /// 256 档亮度直方图（由缩略图统计，取不到缩略图时为 null）
    pub histogram_luma: Option<Vec<u32>>,
}

// ---------- 命令 ----------

#[tauri::command]
pub async fn get_image_details(
    app: tauri::AppHandle,
    path: String,
) -> Result<ImageDetails, String> {
    crate::imgscan::run_blocking(move || {
        let mut d = details_blocking(&path)?;
        d.histogram_luma = luma_histogram(&app, &path);
        Ok(d)
    })
    .await
}

/// 用缩略图（240px，通常已在磁盘缓存里）统计亮度直方图：
/// 一次读缓存 + 四万像素，比在主画布上 getImageData 便宜得多，也不影响 GPU 光栅化
fn luma_histogram(app: &tauri::AppHandle, path: &str) -> Option<Vec<u32>> {
    let bytes = crate::thumbs::thumb_bytes_sync(app, path).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    Some(luma_bins(&img.to_luma8()))
}

/// 256 档亮度分布
fn luma_bins(img: &image::GrayImage) -> Vec<u32> {
    let mut bins = vec![0u32; 256];
    for px in img.pixels() {
        bins[px.0[0] as usize] += 1;
    }
    bins
}

/// 在资源管理器中定位并选中文件
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    crate::imgscan::run_blocking(move || reveal_blocking(&path)).await
}

// ---------- 格式嗅探 ----------

/// 按魔数识别格式，返回展示名；无法识别返回 None
fn sniff_format(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("JPEG")
    } else if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("PNG")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("GIF")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("WebP")
    } else if head.starts_with(b"BM") && head.len() >= 14 {
        Some("BMP")
    } else {
        None
    }
}

/// 真实格式对应的规范扩展名（给动图探测用）
fn canonical_ext(fmt: &str) -> &'static str {
    match fmt {
        "JPEG" => "jpg",
        "PNG" => "png",
        "GIF" => "gif",
        "WebP" => "webp",
        _ => "bmp",
    }
}

fn ext_matches_format(ext: &str, fmt: &str) -> bool {
    matches!(
        (fmt, ext),
        ("JPEG", "jpg" | "jpeg") | ("PNG", "png") | ("GIF", "gif") | ("BMP", "bmp") | ("WebP", "webp")
    )
}

fn read_head(p: &Path) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(32);
    fs::File::open(p).ok()?.take(32).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// 只读文件头取像素尺寸（不解码）
fn read_dimensions(p: &Path) -> Option<(u32, u32)> {
    let f = fs::File::open(p).ok()?;
    image::ImageReader::new(BufReader::new(f))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

// ---------- ICC 配置文件探测 ----------

/// 跳过 n 字节；失败视为文件结束
fn skip<R: Seek>(r: &mut R, n: i64) -> bool {
    r.seek(SeekFrom::Current(n)).is_ok()
}

/// JPEG：遍历标记段，找 APP2 中的 "ICC_PROFILE\0"，遇到 SOS / EOI 停止
fn jpeg_has_icc<R: Read + Seek>(r: &mut R) -> bool {
    let mut soi = [0u8; 2];
    if r.read_exact(&mut soi).is_err() || soi != [0xFF, 0xD8] {
        return false;
    }
    let mut b = [0u8; 1];
    for _ in 0..256 {
        // 定位下一个标记：先找到 0xFF，再跳过填充的 0xFF
        loop {
            if r.read_exact(&mut b).is_err() {
                return false;
            }
            if b[0] == 0xFF {
                break;
            }
        }
        let marker = loop {
            if r.read_exact(&mut b).is_err() {
                return false;
            }
            if b[0] != 0xFF {
                break b[0];
            }
        };
        match marker {
            0x00 | 0x01 | 0xD0..=0xD8 => continue, // 无长度的标记
            0xD9 | 0xDA => return false,           // EOI / SOS：之后是图像数据
            _ => {}
        }
        let mut len = [0u8; 2];
        if r.read_exact(&mut len).is_err() {
            return false;
        }
        let len = u16::from_be_bytes(len) as i64;
        if len < 2 {
            return false;
        }
        let body = len - 2;
        if marker == 0xE2 && body >= 12 {
            let mut sig = [0u8; 12];
            if r.read_exact(&mut sig).is_err() {
                return false;
            }
            if &sig == b"ICC_PROFILE\0" {
                return true;
            }
            if !skip(r, body - 12) {
                return false;
            }
        } else if !skip(r, body) {
            return false;
        }
    }
    false
}

/// PNG：遍历块到 IDAT / IEND，找 iCCP
fn png_has_icc<R: Read + Seek>(r: &mut R) -> bool {
    let mut sig = [0u8; 8];
    if r.read_exact(&mut sig).is_err() || sig != *b"\x89PNG\r\n\x1a\n" {
        return false;
    }
    for _ in 0..64 {
        let mut hdr = [0u8; 8];
        if r.read_exact(&mut hdr).is_err() {
            return false;
        }
        let len = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as i64;
        match &hdr[4..8] {
            b"iCCP" => return true,
            b"IDAT" | b"IEND" => return false,
            _ => {}
        }
        if !skip(r, len + 4) {
            return false; // 数据 + CRC
        }
    }
    false
}

/// WebP：遍历 RIFF 块到图像数据为止，找 ICCP
fn webp_has_icc<R: Read + Seek>(r: &mut R) -> bool {
    let mut head = [0u8; 12];
    if r.read_exact(&mut head).is_err() || &head[0..4] != b"RIFF" || &head[8..12] != b"WEBP" {
        return false;
    }
    for _ in 0..64 {
        let mut hdr = [0u8; 8];
        if r.read_exact(&mut hdr).is_err() {
            return false;
        }
        let size = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as i64;
        match &hdr[0..4] {
            b"ICCP" => return true,
            b"VP8 " | b"VP8L" | b"ANMF" => return false,
            _ => {}
        }
        if !skip(r, size + (size & 1)) {
            return false; // 块按偶数字节对齐
        }
    }
    false
}

/// 仅 JPEG / PNG / WebP 能判断；其余格式返回 None
fn has_icc(p: &Path, fmt: Option<&str>) -> Option<bool> {
    let kind = fmt?;
    if !matches!(kind, "JPEG" | "PNG" | "WebP") {
        return None;
    }
    let mut r = BufReader::new(fs::File::open(p).ok()?);
    Some(match kind {
        "JPEG" => jpeg_has_icc(&mut r),
        "PNG" => png_has_icc(&mut r),
        _ => webp_has_icc(&mut r),
    })
}

// ---------- EXIF 取值与格式化 ----------

fn time_ms(t: std::io::Result<SystemTime>) -> Option<u64> {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn round_to(v: f64, decimals: i32) -> f64 {
    let k = 10f64.powi(decimals);
    (v * k).round() / k
}

/// 保留至多 decimals 位小数并去掉末尾的 0
fn trim_num(v: f64, decimals: usize) -> String {
    let s = format!("{:.*}", decimals, v);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

fn field(ex: &exif::Exif, tag: exif::Tag) -> Option<&exif::Field> {
    ex.get_field(tag, exif::In::PRIMARY)
}

fn uint_of(ex: &exif::Exif, tag: exif::Tag) -> Option<u32> {
    field(ex, tag).and_then(|f| f.value.get_uint(0))
}

/// 首个 Rational / SRational 值（分母为 0 等非有限值视为缺失）
fn float_of(ex: &exif::Exif, tag: exif::Tag) -> Option<f64> {
    let v = match &field(ex, tag)?.value {
        exif::Value::Rational(v) => v.first()?.to_f64(),
        exif::Value::SRational(v) => v.first()?.to_f64(),
        _ => return None,
    };
    v.is_finite().then_some(v)
}

/// ASCII 字段：去掉首尾空白与 NUL 填充，空串视为缺失
fn text_of(ex: &exif::Exif, tag: exif::Tag) -> Option<String> {
    match &field(ex, tag)?.value {
        exif::Value::Ascii(v) => {
            let raw = v.first()?;
            let s = String::from_utf8_lossy(raw);
            let s = s.trim_matches(|c: char| c == '\0' || c.is_whitespace());
            (!s.is_empty()).then(|| s.to_string())
        }
        _ => None,
    }
}

fn date_taken_of(ex: &exif::Exif) -> Option<String> {
    match &field(ex, exif::Tag::DateTimeOriginal)?.value {
        exif::Value::Ascii(v) => v
            .first()
            .and_then(|raw| exif::DateTime::from_ascii(raw).ok())
            .map(|dt| dt.to_string()),
        _ => None,
    }
}

/// 曝光时间：短于 1 秒且接近 1/N 时显示为 "1/250 s"，否则显示秒数
fn format_exposure_time(v: f64) -> Option<String> {
    if !v.is_finite() || v <= 0.0 {
        return None;
    }
    if v < 1.0 {
        let d = (1.0 / v).round();
        if d >= 2.0 && (v * d - 1.0).abs() < 0.05 {
            return Some(format!("1/{} s", d as u64));
        }
    }
    Some(format!("{} s", trim_num(v, if v < 1.0 { 2 } else { 1 })))
}

fn format_f_number(v: f64) -> Option<String> {
    (v.is_finite() && v > 0.0).then(|| format!("f/{}", trim_num(v, 1)))
}

fn format_focal_length(v: f64) -> Option<String> {
    (v.is_finite() && v > 0.0).then(|| format!("{} mm", trim_num(v, 1)))
}

fn format_exposure_bias(v: f64) -> Option<String> {
    if !v.is_finite() {
        return None;
    }
    let s = trim_num(v.abs(), 2);
    Some(if s == "0" {
        "0 EV".to_string()
    } else if v > 0.0 {
        format!("+{s} EV")
    } else {
        format!("-{s} EV")
    })
}

fn color_space_text(v: u32) -> Option<&'static str> {
    match v {
        1 => Some("sRGB"),
        2 => Some("Adobe RGB"),
        0xFFFF => Some("未校准"),
        _ => None,
    }
}

fn metering_mode_text(v: u32) -> Option<&'static str> {
    match v {
        1 => Some("平均测光"),
        2 => Some("中央重点平均测光"),
        3 => Some("点测光"),
        4 => Some("多点测光"),
        5 => Some("多区评价测光"),
        6 => Some("局部测光"),
        255 => Some("其他"),
        _ => None,
    }
}

fn white_balance_text(v: u32) -> Option<&'static str> {
    match v {
        0 => Some("自动"),
        1 => Some("手动"),
        _ => None,
    }
}

fn exposure_program_text(v: u32) -> Option<&'static str> {
    match v {
        1 => Some("手动"),
        2 => Some("程序自动"),
        3 => Some("光圈优先"),
        4 => Some("快门优先"),
        5 => Some("创意程序"),
        6 => Some("动作程序"),
        7 => Some("人像模式"),
        8 => Some("风景模式"),
        _ => None,
    }
}

/// Flash 位域：bit0 是否闪光，bit1-2 回闪检测，bit3-4 模式，bit5 无闪光灯，bit6 红眼消除
fn flash_text(v: u32) -> String {
    if v & 0x20 != 0 {
        return "无闪光灯".to_string();
    }
    let base = if v & 0x01 != 0 { "闪光" } else { "未闪光" };
    let mut notes: Vec<&str> = Vec::new();
    match (v >> 3) & 0x03 {
        1 => notes.push("强制闪光"),
        2 => notes.push("强制关闭"),
        3 => notes.push("自动"),
        _ => {}
    }
    if v & 0x40 != 0 {
        notes.push("红眼消除");
    }
    if notes.is_empty() {
        base.to_string()
    } else {
        format!("{base}（{}）", notes.join("，"))
    }
}

/// 度分秒 + 方向 → 带符号十进制度。缺方向、非有限值、负数一律视为缺失
fn gps_coord(ex: &exif::Exif, tag: exif::Tag, ref_tag: exif::Tag, pos: &str, neg: &str) -> Option<f64> {
    let exif::Value::Rational(v) = &field(ex, tag)?.value else {
        return None;
    };
    let deg = v.first()?.to_f64();
    let min = v.get(1).map_or(0.0, |r| r.to_f64());
    let sec = v.get(2).map_or(0.0, |r| r.to_f64());
    dms_to_signed(deg, min, sec, &text_of(ex, ref_tag)?, pos, neg)
}

/// 度分秒 + 半球字母 → 带符号十进制度（保留 6 位小数）。
/// 半球不是 pos / neg 之一、数值非有限或为负，一律返回 None
fn dms_to_signed(deg: f64, min: f64, sec: f64, hemi: &str, pos: &str, neg: &str) -> Option<f64> {
    let val = deg + min / 60.0 + sec / 3600.0;
    if !val.is_finite() || val < 0.0 {
        return None;
    }
    let signed = match hemi.trim().to_ascii_uppercase().as_str() {
        r if r == pos => val,
        r if r == neg => -val,
        _ => return None,
    };
    Some(round_to(signed, 6))
}

/// 海拔：GPSAltitudeRef 为 1 表示海平面以下
fn signed_altitude(a: f64, below_sea_level: bool) -> f64 {
    round_to(if below_sea_level { -a } else { a }, 1)
}

fn gps_of(ex: &exif::Exif) -> Option<GpsSection> {
    let lat = gps_coord(ex, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, "N", "S")?;
    let lon = gps_coord(ex, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, "E", "W")?;
    if lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    // 没有定位时不少相机会写 0/0：(0, 0) 当作无数据
    if lat == 0.0 && lon == 0.0 {
        return None;
    }
    let altitude = float_of(ex, exif::Tag::GPSAltitude)
        .map(|a| signed_altitude(a, uint_of(ex, exif::Tag::GPSAltitudeRef) == Some(1)));
    Some(GpsSection { latitude: lat, longitude: lon, altitude })
}

fn shot_of(ex: &exif::Exif) -> ShotSection {
    ShotSection {
        make: text_of(ex, exif::Tag::Make),
        model: text_of(ex, exif::Tag::Model),
        lens: text_of(ex, exif::Tag::LensModel),
        software: text_of(ex, exif::Tag::Software),
        date_taken: date_taken_of(ex),
        exposure_time: float_of(ex, exif::Tag::ExposureTime).and_then(format_exposure_time),
        f_number: float_of(ex, exif::Tag::FNumber).and_then(format_f_number),
        iso: uint_of(ex, exif::Tag::PhotographicSensitivity).filter(|v| *v > 0),
        focal_length: float_of(ex, exif::Tag::FocalLength).and_then(format_focal_length),
        focal_length_35mm: uint_of(ex, exif::Tag::FocalLengthIn35mmFilm).filter(|v| *v > 0),
        exposure_bias: float_of(ex, exif::Tag::ExposureBiasValue).and_then(format_exposure_bias),
        metering_mode: uint_of(ex, exif::Tag::MeteringMode)
            .and_then(metering_mode_text)
            .map(str::to_string),
        flash: uint_of(ex, exif::Tag::Flash).map(flash_text),
        white_balance: uint_of(ex, exif::Tag::WhiteBalance)
            .and_then(white_balance_text)
            .map(str::to_string),
        exposure_program: uint_of(ex, exif::Tag::ExposureProgram)
            .and_then(exposure_program_text)
            .map(str::to_string),
    }
}

/// 分辨率：XResolution / YResolution 按 ResolutionUnit 换算成 DPI；单位为"无"时不返回
fn dpi_of(ex: &exif::Exif) -> (Option<f64>, Option<f64>) {
    let factor = match uint_of(ex, exif::Tag::ResolutionUnit).unwrap_or(2) {
        2 => 1.0,  // 英寸
        3 => 2.54, // 厘米
        _ => return (None, None),
    };
    let dpi = |tag| {
        float_of(ex, tag)
            .filter(|v| *v > 0.0)
            .map(|v| round_to(v * factor, 2))
    };
    (dpi(exif::Tag::XResolution), dpi(exif::Tag::YResolution))
}

// ---------- 汇总 ----------

fn details_blocking(path: &str) -> Result<ImageDetails, String> {
    let (lp, ext) = crate::imgscan::checked_image_path(path)?;
    let md = fs::metadata(&lp).map_err(|e| format!("读取文件信息失败: {e}"))?;
    // EXIF 解析、尺寸读取遇到损坏文件时可能 panic，统一兜底成错误
    crate::imgscan::catch_decode("读取详细信息", || Ok(build_details(&lp, &ext, &md)))
}

fn build_details(lp: &Path, ext: &str, md: &fs::Metadata) -> ImageDetails {
    let plain = crate::imgscan::plain_path(&lp.to_string_lossy());
    let fmt = read_head(lp).as_deref().and_then(sniff_format);
    let ex = exifinfo::load(&lp.to_string_lossy());

    // 动图探测按真实格式走，扩展名不可信
    let anim_kind: &str = match fmt {
        Some(f) => canonical_ext(f),
        None => ext,
    };
    let animated = crate::imgscan::detect_animated(lp, anim_kind);

    let file = FileSection {
        name: lp
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: plain.to_string_lossy().into_owned(),
        folder: plain.parent().map(|d| d.to_string_lossy().into_owned()),
        size: md.len(),
        created: time_ms(md.created()),
        modified: time_ms(md.modified()),
        accessed: time_ms(md.accessed()),
        readonly: md.permissions().readonly(),
        format: fmt.map(str::to_string),
        ext: ext.to_string(),
        ext_mismatch: fmt.is_some_and(|f| !ext_matches_format(ext, f)),
        animated,
    };

    let orientation = ex
        .as_ref()
        .and_then(|e| uint_of(e, exif::Tag::Orientation))
        .filter(|o| (1..=8).contains(o));
    // 与显示一致：仅 JPEG 按方向摆正（见 exifinfo::oriented_dynamic），方向 5..=8 时宽高互换
    let swap = fmt == Some("JPEG") && orientation.is_some_and(|o| o >= 5);
    let dims = read_dimensions(lp).map(|(w, h)| if swap { (h, w) } else { (w, h) });
    let (dpi_x, dpi_y) = ex.as_ref().map_or((None, None), dpi_of);

    let image = ImageSection {
        width: dims.map(|d| d.0),
        height: dims.map(|d| d.1),
        megapixels: dims.map(|(w, h)| round_to(w as f64 * h as f64 / 1_000_000.0, 2)),
        orientation,
        dpi_x,
        dpi_y,
        color_space: ex
            .as_ref()
            .and_then(|e| uint_of(e, exif::Tag::ColorSpace))
            .and_then(color_space_text)
            .map(str::to_string),
        has_icc: has_icc(lp, fmt),
    };

    let shot = ex.as_ref().map(shot_of).filter(|s| !s.is_empty());
    let gps = ex.as_ref().and_then(gps_of);

    ImageDetails {
        file,
        image,
        shot,
        gps,
        histogram_luma: None, // 由命令层补（需要 AppHandle 定位缩略图缓存）
    }
}

// ---------- 资源管理器定位 ----------

/// 拼 explorer 的 `/select,"<path>"` 参数。Windows 文件名不允许含 `"`，
/// 这里仍显式拒绝，保证引号不会被路径内容截断
fn select_arg(plain: &Path) -> Result<String, String> {
    let s = plain.to_string_lossy();
    if s.contains('"') {
        return Err("路径包含非法字符".into());
    }
    Ok(format!("/select,\"{s}\""))
}

fn reveal_blocking(path: &str) -> Result<(), String> {
    let (lp, _) = crate::imgscan::checked_image_path(path)?;
    // explorer 的 /select 不认 \\?\ 前缀
    let plain = crate::imgscan::plain_path(&lp.to_string_lossy());
    let arg = select_arg(&plain)?;
    spawn_explorer(&arg)
}

#[cfg(windows)]
fn spawn_explorer(arg: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    // 用 %SystemRoot% 下的绝对路径，避免 CreateProcess 先搜索应用目录
    let exe = std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join("explorer.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("explorer.exe"));
    // raw_arg：原样传递，不让 Rust 再对空格/逗号/引号做转义；不经 shell。
    // explorer 即使成功也常返回退出码 1，所以只 spawn 不检查退出状态
    std::process::Command::new(exe)
        .raw_arg(arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开资源管理器: {e}"))
}

#[cfg(not(windows))]
fn spawn_explorer(_arg: &str) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::path::PathBuf;

    #[test]
    fn luma_bins_counts_every_pixel() {
        let img = image::GrayImage::from_raw(2, 2, vec![0, 0, 128, 255]).unwrap();
        let bins = luma_bins(&img);
        assert_eq!(bins.len(), 256);
        assert_eq!(bins[0], 2);
        assert_eq!(bins[128], 1);
        assert_eq!(bins[255], 1);
        assert_eq!(bins.iter().sum::<u32>(), 4);
        // 全黑图不应越界/溢出
        let black = image::GrayImage::new(1, 1);
        assert_eq!(luma_bins(&black).iter().sum::<u32>(), 1);
    }

    #[test]
    fn sniff_by_magic() {
        assert_eq!(sniff_format(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("JPEG"));
        assert_eq!(sniff_format(b"\x89PNG\r\n\x1a\n\0\0"), Some("PNG"));
        assert_eq!(sniff_format(b"GIF89a\x01\0"), Some("GIF"));
        assert_eq!(sniff_format(b"GIF87a\x01\0"), Some("GIF"));
        assert_eq!(sniff_format(b"RIFF\x10\0\0\0WEBPVP8 "), Some("WebP"));
        assert_eq!(sniff_format(b"BM\0\0\0\0\0\0\0\0\0\0\0\0\0\0"), Some("BMP"));
        assert_eq!(sniff_format(b"BM"), None);
        assert_eq!(sniff_format(b"RIFF\x10\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_format(&[]), None);
    }

    #[test]
    fn ext_vs_format() {
        assert!(ext_matches_format("jpg", "JPEG"));
        assert!(ext_matches_format("jpeg", "JPEG"));
        assert!(ext_matches_format("webp", "WebP"));
        assert!(!ext_matches_format("png", "JPEG"));
        assert!(!ext_matches_format("jpg", "GIF"));
    }

    #[test]
    fn exposure_time_formats() {
        assert_eq!(format_exposure_time(1.0 / 250.0).as_deref(), Some("1/250 s"));
        assert_eq!(format_exposure_time(10.0 / 2500.0).as_deref(), Some("1/250 s"));
        assert_eq!(format_exposure_time(0.5).as_deref(), Some("1/2 s"));
        assert_eq!(format_exposure_time(1.0 / 3.0).as_deref(), Some("1/3 s"));
        assert_eq!(format_exposure_time(0.3).as_deref(), Some("0.3 s"));
        assert_eq!(format_exposure_time(0.9).as_deref(), Some("0.9 s"));
        assert_eq!(format_exposure_time(2.0).as_deref(), Some("2 s"));
        assert_eq!(format_exposure_time(2.5).as_deref(), Some("2.5 s"));
        assert_eq!(format_exposure_time(0.0), None);
        assert_eq!(format_exposure_time(f64::INFINITY), None);
    }

    #[test]
    fn misc_formats() {
        assert_eq!(format_f_number(2.8).as_deref(), Some("f/2.8"));
        assert_eq!(format_f_number(4.0).as_deref(), Some("f/4"));
        assert_eq!(format_f_number(0.0), None);
        assert_eq!(format_focal_length(24.0).as_deref(), Some("24 mm"));
        assert_eq!(format_focal_length(5.6).as_deref(), Some("5.6 mm"));
        assert_eq!(format_exposure_bias(0.0).as_deref(), Some("0 EV"));
        assert_eq!(format_exposure_bias(0.001).as_deref(), Some("0 EV"));
        assert_eq!(format_exposure_bias(0.67).as_deref(), Some("+0.67 EV"));
        assert_eq!(format_exposure_bias(-1.0).as_deref(), Some("-1 EV"));
        assert_eq!(format_exposure_bias(f64::NAN), None);
    }

    #[test]
    fn enum_texts() {
        assert_eq!(color_space_text(1), Some("sRGB"));
        assert_eq!(color_space_text(0xFFFF), Some("未校准"));
        assert_eq!(color_space_text(7), None);
        assert_eq!(metering_mode_text(5), Some("多区评价测光"));
        assert_eq!(metering_mode_text(0), None);
        assert_eq!(white_balance_text(0), Some("自动"));
        assert_eq!(exposure_program_text(3), Some("光圈优先"));
        assert_eq!(exposure_program_text(0), None);
    }

    #[test]
    fn flash_bits() {
        assert_eq!(flash_text(0x00), "未闪光");
        assert_eq!(flash_text(0x01), "闪光");
        assert_eq!(flash_text(0x10), "未闪光（强制关闭）");
        assert_eq!(flash_text(0x18), "未闪光（自动）");
        assert_eq!(flash_text(0x19), "闪光（自动）");
        assert_eq!(flash_text(0x09), "闪光（强制闪光）");
        assert_eq!(flash_text(0x59), "闪光（自动，红眼消除）");
        assert_eq!(flash_text(0x20), "无闪光灯");
    }

    #[test]
    fn jpeg_icc_scan() {
        // SOI + APP1(4 字节内容) + APP2(ICC) + SOS
        let mut with = vec![0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x06, 1, 2, 3, 4];
        with.extend_from_slice(&[0xFF, 0xE2, 0x00, 0x12]);
        with.extend_from_slice(b"ICC_PROFILE\0");
        with.extend_from_slice(&[1, 1, 0, 0]);
        with.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);
        assert!(jpeg_has_icc(&mut Cursor::new(with)));

        // 另一个 APP2（如 MPF）不算
        let mut other = vec![0xFF, 0xD8, 0xFF, 0xE2, 0x00, 0x10];
        other.extend_from_slice(b"MPF\0xxxxxxxxx");
        other.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);
        assert!(!jpeg_has_icc(&mut Cursor::new(other)));

        assert!(!jpeg_has_icc(&mut Cursor::new(vec![0xFF, 0xD8, 0xFF, 0xDA, 0, 2])));
        assert!(!jpeg_has_icc(&mut Cursor::new(Vec::<u8>::new())));
        assert!(!jpeg_has_icc(&mut Cursor::new(b"not a jpeg".to_vec())));
        // 段长声称极大：安全返回
        assert!(!jpeg_has_icc(&mut Cursor::new(vec![0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 0])));
    }

    fn png_with(chunks: &[(&[u8; 4], usize)]) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        for (k, n) in chunks {
            v.extend_from_slice(&(*n as u32).to_be_bytes());
            v.extend_from_slice(*k);
            v.resize(v.len() + *n + 4, 0);
        }
        v
    }

    #[test]
    fn png_icc_scan() {
        assert!(png_has_icc(&mut Cursor::new(png_with(&[(b"IHDR", 13), (b"iCCP", 20), (b"IDAT", 4)]))));
        assert!(!png_has_icc(&mut Cursor::new(png_with(&[(b"IHDR", 13), (b"IDAT", 4), (b"iCCP", 20)]))));
        assert!(!png_has_icc(&mut Cursor::new(Vec::<u8>::new())));
    }

    fn webp_with(chunks: &[(&[u8; 4], usize)]) -> Vec<u8> {
        let mut v = b"RIFF\0\0\0\0WEBP".to_vec();
        for (k, n) in chunks {
            v.extend_from_slice(*k);
            v.extend_from_slice(&(*n as u32).to_le_bytes());
            v.resize(v.len() + *n + (*n & 1), 0);
        }
        v
    }

    #[test]
    fn webp_icc_scan() {
        assert!(webp_has_icc(&mut Cursor::new(webp_with(&[(b"VP8X", 10), (b"ICCP", 33), (b"VP8 ", 8)]))));
        assert!(!webp_has_icc(&mut Cursor::new(webp_with(&[(b"VP8X", 10), (b"VP8 ", 8), (b"ICCP", 4)]))));
        assert!(!webp_has_icc(&mut Cursor::new(Vec::<u8>::new())));
    }

    #[test]
    fn gps_dms_conversion() {
        // 39°54'15.12" N = 39.9042
        assert_eq!(dms_to_signed(39.0, 54.0, 15.12, "N", "N", "S"), Some(39.9042));
        assert_eq!(dms_to_signed(39.0, 54.0, 15.12, "S", "N", "S"), Some(-39.9042));
        // 116°24'26.64" E / W
        assert_eq!(dms_to_signed(116.0, 24.0, 26.64, "E", "E", "W"), Some(116.4074));
        assert_eq!(dms_to_signed(116.0, 24.0, 26.64, "w", "E", "W"), Some(-116.4074));
        // 前后空白、小写容忍
        assert_eq!(dms_to_signed(10.0, 30.0, 0.0, " n ", "N", "S"), Some(10.5));
        // 半球缺失 / 不匹配 / 数值异常
        assert_eq!(dms_to_signed(10.0, 0.0, 0.0, "", "N", "S"), None);
        assert_eq!(dms_to_signed(10.0, 0.0, 0.0, "E", "N", "S"), None);
        assert_eq!(dms_to_signed(f64::NAN, 0.0, 0.0, "N", "N", "S"), None);
        assert_eq!(dms_to_signed(-1.0, 0.0, 0.0, "N", "N", "S"), None);
        // 0° 的南半球 → 0（不是 -0 显示问题：数值相等）
        assert_eq!(dms_to_signed(0.0, 0.0, 0.0, "S", "N", "S"), Some(0.0));
    }

    #[test]
    fn gps_altitude_sign() {
        assert_eq!(signed_altitude(12.34, false), 12.3);
        assert_eq!(signed_altitude(12.36, true), -12.4);
        assert_eq!(signed_altitude(0.0, false), 0.0);
    }

    #[test]
    fn select_arg_quotes_path() {
        let p = PathBuf::from("C:\\My Pics\\a, b (1).jpg");
        assert_eq!(select_arg(&p).unwrap(), "/select,\"C:\\My Pics\\a, b (1).jpg\"");
        assert!(select_arg(&PathBuf::from("C:\\a\"b.jpg")).is_err());
    }

    #[test]
    fn details_for_png_with_wrong_extension() {
        let dir = std::env::temp_dir().join(format!("pv-details-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let png = dir.join("real.png");
        image::RgbImage::new(4, 3).save(&png).unwrap();
        // 同一份 PNG 内容，换成 .jpg 扩展名
        let fake = dir.join("fake.jpg");
        fs::copy(&png, &fake).unwrap();

        let d = details_blocking(&png.to_string_lossy()).unwrap();
        assert_eq!(d.file.name, "real.png");
        assert_eq!(d.file.format.as_deref(), Some("PNG"));
        assert!(!d.file.ext_mismatch);
        assert!(!d.file.animated);
        assert_eq!((d.image.width, d.image.height), (Some(4), Some(3)));
        assert_eq!(d.image.megapixels, Some(0.0));
        assert_eq!(d.image.has_icc, Some(false));
        assert!(d.shot.is_none() && d.gps.is_none());
        assert!(d.file.modified.is_some());
        assert!(d.file.folder.is_some());

        let d = details_blocking(&fake.to_string_lossy()).unwrap();
        assert_eq!(d.file.format.as_deref(), Some("PNG"));
        assert!(d.file.ext_mismatch);
        assert_eq!(d.file.ext, "jpg");

        assert_eq!(
            details_blocking(&dir.join("none.png").to_string_lossy()).unwrap_err(),
            "文件不存在"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
