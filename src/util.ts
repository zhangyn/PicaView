// 通用小工具

import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  IDLE_HIDE_MS, TOAST_MS, WHEEL_DELTA_CAP, WHEEL_LINE_PX, WHEEL_PAGE_PX,
} from "./config";

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i + 1).toLowerCase() : "";
}

export const IMAGE_EXTS = ["jpg", "jpeg", "png", "bmp", "gif", "webp"];

export function isImageExt(path: string): boolean {
  return IMAGE_EXTS.includes(extOf(path));
}

/** 文件名（不含目录）是否带图片扩展名；".jpg" 这种只有扩展名的不算（与后端一致） */
export function hasImageExtension(name: string): boolean {
  const i = name.lastIndexOf(".");
  return i > 0 && IMAGE_EXTS.includes(name.slice(i + 1).toLowerCase());
}

/** 无透明通道的格式 */
export function isOpaqueExt(path: string): boolean {
  const e = extOf(path);
  return e === "jpg" || e === "jpeg" || e === "bmp";
}

export function isJpeg(path: string): boolean {
  const e = extOf(path);
  return e === "jpg" || e === "jpeg";
}

/**
 * 滚轮增量归一化：deltaMode 0=像素 / 1=行 / 2=页，统一换算成像素当量并限幅。
 * 不换算时，行模式（deltaY≈3）下缩放几乎不动，页模式又会一下跳到底。
 */
export function normalizeWheelDelta(e: WheelEvent, cap = WHEEL_DELTA_CAP): number {
  const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  const d = e.deltaY * unit;
  return Math.max(-cap, Math.min(cap, d));
}

/** 文件名（不含目录），兼容 "\\" 与 "/" */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 文件名去掉扩展名（".jpg" 这种只算扩展名的不动） */
export function stemOf(p: string): string {
  const name = baseName(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 毫秒时间戳 → 本地时区 "YYYY-MM-DD HH:mm:ss"；无效值返回 null */
export function formatDateTime(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 只读文件头取图像像素尺寸（不解码）。支持 PNG / GIF / BMP / JPEG / WebP；
 * 识别失败返回 null，调用方应走保守路径。JPEG 的 EXIF 方向不在此处理，
 * 所以调用方不要假设 w 一定是显示宽度。
 */
export function peekImageSize(b: Uint8Array): { w: number; h: number } | null {
  const n = b.length;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u32le = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const tag = (i: number, s: string) => {
    for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
    return true;
  };
  let r: { w: number; h: number } | null = null;

  if (n >= 24 && b[0] === 0x89 && tag(1, "PNG")) {
    r = { w: u32be(16), h: u32be(20) };
  } else if (n >= 10 && tag(0, "GIF8")) {
    r = { w: u16le(6), h: u16le(8) };
  } else if (n >= 26 && tag(0, "BM")) {
    r = { w: u32le(18), h: Math.abs(u32le(22) | 0) };
  } else if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }                                  // 填充字节
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }  // 无长度的标记
      // SOF0-SOF15（排除 DHT=C4 / JPG=C8 / DAC=CC）携带尺寸
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        r = { w: u16be(i + 7), h: u16be(i + 5) };
        break;
      }
      i += 2 + u16be(i + 2);
    }
  } else if (n >= 30 && tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8 ")) r = { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    else if (tag(12, "VP8L")) {
      const v = u32le(21);
      r = { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 };
    } else if (tag(12, "VP8X")) r = { w: u24le(24) + 1, h: u24le(27) + 1 };
  }
  return r && r.w > 0 && r.h > 0 ? r : null;
}

// 路径根部：\\?\UNC\srv\share、\\?\C:、\\srv\share、C:，其余（含 "/" 开头）视为无前缀根
const ROOT_RE = /^(?:[\\/]{2}[?.][\\/]UNC[\\/][^\\/]+[\\/][^\\/]+|[\\/]{2}[?.][\\/][A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+|[A-Za-z]:|)/;

/**
 * 取父目录，兼容 "/" 与 "\\"。
 * - 盘符根保留分隔符：C:\a.jpg → C:\（而不是 "C:"）
 * - UNC 根不破坏：\\srv\share\a.jpg → \\srv\share\
 * - 无目录部分时：盘符相对路径 C:a.jpg → C:；纯文件名 → ""
 * - 本身就是根（C:\、\\srv\share、/）原样返回
 */
export function dirname(p: string): string {
  const root = ROOT_RE.exec(p)![0];
  const rootLen = root.length;
  const last = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (last < 0) return root; // 纯文件名 → ""；C:a.jpg → "C:"
  if (last < rootLen) {
    // 分隔符落在根内部（如 \\srv\share 本身）：整串就是根，原样返回
    return rootLen === p.length ? p : root;
  }
  if (last === rootLen) return p.slice(0, last + 1); // C:\a.jpg → C:\ ； /a.jpg → /
  // 普通情况：去掉末段，并吞掉连续重复的分隔符（但不越过根）
  let end = last;
  while (end > rootLen + 1 && (p[end - 1] === "\\" || p[end - 1] === "/")) end--;
  return p.slice(0, end);
}

/** 路径比较键：不区分大小写，且统一分隔符（Windows 语义） */
export function pathKey(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

let toastTimer = 0;
export function toast(msg: string, ms = TOAST_MS): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), ms);
}

export function setTitle(t: string): void {
  document.title = t;
  // Tauri 不联动 document.title，需显式设置原生窗口标题
  try {
    void getCurrentWindow().setTitle(t).catch(() => {});
  } catch { /* 非 Tauri 环境（纯浏览器调试） */ }
}

// ---------- 闲置隐藏控件 ----------

let idleTimer = 0;

function wake() {
  document.body.classList.remove("controls-off");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    document.body.classList.add("controls-off");
  }, IDLE_HIDE_MS);
}

export function attachIdleHider() {
  window.addEventListener("mousemove", wake);
  window.addEventListener("mousedown", wake);
  window.addEventListener("wheel", wake, { passive: true });
  // 键盘 Tab 导航时也要让控件现身，否则焦点落在不可见的按钮上
  window.addEventListener("keydown", (e) => { if (e.key === "Tab") wake(); });
  wake();
}
