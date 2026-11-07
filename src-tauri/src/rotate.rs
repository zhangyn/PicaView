// 旋转：JPEG 走 turbojpeg 无损变换（不重编码），其余格式重编码；动图拒绝

use std::io::Cursor;
use std::path::Path;

use image::DynamicImage;

#[tauri::command]
pub async fn rotate(path: String, clockwise: bool) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err("文件不存在".into());
    }
    let ext = crate::imgscan::ext_of(p).ok_or("无扩展名")?;
    if !crate::imgscan::is_image_ext(&ext) {
        return Err("不是支持的图片格式".into());
    }
    if matches!(ext.as_str(), "gif" | "webp" | "png")
        && crate::imgscan::detect_animated(p, &ext)
    {
        return Err("动图暂不支持旋转".into());
    }

    match ext.as_str() {
        "jpg" | "jpeg" => rotate_jpeg_lossless(p, clockwise),
        _ => rotate_reencode(p, &ext, clockwise),
    }
}

/// libjpeg-turbo tjTransform：只变换 DCT 系数，像素级无损
fn rotate_jpeg_lossless(p: &Path, clockwise: bool) -> Result<(), String> {
    let src = std::fs::read(p).map_err(|e| e.to_string())?;
    let xform = turbojpeg::Transform::op(if clockwise {
        turbojpeg::TransformOp::Rot90
    } else {
        turbojpeg::TransformOp::Rot270
    });
    // tjTransform 默认复制 EXIF 等 marker（copy_none=false）
    let out =
        turbojpeg::transform(&xform, &src).map_err(|e| format!("JPEG 旋转失败: {e}"))?;
    let mut out = out.to_vec();
    // 方向信息已过时，复位为 1
    fix_orientation_to_one(&mut out);
    replace_file(p, &out)
}

fn rotate_reencode(p: &Path, ext: &str, clockwise: bool) -> Result<(), String> {
    let img = image::open(p).map_err(|e| format!("解码失败: {e}"))?;
    let img = crate::exifinfo::oriented_dynamic(img, &p.to_string_lossy());
    let rotated: DynamicImage = if clockwise {
        img.rotate90()
    } else {
        img.rotate270()
    };
    let mut out = Vec::new();
    match ext {
        "webp" => {
            // image 的 WebP 编码器仅支持无损
            let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            let color = image::ExtendedColorType::from(rotated.color());
            enc.encode(rotated.as_bytes(), rotated.width(), rotated.height(), color)
                .map_err(|e| format!("WebP 编码失败: {e}"))?;
        }
        fmt_name => {
            let fmt = match fmt_name {
                "png" => image::ImageFormat::Png,
                "bmp" => image::ImageFormat::Bmp,
                "gif" => image::ImageFormat::Gif,
                _ => return Err("不支持的格式".into()),
            };
            rotated
                .write_to(&mut Cursor::new(&mut out), fmt)
                .map_err(|e| format!("编码失败: {e}"))?;
        }
    }
    replace_file(p, &out)
}

/// 原子替换：写临时文件 → 删除旧文件 → 改名（带重试以避让占用）
fn replace_file(p: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = p.with_extension(format!(
        "{}pvtmp-{}",
        p.extension().and_then(|e| e.to_str()).unwrap_or(""),
        std::process::id()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    let mut last_err = None;
    for _ in 0..5 {
        // 目标不存在时 rename 直接成功
        if std::fs::rename(&tmp, p).is_ok() {
            return Ok(());
        }
        // Windows 上目标存在则需先删（asset 协议可能瞬时占用，重试避让）
        match std::fs::remove_file(p).and_then(|_| std::fs::rename(&tmp, p)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(format!(
        "替换文件失败（可能被其他程序占用）: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

// ---------- EXIF orientation 复位为 1（就地改字节，无需重写整个 EXIF） ----------

fn fix_orientation_to_one(jpeg: &mut [u8]) {
    if jpeg.len() < 16 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return;
    }
    let mut i = 2usize;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return;
        }
        let marker = jpeg[i + 1];
        match marker {
            0xD8 | 0x01 | 0xD0..=0xD7 => {
                i += 2;
                continue;
            }
            0xDA => return, // SOS，后面是压缩数据
            _ => {}
        }
        let seg_len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if seg_len < 2 || i + 2 + seg_len > jpeg.len() {
            return;
        }
        // APP1 且内容以 "Exif\0\0" 开头
        if marker == 0xE1
            && i + 10 <= jpeg.len()
            && &jpeg[i + 4..i + 10] == b"Exif\0\0"
        {
            if set_orientation_in_tiff(jpeg, i + 10) {
                return;
            }
        }
        i += 2 + seg_len;
    }
}

fn set_orientation_in_tiff(jpeg: &mut [u8], tiff: usize) -> bool {
    if tiff + 8 > jpeg.len() {
        return false;
    }
    let le = &jpeg[tiff..tiff + 2] == b"II";
    let rd16 = |b: &[u8]| {
        if le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        }
    };
    let rd32 = |b: &[u8]| {
        if le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        }
    };
    let ifd0 = tiff + rd32(&jpeg[tiff + 4..tiff + 8]) as usize;
    if ifd0 + 2 > jpeg.len() {
        return false;
    }
    let n = rd16(&jpeg[ifd0..ifd0 + 2]) as usize;
    for k in 0..n {
        let e = ifd0 + 2 + k * 12;
        if e + 12 > jpeg.len() {
            return false;
        }
        if rd16(&jpeg[e..e + 2]) == 0x0112 {
            // Orientation: SHORT(3) count 1，值内联在 value 区前 2 字节
            let v = e + 8;
            if le {
                jpeg[v] = 1;
                jpeg[v + 1] = 0;
            } else {
                jpeg[v] = 0;
                jpeg[v + 1] = 1;
            }
            return true;
        }
    }
    false
}
