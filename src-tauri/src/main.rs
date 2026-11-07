// 发布版隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    let _ = w.show();
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
        .invoke_handler(tauri::generate_handler![
            imgscan::list_images,
            imgscan::stat_file,
            imgscan::read_image,
            imgscan::append_log,
            exifinfo::read_exif,
            exifinfo::extract_preview,
            thumbs::thumbnail,
            rotate::rotate,
            ops::rename_file,
            ops::delete_file,
            cli_args,
        ])
        .setup(|app| {
            ensure_on_screen(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PicaView 启动失败");
}

/// 透传命令行参数（文件关联 / 拖到快捷方式）
#[tauri::command]
fn cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}
