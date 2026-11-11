// 文件操作：旋转 / 重命名 / 删除（含确认对话框与结果同步）

import { invoke } from "@tauri-apps/api/core";
import { showDialog } from "./dialog";
import { IMAGE_EXTS, extOf, hasImageExtension, toast } from "./util";
import type { ImageEntry } from "./types";

export interface OpsCallbacks {
  /** 文件内容变化（旋转后需重新加载当前图） */
  onRotated: (path: string) => void;
}

const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const MAX_NAME_UTF16 = 255;

/** 前置校验，文案与后端 validate_new_name 保持一致（后端仍是最终裁决） */
function validateName(name: string): string | null {
  const n = name.trim();
  if (!n || n === "." || n === "..") return "文件名不能为空";
  if (INVALID_CHARS.test(n)) return "文件名包含非法字符";
  if (n.endsWith(".") || n.endsWith(" ")) return "文件名不能以点或空格结尾";
  if (n.length > MAX_NAME_UTF16) return "文件名过长"; // JS 的 length 即 UTF-16 单元数
  if (!hasImageExtension(n)) return `文件名必须保留图片扩展名（${IMAGE_EXTS.join("、")}）`;
  return null;
}

export class Ops {
  constructor(private cb: OpsCallbacks) {}

  /** 无损旋转；动图直接拒绝（Rust 侧也会兜底） */
  async rotate(entry: ImageEntry, clockwise: boolean) {
    if (entry.animated) {
      toast("动图暂不支持旋转");
      return;
    }
    try {
      await invoke("rotate", { path: entry.path, clockwise });
      this.cb.onRotated(entry.path);
      // image 的 WebP 编码器只有无损档：有损 WebP 旋转后体积可能明显变大，明确告知
      if (extOf(entry.path) === "webp") {
        toast("已旋转（WebP 按无损重编码，文件可能变大）", 4000);
      }
    } catch (e) {
      toast(`旋转失败：${String(e)}`);
    }
  }

  async rename(entry: ImageEntry): Promise<ImageEntry | null> {
    const r = await showDialog({
      message: `重命名「${entry.name}」为：`,
      okText: "重命名",
      input: { initial: entry.name, selectBaseName: true },
    });
    if (!r.ok || !r.value) return null;
    const newName = r.value.trim();
    if (newName === entry.name) return null;
    const err = validateName(newName);
    if (err) {
      toast(err);
      return null;
    }
    try {
      const newPath = await invoke<string>("rename_file", {
        path: entry.path,
        newName,
      });
      toast(`已重命名为 ${newName}`);
      return { ...entry, name: newName, path: newPath };
    } catch (e) {
      // 后端返回的是完整的中文短句（如"同名文件已存在"），直接展示
      toast(String(e));
      return null;
    }
  }

  async remove(entry: ImageEntry, permanent: boolean) {
    const r = await showDialog({
      message: permanent
        ? `彻底删除「${entry.name}」？\n此操作不可恢复！`
        : `将「${entry.name}」移入回收站？`,
      okText: permanent ? "彻底删除" : "移入回收站",
      danger: permanent,
    });
    if (!r.ok) return false;
    try {
      await invoke("delete_file", { path: entry.path, permanent });
      toast(permanent ? "已彻底删除" : "已移入回收站");
      return true;
    } catch (e) {
      toast(`删除失败：${String(e)}`);
      return false;
    }
  }
}
