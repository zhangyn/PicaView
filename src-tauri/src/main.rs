// 发布版隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod details;
mod exifinfo;
mod imgscan;
mod ops;
mod rotate;
mod thumbs;

use tauri::{Emitter, Manager};

/// 窗口与任一可见显示器有交集才算"在屏幕上"
fn on_any_monitor(
    wx: i32, wy: i32, ww: i32, wh: i32,
    monitors: &[tauri::Monitor],
) -> bool {
    monitors.iter().any(|m| {
        let (mx, my) = (m.position().x, m.position().y);
        let (mw, mh) = (m.size().width as i32, m.size().height as i32);
        wx < mx + mw && wx + ww > mx && wy < my + mh && wy + wh > my
    })
}

fn ensure_on_screen(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.unminimize();
    let size = w.outer_size().unwrap_or(tauri::PhysicalSize::new(1150, 760));
    let pos = w.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
    let monitors = app.available_monitors().unwrap_or_default();
    if !on_any_monitor(pos.x, pos.y, size.width as i32, size.height as i32, &monitors) {
        // 窗口落在不可见区域（幽灵显示器等）：强制居中到主显示器
        if let Ok(Some(pm)) = app.primary_monitor() {
            let pp = pm.position();
            let ps = pm.size();
            let x = pp.x + (((ps.width as i32) - size.width as i32) / 2).max(0);
            let y = pp.y + (((ps.height as i32) - size.height as i32) / 2).max(0);
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = w.set_focus();
            imgscan::diag_log(
                app,
                &format!(
                    "WIN OFFSCREEN 已拉回: 原=({},{}) 主屏=({},{}) {}x{}",
                    pos.x, pos.y, pp.x, pp.y, ps.width, ps.height
                ),
            );
        }
    }
    let _ = w.set_focus();
    // 诊断：记录窗口与显示器几何
    if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
        let mons = app
            .available_monitors()
            .map(|ms| {
                ms.iter()
                    .map(|m| format!("[{},{} {}x{}]", m.position().x, m.position().y, m.size().width, m.size().height))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        imgscan::diag_log(
            app,
            &format!("WIN pos=({},{}) size={}x{} monitors={}", p.x, p.y, s.width, s.height, mons),
        );
    }
}

fn main() {
    tauri::Builder::default()
        // 单实例插件必须最先注册
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(target) = argv.iter().nth(1).filter(|a| !a.starts_with('-')) {
                let _ = app.emit("open-file", target.to_string());
            }
            ensure_on_screen(app);
        }))
        // 文件选择对话框：只在 Rust 侧使用（见 pick_image），前端无 dialog 权限
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            imgscan::list_images,
            imgscan::stat_file,
            imgscan::read_image,
            imgscan::append_log,
            exifinfo::read_exif,
            exifinfo::extract_preview,
            details::get_image_details,
            details::reveal_in_explorer,
            thumbs::thumbnail,
            rotate::rotate,
            ops::rename_file,
            ops::delete_file,
            cli_args,
            pick_image,
        ])
        .setup(|app| {
            ensure_on_screen(app.handle());
            // 后台清理过期/超量的缩略图缓存，不阻塞启动
            thumbs::spawn_cache_cleanup(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PicaView 启动失败");
}

/// 弹出系统"打开文件"对话框（单选，仅图片类型）。用户取消返回 None。
/// 对话框以主窗口为父窗口（系统模态）；选中的路径再过一遍 checked_image_path，
/// 因为 Windows 对话框允许手动输入过滤器之外的文件名。
#[tauri::command]
async fn pick_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    imgscan::run_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("打开图片")
            .add_filter("图片", &["jpg", "jpeg", "png", "bmp", "gif", "webp"])
            .blocking_pick_file();
        let Some(file) = picked else { return Ok(None) };
        let path = file
            .into_path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        imgscan::checked_image_path(&path)?;
        Ok(Some(path))
    })
    .await
}

/// 透传命令行参数（文件关联 / 拖到快捷方式）
#[tauri::command]
fn cli_args() -> Vec<String> {
    // args() 遇到非 Unicode 参数会 panic；args_os + lossy 转换更稳妥
    std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}
