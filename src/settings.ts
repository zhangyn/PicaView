// 用户设置：与 Rust 侧 Settings 结构一一对应；启动读一次，改动后防抖落盘
//
// 只存"下次启动还想保持"的开关；缩放、当前图这类会话状态不落盘。

import { invoke } from "@tauri-apps/api/core";

import { SETTINGS_SAVE_DEBOUNCE_MS } from "./config";

export type SortMode = "name" | "name_desc" | "modified" | "size";
export type Theme = "dark" | "light" | "system";
export type RotateMode = "view" | "file";

/** 仅显示模式的旋转记录（与 Rust RotationMark 对应） */
export interface RotationMark {
  path: string;
  /** 顺时针 90° 的次数 0..3 */
  quarter: number;
  size: number;
  /** 毫秒时间戳 */
  mtime: number;
}

export interface Settings {
  /** 打开图片即进入全屏灯箱 */
  lightbox: boolean;
  /** 只看图片：隐藏标题栏 */
  frameless: boolean;
  /** 胶片条默认显示 */
  filmstrip: boolean;
  /** 信息浮层默认显示 */
  infobar: boolean;
  /** 目录排序方式 */
  sort: SortMode;
  /** 界面主题 */
  theme: Theme;
  /** 旋转方式：view = 只改显示（默认），file = 写回文件 */
  rotate_mode: RotateMode;
  /** 仅显示模式的旋转记录 */
  rotations: RotationMark[];
}

export const SORT_LABELS: Record<SortMode, string> = {
  name: "名称 ↑",
  name_desc: "名称 ↓",
  modified: "修改时间",
  size: "文件大小",
};

const DEFAULTS: Settings = {
  lightbox: true,
  frameless: false,
  filmstrip: true,
  infobar: true,
  sort: "name",
  theme: "dark",
  rotate_mode: "view",
  rotations: [],
};

let current: Settings = { ...DEFAULTS };
let saveTimer = 0;

export function getSettings(): Settings {
  return current;
}

/** 读磁盘设置；文件缺失/损坏/非 Tauri 环境都退回默认值，绝不阻塞启动 */
export async function loadSettings(): Promise<Settings> {
  try {
    const s = await invoke<Settings>("get_settings");
    current = { ...DEFAULTS, ...s };
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

/** 合并修改并防抖落盘（切换开关时不必每下都写文件） */
export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void invoke("set_settings", { settings: current }).catch(() => {
      /* 保存失败不打断使用，下次改动会再写一次 */
    });
  }, SETTINGS_SAVE_DEBOUNCE_MS);
}
