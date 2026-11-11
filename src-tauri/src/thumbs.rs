// 缩略图生成 + 磁盘缓存（240px JPEG）

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::ipc::Response;
use tauri::Manager;

const THUMB_MAX: u32 = 240;
/// 同时解码的缩略图任务上限
const MAX_CONCURRENT: usize = 3;
/// 缓存文件超过此时长未被访问/修改则清理
const CACHE_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);
/// 缓存目录总大小上限，超出后按最旧优先清理
const CACHE_MAX_TOTAL: u64 = 500 * 1024 * 1024;
/// 缓存命中且文件超过此时长未更新时，刷新其修改时间（供 LRU 清理判断）
const TOUCH_AFTER: Duration = Duration::from_secs(24 * 3600);

static GEN_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(MAX_CONCURRENT);

/// 64 位 FNV-1a（算法固定，缓存键在不同 Rust 版本间保持稳定）
fn fnv1a64(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for part in parts {
        for &b in *part {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

/// 缓存键 = hash(路径 + mtime纳秒 + 大小)，文件一变自动失效
fn cache_key(path: &str, mtime_nanos: u128, size: u64) -> u64 {
    fnv1a64(&[
        path.as_bytes(),
        &[0xFF], // 分隔符，避免路径与数值拼接产生歧义
        &mtime_nanos.to_le_bytes(),
        &size.to_le_bytes(),
    ])
}

enum Lookup {
    Hit(Vec<u8>),
    Miss { src: PathBuf, cache_file: PathBuf },
}

/// 校验输入并查询磁盘缓存（同步，需在阻塞线程调用）
fn lookup(path: &str, cache_dir: &Path) -> Result<Lookup, String> {
    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let (src, _) = crate::imgscan::checked_image_path(path)?;
    let md = std::fs::metadata(&src).map_err(|e| e.to_string())?;
    let mtime = md
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let cache_file = cache_dir.join(format!("{:016x}.jpg", cache_key(path, mtime, md.len())));

    if let Ok(bytes) = std::fs::read(&cache_file) {
        if !bytes.is_empty() {
            touch_if_stale(&cache_file);
            return Ok(Lookup::Hit(bytes));
        }
    }
    Ok(Lookup::Miss { src, cache_file })
}

/// 命中缓存时刷新修改时间（最多每天一次），让常用缩略图不被按龄清理
fn touch_if_stale(file: &Path) {
    let stale = std::fs::metadata(file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age > TOUCH_AFTER);
    if stale {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(file) {
            let _ = f.set_modified(SystemTime::now());
        }
    }
}

/// 解码 + 缩放 + 写缓存（同步，需在阻塞线程调用）
fn generate_and_store(src: &Path, cache_file: &Path) -> Result<Vec<u8>, String> {
    let bytes = crate::imgscan::catch_decode("生成缩略图", || generate(src))?;
    let _ = std::fs::write(cache_file, &bytes);
    Ok(bytes)
}

#[tauri::command]
pub async fn thumbnail(app: tauri::AppHandle, path: String) -> Result<Response, String> {
    let t0 = std::time::Instant::now();
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");

    // 阶段 1：校验 + 查缓存（很快，不占并发名额）
    let (p1, d1) = (path.clone(), cache_dir.clone());
    let looked = crate::imgscan::run_blocking(move || lookup(&p1, &d1)).await;
    let (src, cache_file) = match looked {
        Ok(Lookup::Hit(bytes)) => return Ok(Response::new(bytes)),
        Ok(Lookup::Miss { src, cache_file }) => (src, cache_file),
        Err(e) => {
            crate::imgscan::diag_log(&app, &format!("THUMB FAIL {path}: {e}"));
            return Err(e);
        }
    };

    // 阶段 2：限制并发的解码
    let _permit = GEN_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    match crate::imgscan::run_blocking(move || generate_and_store(&src, &cache_file)).await {
        Ok(bytes) => {
            crate::imgscan::diag_log(
                &app,
                &format!("THUMB OK {} ({}B, {}ms)", path, bytes.len(), t0.elapsed().as_millis()),
            );
            Ok(Response::new(bytes))
        }
        Err(e) => {
            crate::imgscan::diag_log(&app, &format!("THUMB FAIL {path}: {e}"));
            Err(e)
        }
    }
}

fn generate(p: &Path) -> Result<Vec<u8>, String> {
    // JPEG 先走 turbojpeg 的 DCT 域缩放解码：只解到接近目标尺寸，
    // 峰值内存与耗时都远低于"整图解码再缩"；失败（非 JPEG/损坏）则退回通用解码
    let img = match jpeg_scaled(p, THUMB_MAX as usize) {
        Ok(img) => img,
        Err(_) => decode_full(p)?,
    };
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

/// 通用解码（按内容嗅探格式）：网上下载的图常见「.png 扩展名 + JPEG 内容」
fn decode_full(p: &Path) -> Result<image::DynamicImage, String> {
    let f = std::fs::File::open(p).map_err(|e| format!("打开失败: {e}"))?;
    let mut reader = image::ImageReader::new(std::io::BufReader::new(f));
    // 超大壁纸海报解码后立即缩到 240px；限制为有限的大值，防止恶意/损坏文件耗尽内存
    reader.limits(crate::imgscan::decode_limits());
    let img = reader
        .with_guessed_format()
        .map_err(|e| format!("格式识别失败: {e}"))?
        .decode()
        .map_err(|e| format!("解码失败: {e}"))?;
    Ok(crate::exifinfo::oriented_dynamic(img, &p.to_string_lossy()))
}

/// turbojpeg 缩放解码（仅 JPEG）：按需选最小缩放档，并按 EXIF 方向摆正
fn jpeg_scaled(p: &Path, target: usize) -> Result<image::DynamicImage, String> {
    let data = std::fs::read(p).map_err(|e| e.to_string())?;
    if !data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err("不是 JPEG".into());
    }
    let mut dec = turbojpeg::Decompressor::new().map_err(|e| e.to_string())?;
    let header = dec.read_header(&data).map_err(|e| e.to_string())?;
    let max_dim = crate::imgscan::MAX_DIMENSION as usize;
    if header.width > max_dim || header.height > max_dim {
        return Err("图像尺寸超出上限".into());
    }
    let factor = pick_scale(header.width, header.height, target);
    let size = header.scaled(factor);
    // 与 decode_limits 的 max_alloc 对齐：极端情况下（无合适缩放档）也别一次吃掉上 GB
    if size.width.saturating_mul(size.height).saturating_mul(3) > (1 << 30) {
        return Err("解码结果过大".into());
    }
    dec.set_scaling_factor(factor).map_err(|e| e.to_string())?;
    let pitch = size.width * 3;
    let mut pixels = vec![0u8; pitch * size.height];
    dec.decompress(
        &data,
        turbojpeg::Image {
            pixels: pixels.as_mut_slice(),
            width: size.width,
            height: size.height,
            pitch,
            format: turbojpeg::PixelFormat::RGB,
        },
    )
    .map_err(|e| e.to_string())?;
    let rgb = image::RgbImage::from_raw(size.width as u32, size.height as u32, pixels)
        .ok_or_else(|| "解码结果尺寸异常".to_string())?;
    let orientation = crate::exifinfo::orientation_of_bytes(&data);
    Ok(crate::exifinfo::apply_orientation(
        image::DynamicImage::ImageRgb8(rgb),
        orientation,
    ))
}

/// 选最小缩放档位，但解码后长边仍不小于 target（不放大、不过度解码）
fn pick_scale(w: usize, h: usize, target: usize) -> turbojpeg::ScalingFactor {
    let ratio = |f: turbojpeg::ScalingFactor| f.num() as f64 / f.denom() as f64;
    let longest = w.max(h);
    if longest <= target {
        return turbojpeg::ScalingFactor::ONE;
    }
    let mut best = turbojpeg::ScalingFactor::ONE;
    for f in turbojpeg::Decompressor::supported_scaling_factors() {
        let r = ratio(f);
        if r >= 1.0 || r >= ratio(best) {
            continue;
        }
        if (longest as f64 * r).round() as usize >= target {
            best = f;
        }
    }
    best
}

// ---------- 缓存清理 ----------

/// 计算需要淘汰的文件下标：先删超龄的，剩余总量仍超限则按最旧优先继续删。
/// `files` 为 (大小, 距上次访问/修改的时长)。
fn plan_eviction(files: &[(u64, Duration)], max_age: Duration, max_total: u64) -> Vec<usize> {
    let mut evict: Vec<usize> = Vec::new();
    let mut keep: Vec<usize> = Vec::new();
    for (i, (_, age)) in files.iter().enumerate() {
        if *age > max_age {
            evict.push(i);
        } else {
            keep.push(i);
        }
    }
    let mut total: u64 = keep.iter().map(|&i| files[i].0).sum();
    if total > max_total {
        // 最旧（age 最大）优先
        keep.sort_by(|&a, &b| files[b].1.cmp(&files[a].1));
        for i in keep {
            if total <= max_total {
                break;
            }
            total = total.saturating_sub(files[i].0);
            evict.push(i);
        }
    }
    evict
}

/// 清理缓存目录，返回删除的文件数
fn cleanup_cache(dir: &Path, now: SystemTime, max_age: Duration, max_total: u64) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut info: Vec<(u64, Duration)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jpg") {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        // 访问时间在部分系统上不更新，取修改/访问时间中较新者
        let last = [md.modified().ok(), md.accessed().ok()].into_iter().flatten().max();
        let age = last
            .and_then(|t| now.duration_since(t).ok())
            .unwrap_or_default();
        paths.push(path);
        info.push((md.len(), age));
    }
    plan_eviction(&info, max_age, max_total)
        .into_iter()
        .filter(|&i| std::fs::remove_file(&paths[i]).is_ok())
        .count()
}

/// 启动时在后台线程清理缩略图缓存，不阻塞启动
pub fn spawn_cache_cleanup(app: tauri::AppHandle) {
    let Ok(dir) = app.path().app_cache_dir().map(|d| d.join("thumbs")) else { return };
    let _ = std::thread::Builder::new()
        .name("thumb-cache-gc".into())
        .spawn(move || {
            let n = cleanup_cache(&dir, SystemTime::now(), CACHE_MAX_AGE, CACHE_MAX_TOTAL);
            crate::imgscan::diag_log(&app, &format!("THUMB GC 清理 {n} 个缓存文件"));
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a64_known_vectors() {
        assert_eq!(fnv1a64(&[b""]), 0xcbf29ce484222325);
        assert_eq!(fnv1a64(&[b"a"]), 0xaf63dc4c8601ec8c);
        assert_eq!(fnv1a64(&[b"foobar"]), 0x85944171f73967e8);
        // 分段输入与整体输入等价
        assert_eq!(fnv1a64(&[b"foo", b"bar"]), 0x85944171f73967e8);
    }

    #[test]
    fn cache_key_is_stable_and_sensitive() {
        let k = cache_key("C:\\a.jpg", 123, 456);
        assert_eq!(k, cache_key("C:\\a.jpg", 123, 456));
        assert_ne!(k, cache_key("C:\\b.jpg", 123, 456));
        assert_ne!(k, cache_key("C:\\a.jpg", 124, 456));
        assert_ne!(k, cache_key("C:\\a.jpg", 123, 457));
    }

    const DAY: Duration = Duration::from_secs(24 * 3600);

    #[test]
    fn pick_scale_never_overdecodes_or_undershoots() {
        // 小图不缩放
        assert_eq!(pick_scale(240, 120, 240), turbojpeg::ScalingFactor::ONE);
        assert_eq!(pick_scale(240, 240, 240), turbojpeg::ScalingFactor::ONE);
        for (w, h) in [(4000, 3000), (300, 3000), (12000, 9000), (241, 1000)] {
            let f = pick_scale(w, h, 240);
            let r = f.num() as f64 / f.denom() as f64;
            let scaled = (w.max(h) as f64 * r).round() as usize;
            assert!(r <= 1.0, "{w}x{h}");
            assert!(scaled >= 240, "{w}x{h} → {scaled}");
            assert!(scaled <= 240 * 8, "{w}x{h} → {scaled}（过度解码）");
        }
    }

    #[test]
    fn generate_produces_240px_for_jpeg_and_png() {
        let dir = std::env::temp_dir().join(format!("pv-thumb-gen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let img = image::RgbImage::from_fn(1200, 800, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        for name in ["big.jpg", "big.png"] {
            let p = dir.join(name);
            img.save(&p).unwrap();
            let bytes = generate(&p).unwrap();
            let dec = image::load_from_memory(&bytes).unwrap();
            assert_eq!(dec.width().max(dec.height()), THUMB_MAX, "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eviction_by_age() {
        let files = [(10, DAY * 5), (10, DAY * 31), (10, DAY * 40), (10, DAY * 30)];
        let mut ev = plan_eviction(&files, DAY * 30, u64::MAX);
        ev.sort();
        assert_eq!(ev, vec![1, 2]);
    }

    #[test]
    fn eviction_by_total_size_oldest_first() {
        // 总量 400，上限 250：需删到 <=250，按最旧优先
        let files = [(100, DAY * 1), (100, DAY * 9), (100, DAY * 5), (100, DAY * 7)];
        let ev = plan_eviction(&files, DAY * 30, 250);
        assert_eq!(ev, vec![1, 3]); // age 9 天、7 天
    }

    #[test]
    fn eviction_age_then_size() {
        let files = [(100, DAY * 40), (100, DAY * 2), (100, DAY * 3)];
        // 超龄的先删；剩余 200 > 150，再删最旧的剩余项（3 天）
        let ev = plan_eviction(&files, DAY * 30, 150);
        assert_eq!(ev, vec![0, 2]);
    }

    #[test]
    fn eviction_nothing_when_within_limits() {
        let files = [(100, DAY), (100, DAY * 2)];
        assert!(plan_eviction(&files, DAY * 30, 1000).is_empty());
        assert!(plan_eviction(&[], DAY * 30, 0).is_empty());
    }

    #[test]
    fn cleanup_removes_only_jpg_files_over_limit() {
        let dir = std::env::temp_dir().join(format!("pv-thumbs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.jpg"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("b.jpg"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("keep.txt"), vec![0u8; 100]).unwrap();
        // 把"现在"设为 60 天后：两个 jpg 都超龄，txt 不是缓存文件不应被动
        let future = SystemTime::now() + DAY * 60;
        let n = cleanup_cache(&dir, future, CACHE_MAX_AGE, CACHE_MAX_TOTAL);
        assert_eq!(n, 2);
        assert!(dir.join("keep.txt").exists());
        assert!(!dir.join("a.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
