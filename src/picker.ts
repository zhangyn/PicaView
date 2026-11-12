// 打开图片的系统文件选择框（Rust 侧 pick_image：系统模态、仅图片类型、单选）

import { invoke } from "@tauri-apps/api/core";
import { toast } from "./util";

let picking = false;

/** 系统对话框是否正在显示（期间前端不应响应任何快捷键） */
export function isPicking(): boolean {
  return picking;
}

/** 弹出文件选择框；取消、出错或已有对话框在显示时返回 null */
export async function pickImage(): Promise<string | null> {
  return pick("pick_image", "无法打开文件选择框");
}

/** 弹出文件夹选择框；语义同上 */
export async function pickFolder(): Promise<string | null> {
  return pick("pick_folder", "无法打开文件夹选择框");
}

async function pick(command: string, errPrefix: string): Promise<string | null> {
  if (picking) return null;
  picking = true;
  try {
    return (await invoke<string | null>(command)) ?? null;
  } catch (e) {
    toast(`${errPrefix}：${String(e)}`);
    return null;
  } finally {
    picking = false;
  }
}
