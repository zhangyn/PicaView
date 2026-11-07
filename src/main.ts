// PicaView 主装配：状态、加载管线、交互、快捷键

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { ImageEntry } from "./types";
import { Viewer } from "./viewer";
import { Filmstrip } from "./filmstrip";
import { InfoBar, type ExifInfo } from "./infobar";
import { Slideshow } from "./slideshow";
import { Ops } from "./ops";
import { dialogOpen } from "./dialog";
import {
  attachIdleHider, isImageExt, isJpeg, isOpaqueExt, setTitle, toast,
} from "./util";

let entries: ImageEntry[] = [];
let index = -1;
let loadToken = 0;

const viewer = new Viewer();
const strip = new Filmstrip();
const info = new InfoBar();
const slideshow = new Slideshow();
const ops = new Ops({
  onRotated: (path) => {
    tiers.delete(path);
    if (entries[index] && entries[index].path === path) void showCurrent(false);
  },
  onChanged: () => {}, // 由删除/重命名流程直接驱动
});

/** 邻图低清位图缓存（path → 适配视口的 tier） */
const tiers = new Map<string, ImageBitmap>();
const TIER_MAX = 6;

const stage = document.getElementById("stage")!;
const loadingEl = document.getElementById("loading")!;
const emptyEl = document.getElementById("empty")!;
const zoomEl = document.getElementById("zoom-indicator")!;
const errorEl = document.getElementById("load-error")!;
const errorMsgEl = document.getElementById("load-error-msg")!;

// ---------- 图片加载（Rust read_image，规避 asset 协议路径限制） ----------

async function loadBlob(path: string): Promise<Blob> {
  const buf = await invoke<ArrayBuffer>("read_image", { path });
  return new Blob([buf]);
}

/** blob URL 池：动图/兜底 img 通道使用，自动回收旧 URL */
const blobUrlPool: string[] = [];
async function blobUrl(path: string): Promise<string> {
  const url = URL.createObjectURL(await loadBlob(path));
  blobUrlPool.push(url);
  while (blobUrlPool.length > 3) URL.revokeObjectURL(blobUrlPool.shift()!);
  return url;
}

function showError(msg: string) {
  errorMsgEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

function hideError() {
  errorEl.classList.add("hidden");
}

function diag(msg: string) {
  void invoke("append_log", { msg }).catch(() => {});
}

// ---------- 打开 ----------

export async function openPath(p: string) {
  diag(`OPEN ${p}`);
  if (!isImageExt(p)) {
    // 目录：列出并显示第一张
    try {
      entries = await invoke<ImageEntry[]>("list_images", { dir: p });
    } catch {
      toast("无法读取该文件夹");
      return;
    }
    index = entries.length ? 0 : -1;
    afterListChange();
    void showCurrent(true);
    return;
  }
  const dir = p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
  if (!dir) return;
  try {
    entries = await invoke<ImageEntry[]>("list_images", { dir });
  } catch {
    toast("无法读取该文件夹");
    return;
  }
  const lower = p.toLowerCase();
  index = entries.findIndex((e) => e.path.toLowerCase() === lower);
  if (index < 0) {
    // 列表里没有（比如扩展名大小写或刚生成），手动插入
    const st = await statEntry(p);
    if (st) {
      entries.push(st);
      entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
      index = entries.findIndex((e) => e.path.toLowerCase() === lower);
    }
  }
  if (index < 0) {
    toast("不是支持的图片格式");
    return;
  }
  afterListChange();
  void showCurrent(true);
}

async function statEntry(path: string): Promise<ImageEntry | null> {
  // 通过 list_images 的兄弟实现不可行，直接构造最小信息（从 Rust read_file_meta 拿）
  try {
    return await invoke<ImageEntry>("stat_file", { path });
  } catch {
    return null;
  }
}

function afterListChange() {
  strip.rebuild(entries, currentPath());
  strip.ensureAround(entries, Math.max(0, index));
  emptyEl.classList.toggle("hidden", entries.length > 0);
}

function currentPath(): string | null {
  return index >= 0 && index < entries.length ? entries[index].path : null;
}

// ---------- 显示当前 ----------

async function showCurrent(transition: boolean) {
  const entry = entries[index];
  if (!entry) {
    viewer.clear();
    emptyEl.classList.remove("hidden");
    setTitle("PicaView");
    return;
  }
  const token = ++loadToken;
  loadingEl.classList.remove("hidden");
  hideError();
  diag(`SHOW ${entry.name} (${entry.size}B, animated=${entry.animated})`);
  strip.setCurrent(entry.path);
  strip.ensureAround(entries, index);
  info.show(entry, index, entries.length);
  setTitle(`${entry.name} — PicaView`);

  let fullDone = false;

  // 快速路径：EXIF 内嵌预览（仅 JPEG）
  if (isJpeg(entry.path) && !entry.animated) {
    invoke<ArrayBuffer>("extract_preview", { path: entry.path })
      .then(async (buf) => {
        if (token !== loadToken || fullDone || buf.byteLength === 0) return;
        const blob = new Blob([buf], { type: "image/jpeg" });
        const bmp = await createImageBitmap(blob);
        if (token !== loadToken || fullDone) {
          bmp.close();
          return;
        }
        viewer.setBitmap(bmp, { preview: true });
      })
      .catch(() => {});
  }

  // 全图
  try {
    if (entry.animated) {
      const url = await blobUrl(entry.path);
      await viewer.showUrl(url, !isOpaqueExt(entry.path));
      if (token !== loadToken) return;
      fullDone = true;
      info.updateMeta({ w: viewer.view!.iw, h: viewer.view!.ih }, null);
    } else {
      const blob = await loadBlob(entry.path);
      if (token !== loadToken) return;
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(blob);
      } catch {
        // 位图解码失败（超大尺寸等）→ img 通道兜底，浏览器可解码任意尺寸
        const url = await blobUrl(entry.path);
        await viewer.showUrl(url, !isOpaqueExt(entry.path));
        if (token !== loadToken) return;
        fullDone = true;
        info.updateMeta({ w: viewer.view!.iw, h: viewer.view!.ih }, null);
        return;
      }
      if (token !== loadToken) {
        bmp.close();
        return;
      }
      fullDone = true;
      viewer.setBitmap(bmp, {
        alpha: !isOpaqueExt(entry.path),
        transition,
      });
      info.updateMeta({ w: bmp.width, h: bmp.height }, null);
      diag(`DECODE OK ${entry.name} ${bmp.width}x${bmp.height}`);
    }
  } catch (e) {
    diag(`LOAD FAIL ${entry.name}: ${String(e)}`);
    if (token === loadToken) showError(`无法打开「${entry.name}」：${String(e)}`);
  } finally {
    if (token === loadToken) loadingEl.classList.add("hidden");
  }

  // EXIF 拍摄信息
  if (isJpeg(entry.path)) {
    invoke<ExifInfo | null>("read_exif", { path: entry.path })
      .then((ex) => {
        if (token === loadToken && ex) info.updateMeta(null, ex);
      })
      .catch(() => {});
  }

  preloadTier(index + 1);
  preloadTier(index - 1);
}

/** 邻图预加载：解码为视口大小 tier，内存占用极小 */
function preloadTier(i: number) {
  const entry = entries[i];
  if (!entry || entry.animated || tiers.has(entry.path)) return;
  const path = entry.path;
  loadBlob(path)
    .then(async (blob) => {
      const full = await createImageBitmap(blob);
      const vw = Math.round(stage.clientWidth * viewer.dpr);
      const scale = Math.min(1, (vw * 1.25) / full.width);
      const tier = await createImageBitmap(full, {
        resizeWidth: Math.max(1, Math.round(full.width * scale)),
        resizeQuality: "high",
      });
      full.close();
      if (tiers.size >= TIER_MAX) {
        const oldest = tiers.keys().next().value as string | undefined;
        if (oldest) {
          tiers.get(oldest)?.close();
          tiers.delete(oldest);
        }
      }
      tiers.set(path, tier);
    })
    .catch(() => {});
}

/** 用 tier 立即显示，再后台补全图（翻页瞬时响应） */
async function showFromTier(entry: ImageEntry): Promise<boolean> {
  const tier = tiers.get(entry.path);
  if (!tier) return false;
  const copy = await createImageBitmap(tier);
  viewer.setBitmap(copy, { alpha: !isOpaqueExt(entry.path) });
  return true;
}

// ---------- 翻页 ----------

function nav(delta: number, wrap = false) {
  if (!entries.length) return;
  let i = index + delta;
  if (i >= entries.length) {
    if (!wrap) return;
    i = 0;
  }
  if (i < 0) {
    if (!wrap) return;
    i = entries.length - 1;
  }
  jumpTo(i);
}

function jumpTo(i: number) {
  const entry = entries[i];
  if (!entry) return;
  index = i;
  strip.setCurrent(entry.path);
  info.show(entry, index, entries.length);
  setTitle(`${entry.name} — PicaView`);
  strip.ensureAround(entries, index);
  if (entry.animated) {
    void showCurrent(true);
  } else {
    // tier 快速显示 + 后台全图
    void (async () => {
      const token = ++loadToken;
      const shown = await showFromTier(entry);
      if (token === loadToken && shown) {
        void showCurrentFullQuiet(token, entry);
      } else {
        void showCurrent(true);
      }
      preloadTier(index + 1);
      preloadTier(index - 1);
    })();
  }
}

/** tier 已显示后补全图（静默替换） */
async function showCurrentFullQuiet(token: number, entry: ImageEntry) {
  loadingEl.classList.remove("hidden");
  try {
    const blob = await loadBlob(entry.path);
    const bmp = await createImageBitmap(blob);
    if (token !== loadToken) {
      bmp.close();
      return;
    }
    viewer.setBitmap(bmp, { alpha: !isOpaqueExt(entry.path), transition: false });
    info.updateMeta({ w: bmp.width, h: bmp.height }, null);
    if (isJpeg(entry.path)) {
      invoke<ExifInfo | null>("read_exif", { path: entry.path })
        .then((ex) => { if (token === loadToken && ex) info.updateMeta(null, ex); })
        .catch(() => {});
    }
  } catch (e) {
    if (token === loadToken) showError(`无法打开「${entry.name}」：${String(e)}`);
  } finally {
    if (token === loadToken) loadingEl.classList.add("hidden");
  }
}

// ---------- 缩放滑块 ----------

// ---------- 文件操作 ----------

async function doRotate(clockwise: boolean) {
  const entry = entries[index];
  if (entry) await ops.rotate(entry, clockwise);
}

async function doRename() {
  const entry = entries[index];
  if (!entry) return;
  const updated = await ops.rename(entry);
  if (!updated) return;
  strip.rename(entry.path, updated);
  entries[index] = updated;
  tiers.delete(entry.path);
  info.show(updated, index, entries.length);
  setTitle(`${updated.name} — PicaView`);
  void showCurrent(false);
}

async function doDelete(permanent: boolean) {
  const entry = entries[index];
  if (!entry) return;
  const ok = await ops.remove(entry, permanent);
  if (!ok) return;
  tiers.delete(entry.path);
  entries.splice(index, 1);
  if (!entries.length) {
    index = -1;
    afterListChange();
    void showCurrent(false);
    return;
  }
  index = Math.min(index, entries.length - 1);
  strip.rebuild(entries, entries[index].path);
  void showCurrent(true);
}

// ---------- 缩放指示 + 滑块 ----------

const zoomSlider = document.getElementById("zoom-slider") as HTMLInputElement;
const zoomPctLabel = document.getElementById("zoom-pct")!;
let sliderDragging = false;

/** 滑块位置 0-100 ↔ 缩放百分比（对数映射：下限=适应×0.1，上限=400%） */
function sliderRange(): { lo: number; hi: number } {
  const fit = Math.max(viewer.fitPct(), 1);
  return { lo: fit * 0.1, hi: Math.max(400, fit) };
}
function sliderToPct(t: number): number {
  const { lo, hi } = sliderRange();
  return Math.exp(Math.log(lo) + (t / 100) * (Math.log(hi) - Math.log(lo)));
}
function pctToSlider(pct: number): number {
  const { lo, hi } = sliderRange();
  const c = Math.min(Math.max(pct, lo), hi);
  return ((Math.log(c) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100;
}

zoomSlider.addEventListener("pointerdown", () => (sliderDragging = true));
window.addEventListener("pointerup", () => (sliderDragging = false));
zoomSlider.addEventListener("input", () => {
  viewer.setZoomPct(sliderToPct(parseFloat(zoomSlider.value)));
});

let zoomTimer = 0;
viewer.onPaint = (pct) => {
  if (!viewer.view) return;
  const fit = Math.abs(pct - viewer.fitPct()) < 0.5;
  const label = `${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%${fit ? " (适应)" : ""}`;
  zoomPctLabel.textContent = label;
  zoomEl.textContent = label;
  zoomEl.classList.remove("hidden");
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => zoomEl.classList.add("hidden"), 900);
  if (!sliderDragging) zoomSlider.value = String(pctToSlider(pct));
};

// ---------- 交互：滚轮 / 拖拽 / 双击 / 侧键 ----------

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!viewer.view) return;
  const rect = stage.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const factor = Math.pow(1.2, -Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100));
  viewer.zoomAt(cx, cy, factor);
}, { passive: false });

let panning = false;
let lastX = 0, lastY = 0;

stage.addEventListener("pointerdown", (e) => {
  // 无边框模式下：右键拖动 = 移动窗口
  if (e.button === 2 && document.body.classList.contains("frameless")) {
    e.preventDefault();
    void getCurrentWindow().startDragging();
    return;
  }
  if (e.button === 3) { nav(-1); e.preventDefault(); return; }
  if (e.button === 4) { nav(1); e.preventDefault(); return; }
  if (e.button !== 0 || !viewer.view) return;
  panning = true;
  lastX = e.clientX;
  lastY = e.clientY;
  stage.setPointerCapture(e.pointerId);
  stage.style.cursor = "grabbing";
});

stage.addEventListener("pointermove", (e) => {
  if (!panning) return;
  viewer.panBy(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX;
  lastY = e.clientY;
});

stage.addEventListener("pointerup", (e) => {
  panning = false;
  stage.style.cursor = "";
  if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
});

stage.addEventListener("dblclick", (e) => {
  e.preventDefault();
  viewer.toggleFitActual();
});

stage.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- 快捷键 ----------

window.addEventListener("keydown", (e) => {
  if (dialogOpen()) return; // 对话框自行处理
  const meta = e.ctrlKey || e.metaKey;

  // 屏蔽 WebView 默认行为
  if (e.key === "F5" || (meta && (e.key === "r" || e.key === "R"))) {
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      if (viewer.isZoomed()) viewer.panBy(stage.clientWidth * 0.15, 0);
      else nav(-1);
      break;
    case "ArrowRight":
      e.preventDefault();
      if (viewer.isZoomed()) viewer.panBy(-stage.clientWidth * 0.15, 0);
      else nav(1);
      break;
    case "ArrowUp":
      if (viewer.isZoomed()) { e.preventDefault(); viewer.panBy(0, stage.clientHeight * 0.15); }
      break;
    case "ArrowDown":
      if (viewer.isZoomed()) { e.preventDefault(); viewer.panBy(0, -stage.clientHeight * 0.15); }
      break;
    case "Home":
      if (entries.length) jumpTo(0);
      break;
    case "End":
      if (entries.length) jumpTo(entries.length - 1);
      break;
    case "+":
    case "=":
      e.preventDefault();
      viewer.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.25);
      break;
    case "-":
      e.preventDefault();
      viewer.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 0.8);
      break;
    case "1":
      viewer.actualSize();
      break;
    case "f":
    case "F":
      viewer.fit();
      break;
    case "Enter":
    case "F11":
      e.preventDefault();
      void toggleFullscreen();
      break;
    case "s":
    case "S":
      slideshow.toggle();
      break;
    case "t":
    case "T":
      strip.toggle();
      break;
    case "i":
    case "I":
      info.toggle();
      break;
    case "l":
    case "L":
      void doRotate(false);
      break;
    case "b":
    case "B":
      void toggleFrameless();
      break;
    case "m":
    case "M":
      toggleMask();
      break;
    case "r":
    case "R":
      if (!meta) void doRotate(true);
      break;
    case "F2":
      e.preventDefault();
      void doRename();
      break;
    case "Delete":
      e.preventDefault();
      void doDelete(e.shiftKey);
      break;
    case "Escape": {
      if (slideshow.playing) { slideshow.stop(); break; }
      void (async () => {
        const w = getCurrentWindow();
        if (await w.isFullscreen()) {
          await applyFullscreen(false);
          return;
        }
        if (document.body.classList.contains("frameless")) {
          void toggleFrameless();
          return;
        }
        if (!viewer.isZoomed() && viewer.view) viewer.fit();
      })();
      break;
    }
  }
});

// ---------- 全屏（含蒙板联动：全屏自动开蒙板，退出恢复原状） ----------

const framelessBtn = document.getElementById("btn-frameless")!;
const maskBtn = document.getElementById("btn-mask")!;
let maskAutoByFs = false;

async function applyFullscreen(on: boolean) {
  const w = getCurrentWindow();
  await w.setFullscreen(on);
  diag(`FS ${on ? "ON" : "OFF"} mask=${viewer.maskOn}`);
  if (on) {
    if (!viewer.maskOn) {
      viewer.setMask(true);
      maskBtn.classList.add("active");
      maskAutoByFs = true;
    }
  } else if (maskAutoByFs) {
    viewer.setMask(false);
    maskBtn.classList.remove("active");
    maskAutoByFs = false;
  }
}

async function toggleFullscreen() {
  const w = getCurrentWindow();
  const fs = await w.isFullscreen();
  await applyFullscreen(!fs);
}

// ---------- 只看图片模式（无边框） ----------

async function toggleFrameless() {
  const w = getCurrentWindow();
  const oldDecorated = await w.isDecorated();
  const newDecorated = !oldDecorated;
  await w.setDecorations(newDecorated);
  const framelessNow = !newDecorated;
  document.body.classList.toggle("frameless", framelessNow);
  framelessBtn.classList.toggle("active", framelessNow);
  if (framelessNow) {
    toast("只看图片模式：右键拖动移动窗口，B 或 Esc 退出");
  }
}

// ---------- 蒙板 ----------

function toggleMask() {
  viewer.setMask(!viewer.maskOn);
  maskBtn.classList.toggle("active", viewer.maskOn);
}

/** 蒙板按钮 = 灯箱模式：未全屏时先进全屏（自动开蒙板），已全屏则切换蒙板 */
async function maskLightbox() {
  const w = getCurrentWindow();
  if (!(await w.isFullscreen())) {
    await applyFullscreen(true);
    return;
  }
  toggleMask();
}

// ---------- 控制按钮 ----------

function svgIcon(paths: string, viewBox = "0 0 24 24"): string {
  return `<svg viewBox="${viewBox}">${paths}</svg>`;
}

(document.getElementById("btn-rot-ccw") as HTMLElement).innerHTML =
  svgIcon(`<path d="M3 8a9 9 0 1 1 2.6 8.4"/><path d="M3 3v5h5"/>`);
(document.getElementById("btn-rot-cw") as HTMLElement).innerHTML =
  svgIcon(`<path d="M21 8a9 9 0 1 0-2.6 8.4"/><path d="M21 3v5h-5"/>`);
(document.getElementById("btn-slideshow") as HTMLElement).innerHTML =
  svgIcon(`<path d="M7 4.5v15l12-7.5z"/>`);
(document.getElementById("btn-mask") as HTMLElement).innerHTML =
  svgIcon(`<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" opacity="0.85"/>`);
(document.getElementById("btn-frameless") as HTMLElement).innerHTML =
  svgIcon(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18" stroke-dasharray="2.5 2.5"/>`);
(document.getElementById("btn-filmstrip") as HTMLElement).innerHTML =
  svgIcon(`<rect x="2.5" y="7" width="19" height="10" rx="1.5"/><path d="M6.5 7v10M11 7v10M15.5 7v10M19.5 7v10M2.5 12h19" stroke-width="1.2"/>`);
(document.getElementById("btn-fullscreen") as HTMLElement).innerHTML =
  svgIcon(`<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`);

document.getElementById("btn-rot-ccw")!.addEventListener("click", () => void doRotate(false));
document.getElementById("btn-rot-cw")!.addEventListener("click", () => void doRotate(true));
document.getElementById("btn-slideshow")!.addEventListener("click", () => slideshow.toggle());
document.getElementById("btn-mask")!.addEventListener("click", () => void maskLightbox());
document.getElementById("btn-frameless")!.addEventListener("click", () => void toggleFrameless());
document.getElementById("btn-filmstrip")!.addEventListener("click", () => strip.toggle());
document.getElementById("btn-fullscreen")!.addEventListener("click", () => void toggleFullscreen());
document.getElementById("nav-prev")!.addEventListener("click", () => nav(-1));
document.getElementById("nav-next")!.addEventListener("click", () => nav(1));

slideshow.onNext = () => nav(1, true);
slideshow.fullscreenHandler = (on) => void applyFullscreen(on);

strip.onPick = (i) => {
  index = i;
  void showCurrent(true);
};

// ---------- 显示状态防御：任何显示状态变化都强制重绘 ----------

viewer.onRafSuspended = () => diag("rAF 被暂停（窗口遮挡/最小化），已同步绘制兜底");
window.addEventListener("focus", () => viewer.resize());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) viewer.resize();
});
new ResizeObserver(() => viewer.resize()).observe(stage);

// 调试句柄（仅开发用）
(window as any).__pv = { viewer, strip, info };

// 帧保活：页面可见时每 1.5s 补推一帧，对抗合成器丢帧/呈现冻结
setInterval(() => {
  if (!document.hidden && viewer.view) viewer.paint();
}, 1500);

// ---------- 拖拽打开 ----------

const dropHint = document.getElementById("drop-hint")!;

getCurrentWebview()
  .onDragDropEvent((ev) => {
    const p = ev.payload;
    if (p.type === "enter" || p.type === "over") {
      dropHint.classList.remove("hidden");
    } else if (p.type === "leave") {
      dropHint.classList.add("hidden");
    } else if (p.type === "drop") {
      dropHint.classList.add("hidden");
      const path = p.paths[0];
      if (path) void openPath(path);
    }
  })
  .catch(() => {});

// ---------- 单实例 / 启动参数 ----------

listen<string>("open-file", (ev) => {
  if (ev.payload) void openPath(ev.payload);
}).catch(() => {});

// ---------- 启动 ----------

attachIdleHider();
strip.setVisible(true); // 默认显示胶片条
document.body.classList.add("has-strip");

(async () => {
  // 启动参数（文件关联 / 手动传入）
  try {
    const args = await invoke<string[]>("cli_args");
    const target = args.find((a) => a && !a.startsWith("-"));
    if (target) {
      await openPath(target);
      return;
    }
  } catch { /* ignore */ }
  emptyEl.classList.remove("hidden");
})();
