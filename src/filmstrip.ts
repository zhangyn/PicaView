// 底部缩略图胶片条：懒加载 + 磁盘缓存（Rust 侧）+ 内存位图缓存

import { invoke } from "@tauri-apps/api/core";
import type { ImageEntry } from "./types";

const THUMB_W = 128;
const THUMB_H = 88;
const MAX_CACHED = 240; // 内存位图上限

export class Filmstrip {
  private root: HTMLElement;
  private strip: HTMLElement;
  private canvases = new Map<string, HTMLCanvasElement>();
  private bitmaps = new Map<string, ImageBitmap>();
  private pending = new Set<string>();
  visible = true;
  onPick: ((index: number) => void) | null = null;

  constructor() {
    this.root = document.getElementById("filmstrip")!;
    this.strip = document.getElementById("thumbs")!;
  }

  toggle(): boolean {
    return this.setVisible(!this.visible);
  }

  setVisible(v: boolean): boolean {
    this.visible = v;
    this.root.classList.toggle("hidden", !v);
    document.body.classList.toggle("has-strip", v);
    return v;
  }

  /** 列表变化时重建 DOM */
  rebuild(entries: ImageEntry[], currentPath: string | null) {
    this.strip.textContent = "";
    this.canvases.clear();
    for (const c of this.bitmaps.values()) c.close();
    this.bitmaps.clear();
    this.pending.clear();

    entries.forEach((e, i) => {
      const cv = document.createElement("canvas");
      cv.className = "thumb";
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(THUMB_W * dpr);
      cv.height = Math.round(THUMB_H * dpr);
      cv.title = e.name;
      cv.addEventListener("click", () => this.onPick?.(i));
      this.strip.appendChild(cv);
      this.canvases.set(e.path, cv);
    });
    this.setCurrent(currentPath);
  }

  /** 请求可见范围附近的缩略图 */
  ensureAround(entries: ImageEntry[], index: number, radius = 14) {
    const lo = Math.max(0, index - radius);
    const hi = Math.min(entries.length - 1, index + radius);
    for (let i = lo; i <= hi; i++) this.request(entries[i]);
  }

  private request(entry: ImageEntry) {
    if (this.bitmaps.has(entry.path) || this.pending.has(entry.path)) return;
    this.pending.add(entry.path);
    invoke<ArrayBuffer>("thumbnail", { path: entry.path })
      .then(async (buf) => {
        this.pending.delete(entry.path);
        if (buf.byteLength === 0) return;
        const blob = new Blob([buf], { type: "image/jpeg" });
        const bmp = await createImageBitmap(blob);
        // 内存上限：逐出最早的
        if (this.bitmaps.size >= MAX_CACHED) {
          const oldest = this.bitmaps.keys().next().value as string | undefined;
          if (oldest && !this.pending.has(oldest)) {
            this.bitmaps.get(oldest)?.close();
            this.bitmaps.delete(oldest);
          }
        }
        this.bitmaps.set(entry.path, bmp);
        this.draw(entry.path);
      })
      .catch(() => this.pending.delete(entry.path));
  }

  private draw(path: string) {
    const cv = this.canvases.get(path);
    const bmp = this.bitmaps.get(path);
    if (!cv || !bmp) return;
    const ctx = cv.getContext("2d")!;
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const s = Math.min(w / bmp.width, h / bmp.height);
    ctx.drawImage(bmp, (w - bmp.width * s) / 2, (h - bmp.height * s) / 2,
      bmp.width * s, bmp.height * s);
  }

  setCurrent(path: string | null) {
    for (const [p, cv] of this.canvases) {
      cv.classList.toggle("current", p === path);
      if (p === path) {
        // 滚动到可见（平滑）
        const strip = this.strip.parentElement!;
        const left = cv.offsetLeft - strip.clientWidth / 2 + cv.offsetWidth / 2;
        strip.scrollTo({ left, behavior: "smooth" });
      }
    }
  }

  /** 重命名后：换 key 重画 */
  rename(oldPath: string, entry: ImageEntry) {
    const cv = this.canvases.get(oldPath);
    const bmp = this.bitmaps.get(oldPath);
    this.canvases.delete(oldPath);
    this.bitmaps.delete(oldPath);
    if (cv) {
      cv.title = entry.name;
      this.canvases.set(entry.path, cv);
    }
    if (bmp) this.bitmaps.set(entry.path, bmp);
  }
}
