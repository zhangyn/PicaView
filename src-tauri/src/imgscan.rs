// 目录扫描与动图探测

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use tauri::Manager;

/// 日志是否需要落盘：debug 构建全部记录；release 构建只记录出错类消息
fn is_error_msg(msg: &str) -> bool {
    msg.contains("FAIL") || msg.contains("OFFSCREEN")
}

/// 诊断日志：追加到 app 缓存目录，超 512KB 重置
pub fn diag_log(app: &tauri::AppHandle, msg: &str) {
    if !(cfg!(debug_assertions) || is_error_msg(msg)) {
        return;
    }
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

/// 目录排序方式（与前端下拉框、settings.json 里的字面量一一对应）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SortMode {
    /// 名称自然序（默认，与资源管理器一致）
    #[default]
    Name,
    /// 名称自然序倒序
    NameDesc,
    /// 修改时间：新 → 旧
    Modified,
    /// 文件大小：大 → 小
    Size,
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

// ---------- 通用辅助：后台线程执行 / 解码限制 / panic 兜底 ----------

/// 在阻塞线程池执行同步 IO 或解码，避免占用异步运行时的工作线程
pub async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务异常: {e}"))?
}

/// 解码尺寸上限（宽/高），缩略图与旋转共用
pub const MAX_DIMENSION: u32 = 30000;

/// 解码限制：有限的大值（1 GiB / 30000 px），既支持超大图又不至于无上限
pub fn decode_limits() -> image::Limits {
    let mut lim = image::Limits::default();
    lim.max_alloc = Some(1 << 30);
    lim.max_image_width = Some(MAX_DIMENSION);
    lim.max_image_height = Some(MAX_DIMENSION);
    lim
}

/// 捕获解码过程中的 panic 并转成错误（要求 release 使用 panic = "unwind"）
pub fn catch_decode<T>(what: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(_) => Err(format!("{what}时发生内部错误（图片可能已损坏）")),
    }
}

// ---------- 路径辅助 ----------

/// 路径是否含 `.` / `..` / 连续分隔符（带 \\?\ 前缀后系统不再规范化这些，需保持原样）
fn needs_normalization(rest: &str) -> bool {
    let segs: Vec<&str> = rest.split('\\').collect();
    let last = segs.len() - 1;
    segs.iter()
        .enumerate()
        .any(|(i, s)| *s == "." || *s == ".." || (s.is_empty() && i != last))
}

/// Windows 长路径处理：规范化分隔符并按需加 \\?\ 前缀
pub fn long_path(p: &str) -> String {
    let p = p.replace('/', "\\");
    if p.starts_with("\\\\?\\") || p.starts_with("\\\\.\\") {
        return p;
    }
    if let Some(rest) = p.strip_prefix("\\\\") {
        // UNC 路径 → \\?\UNC\...
        if needs_normalization(rest) {
            return p;
        }
        return format!("\\\\?\\UNC\\{rest}");
    }
    // 仅绝对盘符路径 (X:\...) 才加前缀；相对路径与 `X:foo` 保持原样
    let b = p.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
        if needs_normalization(&p[3..]) {
            return p;
        }
        return format!("\\\\?\\{p}");
    }
    p
}

/// 去掉 \\?\ 前缀并规范化分隔符（给 Shell API 如回收站使用，它们对长路径前缀兼容性差）
pub fn plain_path(p: &str) -> PathBuf {
    let p = p.replace('/', "\\");
    if let Some(rest) = p.strip_prefix("\\\\?\\UNC\\") {
        return PathBuf::from(format!("\\\\{rest}"));
    }
    if let Some(rest) = p.strip_prefix("\\\\?\\") {
        return PathBuf::from(rest);
    }
    PathBuf::from(p)
}

/// 目录参数规范化：`X:` 补成 `X:\`（盘符根目录）
pub fn normalize_dir(dir: &str) -> String {
    let b = dir.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        format!("{dir}\\")
    } else {
        dir.to_string()
    }
}

/// 命令入口统一校验：必须是现存文件，且扩展名在图片白名单内。
/// 返回 (长路径形式, 小写扩展名)，后续文件操作使用长路径形式。
pub fn checked_image_path(path: &str) -> Result<(PathBuf, String), String> {
    let lp = PathBuf::from(long_path(path));
    if !lp.is_file() {
        return Err("文件不存在".into());
    }
    match ext_of(&lp) {
        Some(ext) if is_image_ext(&ext) => Ok((lp, ext)),
        _ => Err("不是支持的图片格式".into()),
    }
}

// ---------- 动图探测 ----------

/// PNG / WebP 的最大扫描量（字节偏移），超出视为静态图
const SCAN_LIMIT: u64 = 64 * 1024;

/// 探测动图：多帧 GIF / 动画 WebP (VP8X 动画位 / ANIM / ANMF) / APNG (acTL)
pub fn detect_animated(p: &Path, ext: &str) -> bool {
    let Ok(f) = fs::File::open(p) else {
        return false;
    };
    match ext {
        "gif" => is_animated_gif(&mut BufReader::new(f)),
        "webp" => is_animated_webp(&mut BufReader::new(f)),
        "png" => is_animated_png(&mut BufReader::new(f)),
        _ => false,
    }
}

/// APNG：按块遍历到首个 IDAT 为止查找 acTL
fn is_animated_png<R: Read + Seek>(r: &mut R) -> bool {
    let mut sig = [0u8; 8];
    if r.read_exact(&mut sig).is_err() || sig != *b"\x89PNG\r\n\x1a\n" {
        return false;
    }
    let mut pos: u64 = 8;
    while pos < SCAN_LIMIT {
        let mut hdr = [0u8; 8];
        if r.read_exact(&mut hdr).is_err() {
            return false;
        }
        let len = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        match &hdr[4..8] {
            b"acTL" => return true,
            b"IDAT" | b"IEND" => return false,
            _ => {}
        }
        pos += 8 + len + 4; // 块头 + 数据 + CRC
        if r.seek(SeekFrom::Start(pos)).is_err() {
            return false;
        }
    }
    false
}

/// 动画 WebP：按 RIFF 块遍历，VP8X 动画标志位或出现 ANIM / ANMF 即为动图
fn is_animated_webp<R: Read + Seek>(r: &mut R) -> bool {
    let mut head = [0u8; 12];
    if r.read_exact(&mut head).is_err() || &head[0..4] != b"RIFF" || &head[8..12] != b"WEBP" {
        return false;
    }
    let mut pos: u64 = 12;
    while pos < SCAN_LIMIT {
        let mut hdr = [0u8; 8];
        if r.read_exact(&mut hdr).is_err() {
            return false;
        }
        let size = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as u64;
        match &hdr[0..4] {
            b"ANIM" | b"ANMF" => return true,
            b"VP8X" => {
                let mut flags = [0u8; 1];
                if r.read_exact(&mut flags).is_err() {
                    return false;
                }
                if flags[0] & 0x02 != 0 {
                    return true;
                }
            }
            b"VP8 " | b"VP8L" => return false, // 静态图像数据，之后不会再有动画块
            _ => {}
        }
        pos += 8 + size + (size & 1); // 块按偶数字节对齐
        if r.seek(SeekFrom::Start(pos)).is_err() {
            return false;
        }
    }
    false
}

/// 跳过 GIF 子块序列（以长度 0 的块结束）
fn gif_skip_sub_blocks<R: Read + Seek>(r: &mut BufReader<R>) -> Option<()> {
    loop {
        let mut len = [0u8; 1];
        r.read_exact(&mut len).ok()?;
        if len[0] == 0 {
            return Some(());
        }
        r.seek_relative(len[0] as i64).ok()?;
    }
}

/// GIF：流式解析块结构，遇到第二个图像描述符即判定为动图
fn is_animated_gif<R: Read + Seek>(r: &mut BufReader<R>) -> bool {
    let mut head = [0u8; 13];
    if r.read_exact(&mut head).is_err() || (&head[0..6] != b"GIF87a" && &head[0..6] != b"GIF89a") {
        return false;
    }
    if head[10] & 0x80 != 0 {
        // 全局色表
        let n = 3 * (1i64 << ((head[10] & 0x07) + 1));
        if r.seek_relative(n).is_err() {
            return false;
        }
    }
    let mut frames = 0;
    loop {
        let mut b = [0u8; 1];
        if r.read_exact(&mut b).is_err() {
            return false;
        }
        match b[0] {
            0x21 => {
                // 扩展块：0x21 label 子块... 0x00
                let mut label = [0u8; 1];
                if r.read_exact(&mut label).is_err() || gif_skip_sub_blocks(r).is_none() {
                    return false;
                }
            }
            0x2C => {
                frames += 1;
                if frames > 1 {
                    return true;
                }
                // 图像描述符 9 字节 + 可选局部色表 + LZW 最小码长 + 数据子块
                let mut d = [0u8; 9];
                if r.read_exact(&mut d).is_err() {
                    return false;
                }
                if d[8] & 0x80 != 0 {
                    let n = 3 * (1i64 << ((d[8] & 0x07) + 1));
                    if r.seek_relative(n).is_err() {
                        return false;
                    }
                }
                let mut lzw = [0u8; 1];
                if r.read_exact(&mut lzw).is_err() || gif_skip_sub_blocks(r).is_none() {
                    return false;
                }
            }
            _ => return false, // 0x3B 结束符或非法数据
        }
    }
}

// ---------- 动图探测缓存 ----------

/// 缓存条目上限，超出后整体清空（目录切换频繁时不至于无限增长）
const ANIM_CACHE_MAX: usize = 8192;

/// (mtime 纳秒, 文件大小, 是否动图)
type AnimCacheEntry = (u128, u64, bool);

/// 长路径（小写） → 缓存条目
static ANIM_CACHE: LazyLock<Mutex<HashMap<String, AnimCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 带缓存的动图探测：扫描大目录时每个 gif/webp/png 都要读文件头，
/// 同一会话内重复打开同一目录（以及 stat_file 与 list_images 之间）不必再读
fn detect_animated_cached(p: &Path, ext: &str, md: &fs::Metadata) -> bool {
    if !matches!(ext, "gif" | "webp" | "png") {
        return false;
    }
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = p.to_string_lossy().to_lowercase();
    if let Ok(cache) = ANIM_CACHE.lock() {
        if let Some((m, s, a)) = cache.get(&key) {
            if *m == mtime && *s == md.len() {
                return *a;
            }
        }
    }
    let animated = detect_animated(p, ext);
    if let Ok(mut cache) = ANIM_CACHE.lock() {
        if cache.len() >= ANIM_CACHE_MAX {
            cache.clear();
        }
        cache.insert(key, (mtime, md.len(), animated));
    }
    animated
}

fn entry_from(path: &Path, md: &fs::Metadata) -> ImageEntry {
    let ext = ext_of(path).unwrap_or_default();
    let modified = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    // 探测时用长路径形式打开，返回给前端的 path 保持原样
    let open_path = PathBuf::from(long_path(&path.to_string_lossy()));
    ImageEntry {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        size: md.len(),
        modified,
        animated: detect_animated_cached(&open_path, &ext, md),
    }
}

/// 不区分大小写的自然排序
fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    natord::compare_ignore_case(a, b)
}

/// 按指定方式排序；并列时一律用名称自然序兜底，保证顺序稳定可复现
fn sort_entries(out: &mut [ImageEntry], mode: SortMode) {
    match mode {
        SortMode::Name => out.sort_by(|a, b| compare_names(&a.name, &b.name)),
        SortMode::NameDesc => out.sort_by(|a, b| compare_names(&b.name, &a.name)),
        SortMode::Modified => out.sort_by(|a, b| {
            b.modified
                .cmp(&a.modified)
                .then_with(|| compare_names(&a.name, &b.name))
        }),
        SortMode::Size => out.sort_by(|a, b| {
            b.size
                .cmp(&a.size)
                .then_with(|| compare_names(&a.name, &b.name))
        }),
    }
}

/// 并行扫描的线程上限（动图探测是 IO 密集，再多也收益有限）
const MAX_SCAN_THREADS: usize = 8;
/// 少于该数量时串行更快（线程创建/同步开销大于收益）
const PARALLEL_MIN_ITEMS: usize = 64;

/// 动图探测要逐个读文件头，按 CPU 数分块并行；顺序由 chunks 顺序保证
fn entry_from_all(items: Vec<(PathBuf, fs::Metadata)>) -> Vec<ImageEntry> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(MAX_SCAN_THREADS);
    if items.len() < PARALLEL_MIN_ITEMS || threads < 2 {
        return items.iter().map(|(p, md)| entry_from(p, md)).collect();
    }
    let chunk = items.len().div_ceil(threads);
    std::thread::scope(|s| {
        let parts: Vec<_> = items
            .chunks(chunk)
            .map(|c| s.spawn(move || c.iter().map(|(p, md)| entry_from(p, md)).collect::<Vec<_>>()))
            .collect();
        // 单块 panic（损坏图片）只丢该块，不影响整次扫描
        parts.into_iter().filter_map(|h| h.join().ok()).flatten().collect()
    })
}

/// 同步扫描目录，返回已排序的图片列表
fn scan_dir(dir: &str, sort: SortMode) -> std::io::Result<Vec<ImageEntry>> {
    let rd = fs::read_dir(long_path(dir))?;
    let base = Path::new(dir);
    let mut items: Vec<(PathBuf, fs::Metadata)> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name();
        // 先按扩展名过滤，非图片不产生任何额外系统调用
        let Some(ext) = ext_of(Path::new(&name)) else { continue };
        if !is_image_ext(&ext) {
            continue;
        }
        // 目录项自带类型信息；符号链接才需要额外 stat 跟随
        let Ok(ft) = entry.file_type() else { continue };
        let is_file = if ft.is_symlink() {
            entry.path().is_file()
        } else {
            ft.is_file()
        };
        if !is_file {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        // 路径由调用方传入的 dir 拼接，避免暴露 \\?\ 前缀
        items.push((base.join(&name), md));
    }
    let mut out = entry_from_all(items);
    sort_entries(&mut out, sort);
    Ok(out)
}

/// 列出目录中的图片（默认名称自然序，可指定排序方式）
#[tauri::command]
pub async fn list_images(
    app: tauri::AppHandle,
    dir: String,
    sort: Option<SortMode>,
) -> Result<Vec<ImageEntry>, String> {
    let t0 = std::time::Instant::now();
    let dir = normalize_dir(&dir);
    let dir2 = dir.clone();
    let sort = sort.unwrap_or_default();
    let res = run_blocking(move || scan_dir(&dir2, sort).map_err(|e| e.to_string())).await;
    match res {
        Ok(out) => {
            diag_log(
                &app,
                &format!(
                    "LIST {dir} [{sort:?}] → {} 项 ({}ms)",
                    out.len(),
                    t0.elapsed().as_millis()
                ),
            );
            Ok(out)
        }
        Err(e) => {
            diag_log(&app, &format!("LIST FAIL {dir} ({e})"));
            Err(format!("无法读取文件夹 {dir}: {e}"))
        }
    }
}

/// 单文件信息（列表中不存在时兜底）
#[tauri::command]
pub async fn stat_file(path: String) -> Result<ImageEntry, String> {
    run_blocking(move || {
        let (lp, _) = checked_image_path(&path)?;
        let md = fs::metadata(&lp).map_err(|e| e.to_string())?;
        Ok(entry_from(Path::new(&path), &md))
    })
    .await
}

/// 读取图片字节（替代 asset 协议，规避其路径解码限制）
#[tauri::command]
pub async fn read_image(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let t0 = std::time::Instant::now();
    let p2 = path.clone();
    let res = run_blocking(move || {
        let (lp, _) = checked_image_path(&p2)?;
        fs::read(&lp).map_err(|e| format!("读取文件失败: {e}"))
    })
    .await;
    match res {
        Ok(bytes) => {
            diag_log(&app, &format!("READ OK {} ({}B, {}ms)", path, bytes.len(), t0.elapsed().as_millis()));
            Ok(tauri::ipc::Response::new(bytes))
        }
        Err(e) => {
            diag_log(&app, &format!("READ FAIL {} ({})", path, e));
            Err(e)
        }
    }
}

/// 前端诊断日志入口
#[tauri::command]
pub async fn append_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    diag_log(&app, &msg);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // ---------- long_path / plain_path / normalize_dir ----------

    #[test]
    fn long_path_drive() {
        assert_eq!(long_path("C:\\a\\b.jpg"), "\\\\?\\C:\\a\\b.jpg");
        assert_eq!(long_path("C:/a/b.jpg"), "\\\\?\\C:\\a\\b.jpg");
        assert_eq!(long_path("C:\\"), "\\\\?\\C:\\");
        assert_eq!(long_path("c:\\a.jpg"), "\\\\?\\c:\\a.jpg");
    }

    #[test]
    fn long_path_unc() {
        assert_eq!(
            long_path("\\\\server\\share\\a.jpg"),
            "\\\\?\\UNC\\server\\share\\a.jpg"
        );
        assert_eq!(
            long_path("//server/share/a.jpg"),
            "\\\\?\\UNC\\server\\share\\a.jpg"
        );
        assert_eq!(long_path("\\\\server\\share"), "\\\\?\\UNC\\server\\share");
    }

    #[test]
    fn long_path_already_prefixed_is_unchanged() {
        assert_eq!(long_path("\\\\?\\C:\\a.jpg"), "\\\\?\\C:\\a.jpg");
        assert_eq!(long_path("\\\\?\\UNC\\s\\x\\a.jpg"), "\\\\?\\UNC\\s\\x\\a.jpg");
        assert_eq!(long_path("\\\\.\\PhysicalDrive0"), "\\\\.\\PhysicalDrive0");
        // 幂等
        let once = long_path("C:\\a\\b.jpg");
        assert_eq!(long_path(&once), once);
    }

    #[test]
    fn long_path_relative_and_special_unchanged() {
        assert_eq!(long_path("a\\b.jpg"), "a\\b.jpg");
        assert_eq!(long_path("a/b.jpg"), "a\\b.jpg");
        assert_eq!(long_path("b.jpg"), "b.jpg");
        assert_eq!(long_path("C:"), "C:");
        assert_eq!(long_path("C:a.jpg"), "C:a.jpg");
        assert_eq!(long_path(""), "");
        // 含 .. / . / 连续分隔符的路径不能加前缀（带前缀后系统不再规范化）
        assert_eq!(long_path("C:\\a\\..\\b.jpg"), "C:\\a\\..\\b.jpg");
        assert_eq!(long_path("C:\\a\\.\\b.jpg"), "C:\\a\\.\\b.jpg");
        assert_eq!(long_path("C:\\a\\\\b.jpg"), "C:\\a\\\\b.jpg");
    }

    #[test]
    fn plain_path_strips_prefix() {
        assert_eq!(plain_path("\\\\?\\C:\\a.jpg"), PathBuf::from("C:\\a.jpg"));
        assert_eq!(
            plain_path("\\\\?\\UNC\\server\\share\\a.jpg"),
            PathBuf::from("\\\\server\\share\\a.jpg")
        );
        assert_eq!(plain_path("C:/a/b.jpg"), PathBuf::from("C:\\a\\b.jpg"));
        assert_eq!(plain_path("a\\b.jpg"), PathBuf::from("a\\b.jpg"));
    }

    #[test]
    fn normalize_dir_adds_root_separator() {
        assert_eq!(normalize_dir("C:"), "C:\\");
        assert_eq!(normalize_dir("d:"), "d:\\");
        assert_eq!(normalize_dir("C:\\"), "C:\\");
        assert_eq!(normalize_dir("C:\\pics"), "C:\\pics");
        assert_eq!(normalize_dir("\\\\server\\share"), "\\\\server\\share");
        assert_eq!(normalize_dir(""), "");
    }

    #[cfg(windows)]
    #[test]
    fn parent_of_drive_file_is_drive_root() {
        assert_eq!(Path::new("C:\\a.jpg").parent(), Some(Path::new("C:\\")));
    }

    #[test]
    fn checked_image_path_rejects_missing_and_non_image() {
        let dir = std::env::temp_dir().join(format!("pv-imgscan-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let img = dir.join("a.JPG");
        let txt = dir.join("a.txt");
        fs::write(&img, b"x").unwrap();
        fs::write(&txt, b"x").unwrap();

        let (_, ext) = checked_image_path(&img.to_string_lossy()).unwrap();
        assert_eq!(ext, "jpg");
        assert_eq!(checked_image_path(&txt.to_string_lossy()).unwrap_err(), "不是支持的图片格式");
        assert_eq!(
            checked_image_path(&dir.join("nope.jpg").to_string_lossy()).unwrap_err(),
            "文件不存在"
        );
        // 目录（即使名字像图片）不是文件
        let fake_dir = dir.join("d.png");
        fs::create_dir_all(&fake_dir).unwrap();
        assert_eq!(checked_image_path(&fake_dir.to_string_lossy()).unwrap_err(), "文件不存在");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 日志过滤 / 排序 ----------

    #[test]
    fn error_msgs_are_detected() {
        assert!(is_error_msg("THUMB FAIL x: y"));
        assert!(is_error_msg("LIST FAIL C:\\"));
        assert!(is_error_msg("WIN OFFSCREEN 已拉回"));
        assert!(!is_error_msg("THUMB OK x"));
        assert!(!is_error_msg("OPEN C:\\a.jpg"));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pv-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_dir_parallel_path_keeps_order_and_flags() {
        // 超过并行阈值（64）：顺序仍需按自然排序，动图标记仍正确
        let dir = temp_dir("scan");
        let img = image::RgbaImage::new(1, 1);
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        for i in 0..70 {
            fs::write(dir.join(format!("img_{i}.png")), &png).unwrap();
        }
        fs::write(dir.join("anim.gif"), gif_bytes(2, true)).unwrap();
        fs::write(dir.join("still.gif"), gif_bytes(1, true)).unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap(); // 非图片不入列

        let out = scan_dir(&dir.to_string_lossy(), SortMode::Name).unwrap();
        assert_eq!(out.len(), 72);
        let pos = |n: &str| out.iter().position(|e| e.name == n).unwrap();
        assert_eq!(out[0].name, "anim.gif");
        assert!(out[pos("anim.gif")].animated);
        assert!(!out[pos("still.gif")].animated);
        assert!(!out[pos("img_9.png")].animated);
        assert!(pos("img_9.png") < pos("img_10.png"), "自然排序被并行打乱");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn anim_cache_follows_file_change() {
        let dir = temp_dir("animcache");
        let f = dir.join("a.gif");
        fs::write(&f, gif_bytes(1, true)).unwrap();
        let md = fs::metadata(&f).unwrap();
        assert!(!detect_animated_cached(&f, "gif", &md));

        // 改成两帧并把 mtime 推后 → 缓存必须失效（缓存键含 mtime + 大小）
        fs::write(&f, gif_bytes(2, true)).unwrap();
        let fh = fs::File::options().write(true).open(&f).unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fh.set_modified(later).unwrap();
        drop(fh);
        let md = fs::metadata(&f).unwrap();
        assert!(detect_animated_cached(&f, "gif", &md));

        // 重复查询命中缓存，结果稳定
        assert!(detect_animated_cached(&f, "gif", &fs::metadata(&f).unwrap()));
        // 不能动的格式直接 false，不进缓存也不读文件
        assert!(!detect_animated_cached(&f, "jpg", &md));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sort_entries_modes() {
        let entry = |name: &str, size: u64, modified: Option<u64>| ImageEntry {
            name: name.into(),
            path: name.into(),
            size,
            modified,
            animated: false,
        };
        let make = || {
            vec![
                entry("b10.jpg", 300, Some(30)),
                entry("B2.jpg", 100, None),
                entry("a1.jpg", 200, Some(10)),
            ]
        };
        let names = |v: &[ImageEntry]| v.iter().map(|e| e.name.clone()).collect::<Vec<_>>();

        let mut v = make();
        sort_entries(&mut v, SortMode::Name);
        assert_eq!(names(&v), vec!["a1.jpg", "B2.jpg", "b10.jpg"]);

        let mut v = make();
        sort_entries(&mut v, SortMode::NameDesc);
        assert_eq!(names(&v), vec!["b10.jpg", "B2.jpg", "a1.jpg"]);

        // 修改时间新→旧，缺失时间排最后
        let mut v = make();
        sort_entries(&mut v, SortMode::Modified);
        assert_eq!(names(&v), vec!["b10.jpg", "a1.jpg", "B2.jpg"]);

        // 大小大→小
        let mut v = make();
        sort_entries(&mut v, SortMode::Size);
        assert_eq!(names(&v), vec!["b10.jpg", "a1.jpg", "B2.jpg"]);

        // 并列时名称兜底，顺序稳定
        let mut v = vec![
            entry("b.jpg", 100, Some(5)),
            entry("a.jpg", 100, Some(5)),
        ];
        sort_entries(&mut v, SortMode::Size);
        assert_eq!(names(&v), vec!["a.jpg", "b.jpg"]);
    }

    #[test]
    fn natural_sort_ignores_case() {
        let mut v = vec!["IMG_10.jpg", "img_2.jpg", "Img_1.jpg", "b.jpg", "A.jpg"];
        v.sort_by(|a, b| compare_names(a, b));
        assert_eq!(v, vec!["A.jpg", "b.jpg", "Img_1.jpg", "img_2.jpg", "IMG_10.jpg"]);
    }

    // ---------- 动图探测（内存字节） ----------

    fn gif_bytes(frames: usize, with_gct: bool) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&[1, 0, 1, 0]); // 宽高
        v.push(if with_gct { 0x80 } else { 0x00 }); // 全局色表标志（2 色）
        v.extend_from_slice(&[0, 0]); // 背景色、像素比
        if with_gct {
            v.extend_from_slice(&[0, 0, 0, 255, 255, 255]);
        }
        for _ in 0..frames {
            // 图形控制扩展
            v.extend_from_slice(&[0x21, 0xF9, 0x04, 0, 0, 0, 0, 0x00]);
            // 图像描述符
            v.push(0x2C);
            v.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0, 0x00]);
            v.push(0x02); // LZW 最小码长
            v.extend_from_slice(&[2, 0x44, 0x01, 0x00]); // 一个 2 字节子块 + 结束
        }
        v.push(0x3B);
        v
    }

    fn check_gif(buf: Vec<u8>) -> bool {
        is_animated_gif(&mut BufReader::new(Cursor::new(buf)))
    }

    #[test]
    fn gif_single_vs_multi_frame() {
        assert!(!check_gif(gif_bytes(1, true)));
        assert!(!check_gif(gif_bytes(1, false)));
        assert!(check_gif(gif_bytes(2, true)));
        assert!(check_gif(gif_bytes(3, false)));
    }

    #[test]
    fn gif_garbage_and_truncated() {
        assert!(!check_gif(Vec::new()));
        assert!(!check_gif(b"not a gif at all".to_vec()));
        let mut v = gif_bytes(2, true);
        v.truncate(25); // 截断在第一帧之前的扩展块中
        assert!(!check_gif(v));
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut v = (data.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(data);
        v.extend_from_slice(&[0, 0, 0, 0]); // CRC 不参与解析
        v
    }

    fn png_bytes(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        for (k, d) in chunks {
            v.extend(png_chunk(k, d));
        }
        v
    }

    fn check_png(buf: Vec<u8>) -> bool {
        is_animated_png(&mut Cursor::new(buf))
    }

    #[test]
    fn apng_with_iccp_before_actl() {
        // iCCP 块 4KB，acTL 在其后、IDAT 之前
        let png = png_bytes(&[
            (b"IHDR", vec![0; 13]),
            (b"iCCP", vec![0x41; 4096]),
            (b"acTL", vec![0, 0, 0, 2, 0, 0, 0, 0]),
            (b"IDAT", vec![0; 8]),
            (b"IEND", vec![]),
        ]);
        assert!(check_png(png));
    }

    #[test]
    fn static_png_is_not_animated() {
        let png = png_bytes(&[
            (b"IHDR", vec![0; 13]),
            (b"iCCP", vec![0x41; 4096]),
            (b"IDAT", vec![0; 8]),
            // acTL 出现在 IDAT 之后不应被计入（规范要求在 IDAT 之前）
            (b"acTL", vec![0; 8]),
            (b"IEND", vec![]),
        ]);
        assert!(!check_png(png));
    }

    #[test]
    fn png_bad_input() {
        assert!(!check_png(Vec::new()));
        assert!(!check_png(b"GIF89a-not-png".to_vec()));
        // 块长度声称极大：应安全返回而不是越界/死循环
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        v.extend_from_slice(&0xFFFF_FFF0u32.to_be_bytes());
        v.extend_from_slice(b"tEXt");
        assert!(!check_png(v));
    }

    #[test]
    fn png_actl_beyond_scan_limit_is_ignored() {
        let png = png_bytes(&[
            (b"IHDR", vec![0; 13]),
            (b"iCCP", vec![0x41; 70 * 1024]), // 超过 64KB 扫描上限
            (b"acTL", vec![0; 8]),
            (b"IDAT", vec![0; 8]),
        ]);
        assert!(!check_png(png));
    }

    fn webp_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut v = kind.to_vec();
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        if data.len() % 2 == 1 {
            v.push(0);
        }
        v
    }

    fn webp_bytes(chunks: Vec<Vec<u8>>) -> Vec<u8> {
        let body: Vec<u8> = chunks.concat();
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        v.extend_from_slice(b"WEBP");
        v.extend(body);
        v
    }

    fn vp8x(flags: u8) -> Vec<u8> {
        let mut d = vec![flags, 0, 0, 0];
        d.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // 画布宽高
        webp_chunk(b"VP8X", &d)
    }

    fn check_webp(buf: Vec<u8>) -> bool {
        is_animated_webp(&mut Cursor::new(buf))
    }

    #[test]
    fn animated_webp_flag_in_vp8x() {
        let w = webp_bytes(vec![vp8x(0x02 | 0x20), webp_chunk(b"ICCP", &[1; 3000])]);
        assert!(check_webp(w));
    }

    #[test]
    fn animated_webp_with_iccp_before_anim() {
        // VP8X 未置动画位（容错），但 ICCP 之后出现 ANIM
        let w = webp_bytes(vec![
            vp8x(0x20),
            webp_chunk(b"ICCP", &[1; 3001]), // 奇数长度，验证对齐填充
            webp_chunk(b"ANIM", &[0; 6]),
            webp_chunk(b"ANMF", &[0; 16]),
        ]);
        assert!(check_webp(w));
    }

    #[test]
    fn static_webp_is_not_animated() {
        let w = webp_bytes(vec![
            vp8x(0x20 | 0x10),
            webp_chunk(b"ICCP", &[1; 3000]),
            webp_chunk(b"ALPH", &[0; 8]),
            webp_chunk(b"VP8 ", &[0; 20]),
            // VP8 之后的 ANIM 不应被计入
            webp_chunk(b"ANIM", &[0; 6]),
        ]);
        assert!(!check_webp(w));
        // 简单格式（无 VP8X）
        assert!(!check_webp(webp_bytes(vec![webp_chunk(b"VP8L", &[0; 10])])));
    }

    #[test]
    fn webp_bad_input() {
        assert!(!check_webp(Vec::new()));
        assert!(!check_webp(b"RIFF....WAVE".to_vec()));
        assert!(!check_webp(b"RIFF\x00\x00\x00\x00WEBP".to_vec()));
    }

    #[test]
    fn detect_animated_unknown_ext_is_false() {
        assert!(!detect_animated(Path::new("does-not-exist.gif"), "gif"));
        assert!(!detect_animated(Path::new("x.jpg"), "jpg"));
    }
}
