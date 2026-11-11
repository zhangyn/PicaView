// 旋转：JPEG 走 turbojpeg 无损变换（不重编码），其余格式重编码；动图拒绝

use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};

use image::{DynamicImage, ImageFormat};

#[tauri::command]
pub async fn rotate(path: String, clockwise: bool) -> Result<(), String> {
    crate::imgscan::run_blocking(move || rotate_blocking(&path, clockwise)).await
}

fn rotate_blocking(path: &str, clockwise: bool) -> Result<(), String> {
    let (p, ext) = crate::imgscan::checked_image_path(path)?;
    // 同一文件的"读取 → 变换 → 替换"必须串行，否则并发旋转会丢失其中一次
    let _guard = lock_path(&p);
    if matches!(ext.as_str(), "gif" | "webp" | "png") && crate::imgscan::detect_animated(&p, &ext) {
        return Err("动图暂不支持旋转".into());
    }

    // 按内容嗅探真实格式（扩展名可能不可信）
    let fmt = sniff(&p)?;
    crate::imgscan::catch_decode("旋转", || match fmt {
        ImageFormat::Jpeg => rotate_jpeg_lossless(&p, clockwise),
        f => rotate_reencode(&p, f, clockwise),
    })
}

/// 按文件内容（magic bytes）识别格式
fn sniff(p: &Path) -> Result<ImageFormat, String> {
    let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    image::ImageReader::new(std::io::BufReader::new(f))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .format()
        .ok_or_else(|| "无法识别图片格式".to_string())
}

// ---------- 同一路径互斥 ----------

static PATH_LOCKS: LazyLock<(Mutex<HashSet<String>>, Condvar)> =
    LazyLock::new(|| (Mutex::new(HashSet::new()), Condvar::new()));

/// 路径锁的持有者，释放时唤醒等待者
struct PathGuard {
    key: String,
}

/// 获取路径锁（同一路径已被占用时阻塞等待）。Windows 路径不区分大小写，键统一小写。
fn lock_path(p: &Path) -> PathGuard {
    let key = p.to_string_lossy().to_lowercase();
    let (m, cv) = &*PATH_LOCKS;
    let mut set = m.lock().unwrap_or_else(|e| e.into_inner());
    while set.contains(&key) {
        set = cv.wait(set).unwrap_or_else(|e| e.into_inner());
    }
    set.insert(key.clone());
    PathGuard { key }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        let (m, cv) = &*PATH_LOCKS;
        m.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
        cv.notify_all();
    }
}

// ---------- JPEG 无损旋转：EXIF 方向与目标旋转合成 ----------

/// JPEG 无损变换操作（与 turbojpeg::TransformOp 一一对应）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Xform {
    None,
    Hflip,
    Vflip,
    Transpose,
    Transverse,
    Rot90,
    Rot180,
    Rot270,
}

impl Xform {
    const ALL: [Xform; 8] = [
        Xform::None,
        Xform::Hflip,
        Xform::Vflip,
        Xform::Transpose,
        Xform::Transverse,
        Xform::Rot90,
        Xform::Rot180,
        Xform::Rot270,
    ];

    fn to_op(self) -> turbojpeg::TransformOp {
        use turbojpeg::TransformOp as Op;
        match self {
            Xform::None => Op::None,
            Xform::Hflip => Op::Hflip,
            Xform::Vflip => Op::Vflip,
            Xform::Transpose => Op::Transpose,
            Xform::Transverse => Op::Transverse,
            Xform::Rot90 => Op::Rot90,
            Xform::Rot180 => Op::Rot180,
            Xform::Rot270 => Op::Rot270,
        }
    }

    /// 作用在坐标 (x右, y下) 上的 2x2 整数矩阵；8 个变换构成二面体群 D4
    fn matrix(self) -> [[i8; 2]; 2] {
        match self {
            Xform::None => [[1, 0], [0, 1]],
            Xform::Hflip => [[-1, 0], [0, 1]],
            Xform::Vflip => [[1, 0], [0, -1]],
            Xform::Transpose => [[0, 1], [1, 0]],     // 沿主对角线（左上—右下）翻转
            Xform::Transverse => [[0, -1], [-1, 0]],  // 沿副对角线（右上—左下）翻转
            Xform::Rot90 => [[0, -1], [1, 0]],        // 顺时针 90°
            Xform::Rot180 => [[-1, 0], [0, -1]],
            Xform::Rot270 => [[0, 1], [-1, 0]],       // 顺时针 270° = 逆时针 90°
        }
    }

    fn from_matrix(m: [[i8; 2]; 2]) -> Xform {
        Xform::ALL
            .into_iter()
            .find(|x| x.matrix() == m)
            .expect("D4 群对乘法封闭")
    }

    /// 先做 self，再做 after
    fn then(self, after: Xform) -> Xform {
        let (a, b) = (self.matrix(), after.matrix());
        // 结果 = b · a
        let r = [
            [b[0][0] * a[0][0] + b[0][1] * a[1][0], b[0][0] * a[0][1] + b[0][1] * a[1][1]],
            [b[1][0] * a[0][0] + b[1][1] * a[1][0], b[1][0] * a[0][1] + b[1][1] * a[1][1]],
        ];
        Xform::from_matrix(r)
    }
}

/// EXIF 方向值（1..=8）对应的"摆正变换"：把存储像素变换成正确显示方向。
/// 超出范围按 1（不变换）处理。
fn orientation_xform(o: u32) -> Xform {
    match o {
        2 => Xform::Hflip,
        3 => Xform::Rot180,
        4 => Xform::Vflip,
        5 => Xform::Transpose,
        6 => Xform::Rot90,
        7 => Xform::Transverse,
        8 => Xform::Rot270,
        _ => Xform::None,
    }
}

/// 在已有 EXIF 方向 `orientation` 的基础上再旋转 90°，合成为一次存储像素变换。
/// 变换完成后方向标签应复位为 1。
fn compose_rotation(orientation: u32, clockwise: bool) -> Xform {
    let rot = if clockwise { Xform::Rot90 } else { Xform::Rot270 };
    orientation_xform(orientation).then(rot)
}

/// libjpeg-turbo tjTransform：只变换 DCT 系数，像素级无损
fn rotate_jpeg_lossless(p: &Path, clockwise: bool) -> Result<(), String> {
    let src = std::fs::read(p).map_err(|e| e.to_string())?;
    let op = compose_rotation(read_orientation(&src), clockwise).to_op();
    let mut xform = turbojpeg::Transform::op(op);
    // 宽高不是 MCU 整数倍时丢弃无法变换的边缘块，避免边缘出现错位条带
    xform.trim = true;
    // tjTransform 默认复制 EXIF 等 marker（copy_none=false）
    let out = turbojpeg::transform(&xform, &src).map_err(|e| format!("JPEG 旋转失败: {e}"))?;
    let mut out = out.to_vec();
    // 方向已被合并进像素，标签复位为 1
    fix_orientation_to_one(&mut out);
    replace_file(p, &out)
}

fn rotate_reencode(p: &Path, fmt: ImageFormat, clockwise: bool) -> Result<(), String> {
    // 按内容嗅探格式（扩展名可能不可信）；限制取有限的大值以支持超大图
    let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut reader = image::ImageReader::new(std::io::BufReader::new(f));
    reader.limits(crate::imgscan::decode_limits());
    let img = reader
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| format!("解码失败: {e}"))?;
    let img = crate::exifinfo::oriented_dynamic(img, &p.to_string_lossy());
    let rotated: DynamicImage = if clockwise {
        img.rotate90()
    } else {
        img.rotate270()
    };
    let mut out = Vec::new();
    match fmt {
        ImageFormat::WebP => {
            // image 的 WebP 编码器仅支持无损
            let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            let color = image::ExtendedColorType::from(rotated.color());
            enc.encode(rotated.as_bytes(), rotated.width(), rotated.height(), color)
                .map_err(|e| format!("WebP 编码失败: {e}"))?;
        }
        ImageFormat::Png => {
            // 重编码会丢掉 iCCP 之外的辅助块，至少把 ICC 配置文件写回去，避免色彩偏移
            use image::ImageEncoder as _;
            let mut enc = image::codecs::png::PngEncoder::new(&mut out);
            if let Some(icc) = png_icc_profile(p) {
                let _ = enc.set_icc_profile(icc);
            }
            enc.write_image(
                rotated.as_bytes(),
                rotated.width(),
                rotated.height(),
                image::ExtendedColorType::from(rotated.color()),
            )
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
        }
        _ => {
            rotated
                .write_to(&mut Cursor::new(&mut out), fmt)
                .map_err(|e| format!("编码失败: {e}"))?;
        }
    }
    replace_file(p, &out)
}

/// 读取 PNG 内嵌的 ICC 配置文件（没有则 None）。旋转与导出共用
pub(crate) fn png_icc_profile(p: &Path) -> Option<Vec<u8>> {
    use image::ImageDecoder as _;
    let f = std::fs::File::open(p).ok()?;
    let mut dec = image::codecs::png::PngDecoder::new(std::io::BufReader::new(f)).ok()?;
    dec.icc_profile().ok().flatten().filter(|v| !v.is_empty())
}

// ---------- 原子替换 ----------

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 同目录下的唯一临时文件名：`.<原名>.pvtmp-<pid>-<序号>`
fn temp_path_for(p: &Path) -> PathBuf {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    p.with_file_name(format!(".{name}.pvtmp-{}-{seq}", std::process::id()))
}

/// 原子替换：写唯一临时文件 → 直接 rename 覆盖原文件（带重试以避让占用）。
/// std::fs::rename 在 Windows 上以 MOVEFILE_REPLACE_EXISTING 语义覆盖已存在的目标，
/// 因此无需（也不应）先删除旧文件，避免出现"旧文件已删、新文件未就位"的窗口。
fn replace_file(p: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = temp_path_for(p);
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入临时文件失败: {e}"));
    }
    const ATTEMPTS: u32 = 5;
    let mut last_err = None;
    for attempt in 0..ATTEMPTS {
        match std::fs::rename(&tmp, p) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(format!(
        "替换文件失败（可能被其他程序占用）: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

// ---------- EXIF orientation 读取 / 复位为 1（就地改字节，无需重写整个 EXIF） ----------

/// 在 JPEG 的 EXIF APP1 中定位 Orientation 值的 2 字节位置，返回 (偏移, 是否小端)
fn locate_orientation(jpeg: &[u8]) -> Option<(usize, bool)> {
    if jpeg.len() < 16 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return None;
        }
        let marker = jpeg[i + 1];
        match marker {
            0xD8 | 0x01 | 0xD0..=0xD7 => {
                i += 2;
                continue;
            }
            0xDA => return None, // SOS，后面是压缩数据
            _ => {}
        }
        let seg_len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if seg_len < 2 || i + 2 + seg_len > jpeg.len() {
            return None;
        }
        // APP1 且内容以 "Exif\0\0" 开头
        if marker == 0xE1 && i + 10 <= jpeg.len() && &jpeg[i + 4..i + 10] == b"Exif\0\0" {
            if let Some(found) = locate_in_tiff(jpeg, i + 10) {
                return Some(found);
            }
        }
        i += 2 + seg_len;
    }
    None
}

fn locate_in_tiff(jpeg: &[u8], tiff: usize) -> Option<(usize, bool)> {
    if tiff + 8 > jpeg.len() {
        return None;
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
    let ifd0 = tiff.checked_add(rd32(&jpeg[tiff + 4..tiff + 8]) as usize)?;
    if ifd0.checked_add(2)? > jpeg.len() {
        return None;
    }
    let n = rd16(&jpeg[ifd0..ifd0 + 2]) as usize;
    for k in 0..n {
        let e = ifd0 + 2 + k * 12;
        if e + 12 > jpeg.len() {
            return None;
        }
        if rd16(&jpeg[e..e + 2]) == 0x0112 {
            // Orientation: SHORT(3) count 1，值内联在 value 区前 2 字节
            return Some((e + 8, le));
        }
    }
    None
}

/// 读取 JPEG 字节中的 EXIF 方向（1..=8）；缺失或非法时返回 1
fn read_orientation(jpeg: &[u8]) -> u32 {
    let Some((v, le)) = locate_orientation(jpeg) else { return 1 };
    let raw = if le {
        u16::from_le_bytes([jpeg[v], jpeg[v + 1]])
    } else {
        u16::from_be_bytes([jpeg[v], jpeg[v + 1]])
    };
    let o = raw as u32;
    if (1..=8).contains(&o) {
        o
    } else {
        1
    }
}

fn fix_orientation_to_one(jpeg: &mut [u8]) {
    if let Some((v, le)) = locate_orientation(jpeg) {
        if le {
            jpeg[v] = 1;
            jpeg[v + 1] = 0;
        } else {
            jpeg[v] = 0;
            jpeg[v + 1] = 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, GrayImage, Luma};

    // ---------- 方向合成 ----------

    #[test]
    fn compose_table_clockwise() {
        use Xform::*;
        let expect = [Rot90, Transverse, Rot270, Transpose, Hflip, Rot180, Vflip, None];
        for (i, want) in expect.iter().enumerate() {
            assert_eq!(compose_rotation(i as u32 + 1, true), *want, "orientation {}", i + 1);
        }
    }

    #[test]
    fn compose_table_counter_clockwise() {
        use Xform::*;
        let expect = [Rot270, Transpose, Rot90, Transverse, Vflip, None, Hflip, Rot180];
        for (i, want) in expect.iter().enumerate() {
            assert_eq!(compose_rotation(i as u32 + 1, false), *want, "orientation {}", i + 1);
        }
    }

    #[test]
    fn compose_out_of_range_treated_as_one() {
        for o in [0, 9, 100, u32::MAX] {
            assert_eq!(compose_rotation(o, true), Xform::Rot90);
            assert_eq!(compose_rotation(o, false), Xform::Rot270);
        }
    }

    /// 变换结果（方向标签复位为 1）反推出等价的 EXIF 方向值
    fn orientation_of(x: Xform) -> u32 {
        (1..=8).find(|&o| orientation_xform(o) == x).unwrap()
    }

    #[test]
    fn compose_is_self_consistent() {
        for o in 1..=8u32 {
            // 顺时针后再逆时针 = 回到原方向
            let cw = compose_rotation(o, true);
            assert_eq!(compose_rotation(orientation_of(cw), false), orientation_xform(o), "o={o} cw→ccw");
            let ccw = compose_rotation(o, false);
            assert_eq!(compose_rotation(orientation_of(ccw), true), orientation_xform(o), "o={o} ccw→cw");

            // 连续 4 次同向旋转 = 回到原方向
            for dir in [true, false] {
                let mut cur = o;
                for _ in 0..4 {
                    cur = orientation_of(compose_rotation(cur, dir));
                }
                assert_eq!(cur, o, "o={o} dir={dir}");
            }

            // 两次同向旋转 = 在原方向上加 180°
            let twice = orientation_of(compose_rotation(orientation_of(cw), true));
            assert_eq!(orientation_xform(twice), orientation_xform(o).then(Xform::Rot180));

            // 顺时针与逆时针结果不同
            assert_ne!(cw, ccw);
        }
    }

    #[test]
    fn xform_group_closure() {
        // 任意两变换的组合仍是 8 个变换之一（from_matrix 不会 panic），且 None 是单位元
        for a in Xform::ALL {
            assert_eq!(a.then(Xform::None), a);
            assert_eq!(Xform::None.then(a), a);
            for b in Xform::ALL {
                let _ = a.then(b);
            }
        }
        assert_eq!(Xform::Rot90.then(Xform::Rot270), Xform::None);
        assert_eq!(Xform::Hflip.then(Xform::Hflip), Xform::None);
        assert_eq!(Xform::Transpose.then(Xform::Transpose), Xform::None);
    }

    /// 用 image 库在像素层面实现 Xform，作为语义对照
    fn apply_xform(img: &DynamicImage, x: Xform) -> DynamicImage {
        match x {
            Xform::None => img.clone(),
            Xform::Hflip => img.fliph(),
            Xform::Vflip => img.flipv(),
            Xform::Transpose => img.rotate90().fliph(),
            Xform::Transverse => img.rotate90().flipv(),
            Xform::Rot90 => img.rotate90(),
            Xform::Rot180 => img.rotate180(),
            Xform::Rot270 => img.rotate270(),
        }
    }

    fn sample_image() -> DynamicImage {
        // 3x2，每个像素值唯一
        let mut g = GrayImage::new(3, 2);
        for y in 0..2 {
            for x in 0..3 {
                g.put_pixel(x, y, Luma([(y * 3 + x) as u8 + 1]));
            }
        }
        DynamicImage::ImageLuma8(g)
    }

    fn pixels(img: &DynamicImage) -> (u32, u32, Vec<u8>) {
        let (w, h) = img.dimensions();
        (w, h, img.to_luma8().into_raw())
    }

    #[test]
    fn compose_matches_pixel_semantics() {
        // 显示结果 = 对"按方向摆正后的图像"再旋转；
        // 与"对存储像素做合成变换"逐像素一致
        let stored = sample_image();
        for o in 1..=8u32 {
            for cw in [true, false] {
                let displayed = crate::exifinfo::apply_orientation(stored.clone(), o);
                let want = if cw { displayed.rotate90() } else { displayed.rotate270() };
                let got = apply_xform(&stored, compose_rotation(o, cw));
                assert_eq!(pixels(&got), pixels(&want), "o={o} cw={cw}");
            }
        }
    }

    // ---------- EXIF 读写 ----------

    /// 构造最小 JPEG：SOI + APP1(Exif, IFD0 含 Orientation) + SOS 占位
    fn jpeg_with_orientation(o: u16, le: bool) -> Vec<u8> {
        let w16 = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut tiff = Vec::new();
        tiff.extend_from_slice(if le { b"II" } else { b"MM" });
        tiff.extend_from_slice(&w16(0x002A));
        tiff.extend_from_slice(&w32(8)); // IFD0 偏移
        tiff.extend_from_slice(&w16(1)); // 1 个条目
        tiff.extend_from_slice(&w16(0x0112)); // Orientation
        tiff.extend_from_slice(&w16(3)); // SHORT
        tiff.extend_from_slice(&w32(1)); // count
        tiff.extend_from_slice(&w16(o));
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&w32(0)); // 无下一个 IFD

        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE1];
        v.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
        v.extend(app1);
        v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0x00, 0x00]);
        v
    }

    #[test]
    fn read_and_fix_orientation_both_endians() {
        for le in [true, false] {
            for o in 1..=8u16 {
                let mut j = jpeg_with_orientation(o, le);
                assert_eq!(read_orientation(&j), o as u32, "le={le} o={o}");
                fix_orientation_to_one(&mut j);
                assert_eq!(read_orientation(&j), 1, "fixed le={le} o={o}");
                // 复位后其余字节不变：长度一致且仍可定位
                assert_eq!(j.len(), jpeg_with_orientation(o, le).len());
                assert!(locate_orientation(&j).is_some());
            }
        }
    }

    #[test]
    fn invalid_orientation_values_read_as_one() {
        for bad in [0u16, 9, 255, 0xFFFF] {
            assert_eq!(read_orientation(&jpeg_with_orientation(bad, true)), 1);
        }
    }

    #[test]
    fn orientation_missing_or_garbage_is_safe() {
        assert_eq!(read_orientation(&[]), 1);
        assert_eq!(read_orientation(b"not a jpeg at all, just text"), 1);
        // 只有 SOI + SOS，没有 EXIF
        let no_exif = [0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(read_orientation(&no_exif), 1);
        let mut m = no_exif;
        fix_orientation_to_one(&mut m);
        assert_eq!(m, no_exif);
        // 截断的 EXIF：任意截断长度都不应 panic
        let full = jpeg_with_orientation(6, true);
        for n in 0..full.len() {
            let mut cut = full[..n].to_vec();
            let _ = read_orientation(&cut);
            fix_orientation_to_one(&mut cut);
        }
    }

    // ---------- 路径锁 / 临时文件 ----------

    #[test]
    fn temp_paths_are_unique_and_in_same_dir() {
        let p = Path::new("C:\\pics\\a.jpg");
        let a = temp_path_for(p);
        let b = temp_path_for(p);
        assert_ne!(a, b);
        assert_eq!(a.parent(), p.parent());
        assert!(a.file_name().unwrap().to_string_lossy().starts_with(".a.jpg.pvtmp-"));
    }

    #[test]
    fn path_lock_serializes_same_path_case_insensitively() {
        use std::sync::mpsc;
        use std::time::Duration;
        let first = lock_path(Path::new("C:\\Lock\\Test.JPG"));
        let (tx, rx) = mpsc::channel();
        let t = std::thread::spawn(move || {
            let _g = lock_path(Path::new("c:\\lock\\test.jpg"));
            tx.send(()).unwrap();
        });
        // 持有期间另一线程拿不到锁
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        drop(first);
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
        t.join().unwrap();
        // 不同路径互不阻塞
        let _a = lock_path(Path::new("C:\\x\\1.jpg"));
        let _b = lock_path(Path::new("C:\\x\\2.jpg"));
    }

    #[test]
    fn replace_file_overwrites_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("pv-rotate-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("t.jpg");
        std::fs::write(&target, b"old").unwrap();
        replace_file(&target, b"new-content").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new-content");
        let leftovers = std::fs::read_dir(&dir).unwrap().flatten().count();
        assert_eq!(leftovers, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn png_rotation_preserves_icc_profile() {
        use image::ImageEncoder as _;
        let dir = std::env::temp_dir().join(format!("pv-rot-png-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.png");
        let icc: Vec<u8> = (0..64u8).collect();
        {
            let img = image::RgbImage::from_fn(8, 4, |x, y| image::Rgb([x as u8, y as u8, 7]));
            let f = std::fs::File::create(&p).unwrap();
            let mut enc = image::codecs::png::PngEncoder::new(f);
            enc.set_icc_profile(icc.clone()).unwrap();
            enc.write_image(img.as_raw(), 8, 4, image::ExtendedColorType::Rgb8)
                .unwrap();
        }
        // 重编码旋转后：尺寸交换，ICC 仍在
        let fmt = sniff(&p).unwrap();
        rotate_reencode(&p, fmt, true).unwrap();
        let dec = image::load_from_memory(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!((dec.width(), dec.height()), (4, 8));
        assert_eq!(png_icc_profile(&p), Some(icc));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lossless_jpeg_rotation_end_to_end() {
        // 用 image 编码一张 JPEG，写上 EXIF 方向 6，再无损旋转，校验尺寸与方向复位
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_fn(48, 32, |x, y| {
            image::Rgb([(x * 5) as u8, (y * 7) as u8, 128])
        }));
        let mut bytes = Vec::new();
        img.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg).unwrap();
        // 在 SOI 之后插入 EXIF APP1（方向 6）
        let exif = jpeg_with_orientation(6, true);
        let app1_end = exif.len() - 6; // 去掉末尾 SOS 占位
        let mut j = bytes[..2].to_vec();
        j.extend_from_slice(&exif[2..app1_end]);
        j.extend_from_slice(&bytes[2..]);
        assert_eq!(read_orientation(&j), 6);

        let dir = std::env::temp_dir().join(format!("pv-rotate-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("r.jpg");
        std::fs::write(&f, &j).unwrap();

        // 方向 6 + 顺时针 → 合成 Rot180：尺寸不变，方向复位为 1
        rotate_jpeg_lossless(&f, true).unwrap();
        let out = std::fs::read(&f).unwrap();
        assert_eq!(read_orientation(&out), 1);
        let dec = image::load_from_memory(&out).unwrap();
        assert_eq!(dec.dimensions(), (48, 32));

        // 方向 1（再旋转一次后）+ 逆时针 → Rot270：宽高互换
        rotate_jpeg_lossless(&f, false).unwrap();
        let dec = image::load_from_memory(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(dec.dimensions(), (32, 48));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
