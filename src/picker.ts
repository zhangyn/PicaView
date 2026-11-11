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
  if (picking) return null;
  picking = true;
  try {
    return (await invoke<string | null>("pick_image")) ?? null;
  } catch (e) {
    toast(`无法打开文件选择框：${String(e)}`);
    return null;
  } finally {
    picking = false;
  }
}
