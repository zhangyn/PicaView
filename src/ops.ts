// 文件操作：旋转 / 重命名 / 删除（含确认对话框与结果同步）

import { invoke } from "@tauri-apps/api/core";
import { showDialog } from "./dialog";
import { toast } from "./util";
import type { ImageEntry } from "./types";

export interface OpsCallbacks {
  /** 文件内容变化（旋转后需重新加载当前图） */
  onRotated: (path: string) => void;
  /** 列表变化后刷新 */
  onChanged: () => void;
}

const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

function validateName(name: string): string | null {
  const n = name.trim();
  if (!n || n === "." || n === "..") return "文件名不能为空";
  if (INVALID_CHARS.test(n)) return "文件名包含非法字符";
  if (n.endsWith(".") || n.endsWith(" ")) return "文件名不能以点或空格结尾";
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
      toast(`重命名失败：${String(e)}`);
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
