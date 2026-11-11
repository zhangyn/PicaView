// PicaView 主装配：状态、加载管线、交互、快捷键

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { ExifInfo, ImageEntry } from "./types";
import { Viewer } from "./viewer";
import { Filmstrip } from "./filmstrip";
import { InfoBar } from "./infobar";
import { Slideshow } from "./slideshow";
import { Ops } from "./ops";
import { dialogOpen } from "./dialog";
import { DetailsPanel } from "./details";
import { isPicking, pickImage } from "./picker";
import { TaskQueue } from "./queue";
import {
  BLOB_URL_POOL_MAX, FULL_LOAD_DEBOUNCE_MS, KEEPALIVE_MS, KEY_PAN_RATIO, KEY_ZOOM_STEP,
  LIGHTBOX_FIT_RATIO, LIGHTBOX_HINT_MS, LOADING_DELAY_MS, LOD_MIN_LONG_SIDE, LOD_UPGRADE_AT,
  LOD_VIEW_SCALE, PRELOAD_CONCURRENCY, PRELOAD_DELAY_MS,
  SHOW_WINDOW_FALLBACK_MS, SLIDER_MAX_PCT, SLIDER_MIN_FIT_FACTOR, TIER_MAX, TIER_MIN_PX,
  TIER_MIN_VIEWPORT_PX, TIER_SCALE, WHEEL_ZOOM_BASE, ZOOM_INDICATOR_MS,
} from "./config";
import {
  attachIdleHider, dirname, isImageExt, isJpeg, isOpaqueExt, normalizeWheelDelta, pathKey,
  peekImageSize, setTitle, toast,
} from "./util";

let entries: ImageEntry[] = [];
let index = -1;
/** 显示请求令牌：每次切图自增，所有 await 之后都要核对，过期即放弃 */
let loadToken = 0;
/** 打开请求令牌：重复 openPath 时作废旧的 */
let openToken = 0;
/** 目录列表是否就绪。openPath 先显示单张、列表后到，期间禁用翻页/删除/重命名 */
let listReady = true;

const viewer = new Viewer();
const strip = new Filmstrip();
const info = new InfoBar();
const slideshow = new Slideshow();
const details = new DetailsPanel();
const ops = new Ops({
  onRotated: (path) => {
    invalidateTier(path);
    strip.invalidate(path); // 胶片条里的缩略图还是旋转前的，必须重新生成
    void refreshEntryMeta(path); // 无损旋转会改动文件大小/修改时间
    if (entries[index] && pathKey(entries[index].path) === pathKey(path)) void showCurrent(false);
  },
});

const stage = document.getElementById("stage")!;
const loadingEl = document.getElementById("loading")!;
const emptyEl = document.getElementById("empty")!;
const zoomEl = document.getElementById("zoom-indicator")!;
const errorEl = document.getElementById("load-error")!;
const errorMsgEl = document.getElementById("load-error-msg")!;

// ---------- 邻图低清位图缓存（tier） ----------

/** path → 适配视口的低清位图 */
const tiers = new Map<string, ImageBitmap>();
/** 每个 path 的版本号：旋转/重命名/删除后自增，使在途的预加载结果作废 */
const tierVer = new Map<string, number>();
/** 预加载并发上限（统一限流） */
const preloadQueue = new TaskQueue(PRELOAD_CONCURRENCY);

function invalidateTier(path: string) {
  tierVer.set(path, (tierVer.get(path) ?? 0) + 1);
  tiers.get(path)?.close();
  tiers.delete(path);
}

function storeTier(path: string, tier: ImageBitmap) {
  tiers.get(path)?.close();
  tiers.delete(path);
  while (tiers.size >= TIER_MAX) {
    const oldest = tiers.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    tiers.get(oldest)?.close();
    tiers.delete(oldest);
  }
  tiers.set(path, tier);
}

// ---------- LOD：超大图先按视口降采样解码 ----------

/** 当前显示的是降采样位图（原图尚未加载）；null 表示已经是原图 */
let lodPath: string | null = null;
/** 原图补载进行中 */
let lodBusy = false;

/**
 * LOD 决策：源图像长边超过"视口设备长边 × LOD_VIEW_SCALE"时降采样解码，
 * 否则返回空（按原样解码，与以前完全一致）。
 * 同时返回源图的显示尺寸（infoBar 要显示真实尺寸，而不是降采样后的）。
 */
function lodPlan(
  buf: ArrayBuffer,
  orientation: number,
): { opts?: ImageBitmapOptions; dims?: { w: number; h: number } } {
  const dim = peekImageSize(new Uint8Array(buf));
  if (!dim) return {}; // 文件头无法识别：交给浏览器原样解码
  // EXIF 5..8 会把显示宽高互换
  const dims = orientation >= 5 ? { w: dim.h, h: dim.w } : { w: dim.w, h: dim.h };
  const viewLong = Math.max(stage.clientWidth, stage.clientHeight) * viewer.dpr;
  const limit = Math.max(LOD_MIN_LONG_SIDE, Math.round(viewLong * LOD_VIEW_SCALE));
  const longest = Math.max(dims.w, dims.h);
  if (longest <= limit) return { dims };
  const k = limit / longest;
  return {
    dims,
    opts: {
      resizeWidth: Math.max(1, Math.round(dims.w * k)),
      resizeHeight: Math.max(1, Math.round(dims.h * k)),
      resizeQuality: "high",
    },
  };
}

/** 放大到"1 位图像素 ≥ 1 设备像素"时，后台补一次原图（保持当前缩放与位置） */
function maybeUpgradeLod() {
  const p = viewer.view;
  // 设备像素/源像素 达到阈值（约等于放大到 100%）才需要原图
  if (!lodPath || lodBusy || !p || p.scale * viewer.lodRatio < LOD_UPGRADE_AT) return;
  const entry = entries[index];
  if (!entry || pathKey(entry.path) !== pathKey(lodPath)) return;
  const path = entry.path;
  const token = loadToken;
  lodBusy = true;
  void (async () => {
    try {
      const bmp = await createImageBitmap(new Blob([await readImageBuf(path)]));
      if (token !== loadToken) {
        bmp.close();
        return;
      }
      lodPath = null;
      viewer.setBitmap(bmp, { alpha: !isOpaqueExt(path), keepView: true });
      info.updateMeta({ w: bmp.width, h: bmp.height }, null);
      diag(`LOD FULL ${entry.name} ${bmp.width}x${bmp.height}`);
    } catch (e) {
      diag(`LOAD FAIL LOD ${entry.name}: ${String(e)}`); // 保持降采样图
    } finally {
      lodBusy = false;
    }
  })();
}

// ---------- 图片加载（Rust read_image，规避 asset 协议路径限制） ----------

function readImageBuf(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_image", { path });
}

async function loadBlob(path: string): Promise<Blob> {
  return new Blob([await readImageBuf(path)]);
}

/** blob URL 池：动图/兜底 img 通道使用，自动回收旧 URL */
const blobUrlPool: string[] = [];
async function blobUrl(path: string): Promise<string> {
  const url = URL.createObjectURL(await loadBlob(path));
  blobUrlPool.push(url);
  while (blobUrlPool.length > BLOB_URL_POOL_MAX) URL.revokeObjectURL(blobUrlPool.shift()!);
  return url;
}

function releaseBlobUrl(url: string) {
  const i = blobUrlPool.indexOf(url);
  if (i >= 0) blobUrlPool.splice(i, 1);
  URL.revokeObjectURL(url);
}

function showError(msg: string) {
  errorMsgEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

function hideError() {
  errorEl.classList.add("hidden");
}

/** loading 指示：延迟显示，快速加载不闪烁；关闭时立即隐藏并取消计时器 */
let loadingTimer = 0;
function setLoading(on: boolean) {
  if (on) {
    if (loadingTimer || !loadingEl.classList.contains("hidden")) return;
    loadingTimer = window.setTimeout(() => {
      loadingTimer = 0;
      loadingEl.classList.remove("hidden");
    }, LOADING_DELAY_MS);
  } else {
    clearTimeout(loadingTimer);
    loadingTimer = 0;
    loadingEl.classList.add("hidden");
  }
}

/** 诊断日志：只有出错路径（含 FAIL）才写入后端日志文件；其余仅开发模式下输出到控制台 */
function diag(msg: string) {
  if (msg.includes("FAIL")) {
    void invoke("append_log", { msg }).catch(() => {});
  } else if (import.meta.env.DEV) {
    console.debug(`[pv] ${msg}`);
  }
}

// ---------- 打开 ----------

type ListResult = { ok: true; list: ImageEntry[] } | { ok: false };

function fetchList(dir: string): Promise<ListResult> {
  return invoke<ImageEntry[]>("list_images", { dir }).then(
    (list): ListResult => ({ ok: true, list }),
    (): ListResult => ({ ok: false }),
  );
}

function findInList(list: ImageEntry[], ...paths: string[]): number {
  const keys = paths.map(pathKey);
  return list.findIndex((e) => keys.includes(pathKey(e.path)));
}

export async function openPath(p: string) {
  diag(`OPEN ${p}`);
  const myOpen = ++openToken;
  if (!isImageExt(p)) await openDirectory(p, myOpen);
  else await openImage(p, myOpen);
}

/** 弹出系统"打开文件"对话框并打开所选图片；取消则无事发生 */
async function openFileDialog() {
  if (isPicking()) return;
  if (slideshow.playing) slideshow.stop(); // 系统对话框期间不让幻灯片在后台继续翻页
  const p = await pickImage();
  if (p) void openPath(p);
}

/** 打开目录：列出并显示第一张 */
async function openDirectory(dir: string, myOpen: number) {
  listReady = false;
  setLoading(true);
  const res = await fetchList(dir);
  if (myOpen !== openToken) return; // 已被更新的 openPath 接管
  if (!res.ok) {
    listReady = true;
    setLoading(false);
    toast("无法读取该文件夹");
    return;
  }
  entries = res.list;
  index = entries.length ? 0 : -1;
  listReady = true;
  afterListChange();
  await engageLightboxForOpen();
  if (myOpen !== openToken) return;
  void showCurrent(true);
}

/**
 * 打开单张图片：先 stat 这一张并立即显示，同时并行取目录列表；
 * 列表返回后以后端排序为准合并，重新定位当前索引，胶片条只重建一次。
 */
async function openImage(p: string, myOpen: number) {
  const dir = dirname(p);
  if (!dir) return;
  listReady = false;
  const listP = fetchList(dir);
  const st = await statEntry(p);
  if (myOpen !== openToken) return;

  if (!st) {
    // stat 失败（文件不存在 / 不是图片）：退回"等列表再判断"的串行流程
    const res = await listP;
    if (myOpen !== openToken) return;
    listReady = true;
    if (!res.ok) {
      toast("无法读取该文件夹");
      return;
    }
    const i = findInList(res.list, p);
    if (i < 0) {
      toast("不是支持的图片格式");
      return;
    }
    entries = res.list;
    index = i;
    afterListChange();
    await engageLightboxForOpen();
    if (myOpen !== openToken) return;
    void showCurrent(true);
    return;
  }

  // 先显示这一张；列表就绪前只有它，翻页等操作被忽略
  entries = [st];
  index = 0;
  strip.rebuild([], null); // 清掉上一目录的缩略图，列表就绪后一次性重建
  emptyEl.classList.add("hidden");
  // 灯箱样式必须在图片首次绘制之前生效，否则会先看到铺满窗口的图
  await engageLightboxForOpen();
  if (myOpen !== openToken) return;
  void showCurrent(true);

  // 合并列表
  const res = await listP;
  if (myOpen !== openToken) return;
  if (!res.ok) {
    listReady = true; // 只剩这一张，可正常操作
    toast("无法读取该文件夹");
    return;
  }
  let list = res.list;
  let i = findInList(list, st.path, p);
  if (i < 0) {
    // 列表里没有（比如文件刚生成）：重新取一次后端排序结果，不在前端自己排序
    const again = await fetchList(dir);
    if (myOpen !== openToken) return;
    if (again.ok) list = again.list;
    i = findInList(list, st.path, p);
    if (i < 0) {
      list = [...list, st]; // 后端始终不认：追加到末尾，保证当前图仍可见
      i = list.length - 1;
    }
  }
  entries = list;
  index = i;
  listReady = true;
  afterListChange();
  info.setPosition(entries[index], index, entries.length);
}

/** 打开图片前的灯箱介入：窗口已全屏则直接挂样式，否则进全屏 */
async function engageLightboxForOpen() {
  if (lightboxOn) return;
  const w = getCurrentWindow();
  if (await w.isFullscreen()) {
    enterLightbox();
    return;
  }
  await applyFullscreen(true);
}

async function statEntry(path: string): Promise<ImageEntry | null> {
  try {
    return await invoke<ImageEntry>("stat_file", { path });
  } catch {
    return null;
  }
}

/** 就地改写文件（旋转）后回读元数据，修正列表与信息栏里的旧大小/时间 */
async function refreshEntryMeta(path: string) {
  const st = await statEntry(path);
  if (!st) return;
  const i = entries.findIndex((e) => pathKey(e.path) === pathKey(path));
  if (i < 0) return;
  entries[i] = st;
  if (i === index) info.setPosition(st, index, entries.length);
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

let fullTimer = 0;
let preloadTimer = 0;
let lastNavAt = 0;

/** 取消尚未开始的完整图加载与预加载（切图时调用） */
function cancelPending() {
  clearTimeout(fullTimer);
  clearTimeout(preloadTimer);
  preloadQueue.clear();
}

/** 完整加载当前图（打开 / 重新加载 / 旋转后） */
async function showCurrent(transition: boolean) {
  const entry = entries[index];
  const token = ++loadToken;
  cancelPending();
  hideError();
  details.setPath(entry ? entry.path : null);
  if (!entry) {
    setLoading(false);
    viewer.clear();
    emptyEl.classList.remove("hidden");
    setTitle("PicaView");
    return;
  }
  diag(`SHOW ${entry.name} (${entry.size}B, animated=${entry.animated})`);
  strip.setCurrent(entry.path);
  strip.ensureAround(entries, index);
  info.show(entry, index, entries.length);
  setTitle(`${entry.name} — PicaView`);
  await loadFull(token, entry, { transition, preview: true, keepView: false });
}

interface FullOpts {
  /** 与上一张交叉淡入 */
  transition: boolean;
  /** 先用 JPEG 内嵌 EXIF 预览快速出图 */
  preview: boolean;
  /** 保留当前缩放/平移（tier → 全图的静默替换） */
  keepView: boolean;
}

/** 读取并显示完整图。每个 await 之后都核对 token，过期则释放资源并放弃 */
async function loadFull(token: number, entry: ImageEntry, o: FullOpts) {
  setLoading(true);
  let fullDone = false;
  let exifInfo: ExifInfo | null = null;
  lodPath = null; // 新的一次加载接管，上一张的 LOD 状态作废

  // 快速路径：EXIF 内嵌预览（仅 JPEG）
  if (o.preview && isJpeg(entry.path) && !entry.animated) {
    invoke<ArrayBuffer>("extract_preview", { path: entry.path })
      .then(async (buf) => {
        if (token !== loadToken || fullDone || buf.byteLength === 0) return;
        const bmp = await createImageBitmap(new Blob([buf], { type: "image/jpeg" }));
        if (token !== loadToken || fullDone) {
          bmp.close();
          return;
        }
        viewer.setBitmap(bmp, {});
      })
      .catch(() => {});
  }

  try {
    if (entry.animated) {
      fullDone = await showViaImg(token, entry);
    } else {
      // EXIF 与本图字节并行读取：方向决定"显示尺寸"，LOD 降采样要用到，
      // 顺便省掉加载完成后的一次重复请求
      const exifP = isJpeg(entry.path)
        ? invoke<ExifInfo | null>("read_exif", { path: entry.path }).catch(() => null)
        : Promise.resolve(null);
      const buf = await readImageBuf(entry.path);
      if (token !== loadToken) return;
      exifInfo = await exifP;
      if (token !== loadToken) return;
      const plan = lodPlan(buf, exifInfo?.orientation ?? 1);
      let bmp: ImageBitmap | null = null;
      try {
        bmp = await createImageBitmap(new Blob([buf]), plan.opts);
      } catch {
        // 位图解码失败（超大尺寸等）→ 下面走 img 通道兜底，浏览器可解码任意尺寸
      }
      if (token !== loadToken) {
        bmp?.close();
        return;
      }
      if (bmp) {
        fullDone = true;
        viewer.setBitmap(bmp, {
          alpha: !isOpaqueExt(entry.path),
          transition: o.transition,
          keepView: o.keepView,
          srcWidth: plan.dims?.w,
        });
        // 尺寸用源图的真实显示尺寸，而不是降采样后的位图尺寸
        info.updateMeta(plan.dims ?? { w: bmp.width, h: bmp.height }, null);
        lodPath = plan.opts ? entry.path : null;
        diag(`DECODE OK ${entry.name} ${bmp.width}x${bmp.height}${plan.opts ? " (lod)" : ""}`);
      } else {
        fullDone = await showViaImg(token, entry);
      }
    }
  } catch (e) {
    diag(`LOAD FAIL ${entry.name}: ${String(e)}`);
    if (token === loadToken) showError(`无法打开「${entry.name}」：${String(e)}`);
  } finally {
    if (token === loadToken) setLoading(false);
  }
  if (token !== loadToken) return;

  // EXIF 拍摄信息（上面已并行取到，不再重复请求）
  if (exifInfo) info.updateMeta(null, exifInfo);

  schedulePreload(token);
}

/** tier 已显示后补全图（静默替换，不做交叉淡入，也不再取 EXIF 预览） */
function showCurrentFullQuiet(token: number, entry: ImageEntry) {
  return loadFull(token, entry, { transition: false, preview: false, keepView: true });
}

/** img 通道显示（动图 / 位图解码失败的兜底）。返回是否已显示；过期则释放 URL 且不覆盖当前画面 */
async function showViaImg(token: number, entry: ImageEntry): Promise<boolean> {
  const url = await blobUrl(entry.path);
  if (token !== loadToken) {
    releaseBlobUrl(url);
    return false;
  }
  const shown = await viewer.showUrl(url, !isOpaqueExt(entry.path), () => token === loadToken);
  if (!shown) {
    releaseBlobUrl(url);
    return false;
  }
  info.updateMeta({ w: viewer.view!.iw, h: viewer.view!.ih }, null);
  return true;
}

/** 停止翻页（当前图加载完成）一小会儿后再预加载邻图；期间再次翻页会取消 */
function schedulePreload(token: number) {
  clearTimeout(preloadTimer);
  preloadTimer = window.setTimeout(() => {
    if (token !== loadToken) return;
    preloadQueue.clear();
    preloadTier(index + 1);
    preloadTier(index - 1);
  }, PRELOAD_DELAY_MS);
}

function isNearCurrent(path: string, radius = 2): boolean {
  const k = entries.findIndex((e) => e.path === path);
  return k >= 0 && Math.abs(k - index) <= radius;
}

/** 邻图预加载：解码时直接缩小到视口大小的 tier，内存占用极小；走统一并发限制 */
function preloadTier(i: number) {
  const entry = entries[i];
  if (!entry || entry.animated || tiers.has(entry.path)) return;
  const path = entry.path;
  preloadQueue.push(path, async () => {
    if (!isNearCurrent(path)) return; // 排队期间用户已翻远
    // 窗口隐藏/最小化时 clientWidth 可能为 0：此时不能按 resizeWidth=1 解出垃圾位图
    const cw = stage.clientWidth;
    if (cw < TIER_MIN_VIEWPORT_PX) return;
    const ver = tierVer.get(path) ?? 0;
    const buf = await readImageBuf(path);
    const target = Math.max(TIER_MIN_PX, Math.round(cw * viewer.dpr * TIER_SCALE));
    const opts: ImageBitmapOptions = {
      resizeWidth: target, // 只给宽度：保持宽高比；resize 作用于 EXIF 旋转后的图
      resizeQuality: "high",
      imageOrientation: "from-image", // 与全图显示一致（也是默认值）
    };
    const dim = peekImageSize(new Uint8Array(buf));
    let tier: ImageBitmap;
    if (dim) {
      // 一步到位：解码即缩小，不产生全尺寸位图。
      // 短边已不大于目标时不缩放，避免把小图/窄长图放大成巨型位图
      tier = Math.min(dim.w, dim.h) <= target
        ? await createImageBitmap(new Blob([buf]), { imageOrientation: "from-image" })
        : await createImageBitmap(new Blob([buf]), opts);
    } else {
      // 文件头无法识别：保守退回先解码再缩小
      const full = await createImageBitmap(new Blob([buf]));
      if (full.width <= target) {
        tier = full;
      } else {
        tier = await createImageBitmap(full, opts);
        full.close();
      }
    }
    if (ver !== (tierVer.get(path) ?? 0) || !isNearCurrent(path)) {
      tier.close();
      return;
    }
    storeTier(path, tier);
  });
}

/** 用 tier 立即显示，再后台补全图（翻页瞬时响应）。返回是否已显示 */
async function showFromTier(token: number, entry: ImageEntry): Promise<boolean> {
  const tier = tiers.get(entry.path);
  if (!tier) return false;
  let copy: ImageBitmap;
  try {
    copy = await createImageBitmap(tier);
  } catch {
    return false;
  }
  if (token !== loadToken) {
    copy.close();
    return false;
  }
  // 标记为最近使用（tier 若在 await 期间已被逐出则不要复活）
  if (tiers.get(entry.path) === tier) {
    tiers.delete(entry.path);
    tiers.set(entry.path, tier);
  }
  viewer.setBitmap(copy, { alpha: !isOpaqueExt(entry.path) });
  return true;
}

// ---------- 翻页 ----------

function nav(delta: number, wrap = false) {
  if (!listReady || !entries.length) return;
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
  if (!listReady) return;
  const entry = entries[i];
  if (!entry) return;
  hideError();
  index = i;
  details.setPath(entry.path);
  const token = ++loadToken;
  cancelPending();
  strip.setCurrent(entry.path);
  info.show(entry, index, entries.length);
  setTitle(`${entry.name} — PicaView`);
  strip.ensureAround(entries, index);

  // 连续翻页（距上次切图不足防抖时间）时，完整图延后到停止翻页再读取/解码；
  // 单次翻页不延迟
  const now = performance.now();
  const rapid = now - lastNavAt < FULL_LOAD_DEBOUNCE_MS;
  lastNavAt = now;
  setLoading(true);

  void (async () => {
    // tier 快速显示，完整图随后补上
    const shown = entry.animated ? false : await showFromTier(token, entry);
    if (token !== loadToken) return; // 已有更新的切图请求，这次不再触发任何加载
    const run = () => {
      if (token !== loadToken) return;
      if (shown) void showCurrentFullQuiet(token, entry);
      else void loadFull(token, entry, { transition: true, preview: true, keepView: false });
    };
    if (rapid) fullTimer = window.setTimeout(run, FULL_LOAD_DEBOUNCE_MS);
    else run();
  })();
}

// ---------- 文件操作 ----------

async function doRotate(clockwise: boolean) {
  const entry = entries[index];
  if (entry) await ops.rotate(entry, clockwise);
}

async function doRename() {
  if (!listReady) return;
  const entry = entries[index];
  if (!entry) return;
  const updated = await ops.rename(entry);
  if (!updated) return;
  const i = entries.indexOf(entry); // 对话框期间（如幻灯片）当前图可能已变
  if (i < 0) return;
  strip.rename(entry.path, updated);
  entries[i] = updated;
  invalidateTier(entry.path);
  if (i === index) {
    info.show(updated, index, entries.length);
    setTitle(`${updated.name} — PicaView`);
    void showCurrent(false);
  }
}

async function doDelete(permanent: boolean) {
  if (!listReady) return;
  const entry = entries[index];
  if (!entry) return;
  const ok = await ops.remove(entry, permanent);
  if (!ok) return;
  const i = entries.indexOf(entry);
  if (i < 0) return; // 对话框期间列表已被替换
  invalidateTier(entry.path);
  strip.remove(entry.path); // 只移除节点，不重建胶片条
  entries.splice(i, 1);
  if (!entries.length) {
    index = -1;
    afterListChange();
    void showCurrent(false);
    return;
  }
  if (i === index) {
    index = Math.min(index, entries.length - 1);
    void showCurrent(true);
    return;
  }
  // 删的不是当前图：当前图不变，只修正序号
  if (i < index) index--;
  info.setPosition(entries[index], index, entries.length);
  strip.ensureAround(entries, index);
}

// ---------- 缩放指示 + 滑块 ----------

const zoomSlider = document.getElementById("zoom-slider") as HTMLInputElement;
const zoomPctLabel = document.getElementById("zoom-pct")!;
let sliderDragging = false;

/** 滑块位置 0-100 ↔ 缩放百分比（对数映射：下限=适应×0.1，上限=400%） */
function sliderRange(): { lo: number; hi: number } {
  const fit = Math.max(viewer.fitPct(), 1);
  return { lo: fit * SLIDER_MIN_FIT_FACTOR, hi: Math.max(SLIDER_MAX_PCT, fit) };
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
  maybeUpgradeLod(); // 放大到需要原图时后台补载
  const fit = Math.abs(pct - viewer.fitPct()) < 0.5;
  const label = `${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%${fit ? " (适应)" : ""}`;
  zoomPctLabel.textContent = label;
  zoomEl.textContent = label;
  zoomEl.classList.remove("hidden");
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => zoomEl.classList.add("hidden"), ZOOM_INDICATOR_MS);
  if (!sliderDragging) zoomSlider.value = String(pctToSlider(pct));
};

// ---------- 交互：滚轮 / 拖拽 / 双击 / 侧键 ----------

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!viewer.view) return;
  // deltaMode 归一化：行/页模式的原始 deltaY 很小或很大，直接套指数会让缩放失灵或跳变
  const delta = normalizeWheelDelta(e);
  if (!delta) return;
  const rect = stage.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // 每 100 像素当量 = 一档 WHEEL_ZOOM_BASE，单次事件最多 3 档
  const factor = Math.pow(WHEEL_ZOOM_BASE, -Math.sign(delta) * Math.min(3, Math.abs(delta) / 100));
  viewer.zoomAt(cx, cy, factor);
}, { passive: false });

let panning = false;
let lastX = 0, lastY = 0;
let downX = 0, downY = 0, dragMoved = false;

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
  dragMoved = false;
  downX = lastX = e.clientX;
  downY = lastY = e.clientY;
  stage.setPointerCapture(e.pointerId);
  stage.style.cursor = "grabbing";
});

stage.addEventListener("pointermove", (e) => {
  if (!panning) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) dragMoved = true;
  viewer.panBy(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX;
  lastY = e.clientY;
});

/** 结束拖拽：pointerup 与 pointercancel（Alt+Tab、触摸中断等）共用 */
function endPan(e: PointerEvent) {
  panning = false;
  stage.style.cursor = "";
  if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
}
stage.addEventListener("pointerup", endPan);
stage.addEventListener("pointercancel", endPan);

// 灯箱模式：点击图片外（非拖拽）退出，还原 Picasa 行为
stage.addEventListener("click", (e) => {
  if (!lightboxOn || dragMoved) return;
  const rect = stage.getBoundingClientRect();
  if (isOutsideImage(e.clientX - rect.left, e.clientY - rect.top)) {
    void applyFullscreen(false);
  }
});

stage.addEventListener("dblclick", (e) => {
  e.preventDefault();
  viewer.toggleFitActual();
});

stage.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- 快捷键 ----------

/** 焦点在可交互控件上（Enter 应交给控件本身，而不是触发全屏） */
function isFormControl(t: EventTarget | null): boolean {
  return t instanceof HTMLButtonElement || t instanceof HTMLInputElement ||
    t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement ||
    t instanceof HTMLAnchorElement;
}

window.addEventListener("keydown", (e) => {
  // 确认对话框自行处理；系统文件选择框显示期间不响应任何快捷键
  if (dialogOpen() || isPicking()) return;
  const meta = e.ctrlKey || e.metaKey;

  // 屏蔽 WebView 默认行为
  if (e.key === "F5" || (meta && (e.key === "r" || e.key === "R"))) {
    e.preventDefault();
    return;
  }

  // Ctrl+O：打开图片（显式放行，下面的"组合键不触发单键功能"不会拦它）
  if (meta && !e.altKey && !e.shiftKey && (e.key === "o" || e.key === "O")) {
    e.preventDefault();
    void openFileDialog();
    return;
  }

  // 带 Ctrl/Alt/Meta 的组合键不触发任何单键功能；仅保留 Ctrl/Cmd + "+" "=" "-" 作为缩放
  if (e.ctrlKey || e.altKey || e.metaKey) {
    const zoomKey = !e.altKey && (e.key === "+" || e.key === "=" || e.key === "-");
    if (!zoomKey) return;
  }

  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      if (viewer.isZoomed()) viewer.panBy(stage.clientWidth * KEY_PAN_RATIO, 0);
      else nav(-1);
      break;
    case "ArrowRight":
      e.preventDefault();
      if (viewer.isZoomed()) viewer.panBy(-stage.clientWidth * KEY_PAN_RATIO, 0);
      else nav(1);
      break;
    case "ArrowUp":
      if (viewer.isZoomed()) { e.preventDefault(); viewer.panBy(0, stage.clientHeight * KEY_PAN_RATIO); }
      break;
    case "ArrowDown":
      if (viewer.isZoomed()) { e.preventDefault(); viewer.panBy(0, -stage.clientHeight * KEY_PAN_RATIO); }
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
      viewer.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, KEY_ZOOM_STEP);
      break;
    case "-":
      e.preventDefault();
      viewer.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1 / KEY_ZOOM_STEP);
      break;
    case "1":
      viewer.actualSize();
      break;
    case "f":
    case "F":
      viewer.fit();
      break;
    case "Enter":
      // 焦点在按钮/输入框上时，Enter 属于该控件，不触发全屏
      if (isFormControl(e.target)) break;
      e.preventDefault();
      void toggleFullscreen();
      break;
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
    case "d":
    case "D":
      details.toggle();
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
      void doRotate(true);
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
      // 优先级：确认对话框（上面已返回）> 详情面板 > 幻灯片 > 灯箱 > 关闭窗口
      if (details.isOpen) { details.close(); break; }
      if (slideshow.playing) { slideshow.stop(); break; }
      if (lightboxOn) { void applyFullscreen(false); break; }
      void getCurrentWindow().close();
      break;
    }
  }
});

// ---------- 全屏（灯箱模式：窗口透明，压暗桌面，图片悬浮居中） ----------

const framelessBtn = document.getElementById("btn-frameless")!;
const maskBtn = document.getElementById("btn-mask")!;
let lightboxOn = false;

function enterLightbox() {
  if (lightboxOn) return;
  lightboxOn = true;
  document.documentElement.classList.add("lightbox");
  // 灯箱用页面级覆盖层压暗桌面，关闭 canvas 自带的暗色填充
  if (viewer.maskOn) {
    viewer.setMask(false);
    maskBtn.classList.remove("active");
  }
  // Picasa 式适中展示：图片占视口约 78%，四周留出蒙板
  viewer.fitRatio = LIGHTBOX_FIT_RATIO;
  viewer.fit();
  const hint = document.getElementById("lightbox-hint")!;
  hint.classList.remove("hidden");
  setTimeout(() => hint.classList.add("hidden"), LIGHTBOX_HINT_MS);
  diag("LIGHTBOX ON");
}

function exitLightbox() {
  if (!lightboxOn) return;
  lightboxOn = false;
  document.documentElement.classList.remove("lightbox");
  viewer.fitRatio = null;
  viewer.fit();
  diag("LIGHTBOX OFF");
}

// 打开图片前的灯箱介入统一走 engageLightboxForOpen()

async function applyFullscreen(on: boolean) {
  const w = getCurrentWindow();
  await w.setFullscreen(on);
  diag(`FS ${on ? "ON" : "OFF"}`);
  if (on) enterLightbox();
  else exitLightbox();
}

async function toggleFullscreen() {
  const w = getCurrentWindow();
  const fs = await w.isFullscreen();
  await applyFullscreen(!fs);
}

/** 点击图片外（非拖拽）→ 退出灯箱，还原 Picasa 行为 */
function isOutsideImage(cx: number, cy: number): boolean {
  const p = viewer.view;
  if (!p) return false;
  const x = p.tx / viewer.dpr;
  const y = p.ty / viewer.dpr;
  const w = (p.iw * p.scale) / viewer.dpr;
  const h = (p.ih * p.scale) / viewer.dpr;
  return cx < x || cy < y || cx > x + w || cy > y + h;
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
    toast("只看图片模式：右键拖动移动窗口，Esc 退出软件");
  }
}

// ---------- 蒙板 ----------

function toggleMask() {
  // 灯箱模式的压暗由页面覆盖层负责（#lightbox-mask），再开 canvas 蒙板会叠成两层
  if (lightboxOn) {
    toast("灯箱模式已自带压暗，Esc 或点击图片外退出");
    return;
  }
  viewer.setMask(!viewer.maskOn);
  maskBtn.classList.toggle("active", viewer.maskOn);
}

// ---------- 控制按钮 ----------

function svgIcon(paths: string, viewBox = "0 0 24 24"): string {
  return `<svg viewBox="${viewBox}" aria-hidden="true">${paths}</svg>`;
}

(document.getElementById("btn-rot-ccw") as HTMLElement).innerHTML =
  svgIcon(`<path d="M3 8a9 9 0 1 1 2.6 8.4"/><path d="M3 3v5h5"/>`);
(document.getElementById("btn-rot-cw") as HTMLElement).innerHTML =
  svgIcon(`<path d="M21 8a9 9 0 1 0-2.6 8.4"/><path d="M21 3v5h-5"/>`);
(document.getElementById("btn-details") as HTMLElement).innerHTML =
  svgIcon(`<circle cx="12" cy="12" r="9"/><path d="M12 16.5v-5M12 7.5h.01"/>`);
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
// 详情按钮的点击由 DetailsPanel 自己绑定
document.getElementById("btn-slideshow")!.addEventListener("click", () => slideshow.toggle());
document.getElementById("btn-open")!.addEventListener("click", () => void openFileDialog());
// 空状态下双击空白处 = 打开文件。#empty 盖在 #stage 之上，双击不会落到舞台的
// "切换适应/100%"与"点图外退出灯箱"逻辑上；点在按钮上时交给按钮的 click，避免弹两次
emptyEl.addEventListener("dblclick", (e) => {
  if (e.target instanceof Element && e.target.closest("button")) return;
  void openFileDialog();
});
document.getElementById("btn-mask")!.addEventListener("click", () => toggleMask());
document.getElementById("btn-frameless")!.addEventListener("click", () => void toggleFrameless());
document.getElementById("btn-filmstrip")!.addEventListener("click", () => strip.toggle());
document.getElementById("btn-fullscreen")!.addEventListener("click", () => void toggleFullscreen());
document.getElementById("nav-prev")!.addEventListener("click", () => nav(-1));
document.getElementById("nav-next")!.addEventListener("click", () => nav(1));

slideshow.onNext = () => nav(1, true);
slideshow.fullscreenHandler = (on) => void applyFullscreen(on);
slideshow.isFullscreen = () => getCurrentWindow().isFullscreen();

strip.onPick = (i) => {
  // 点的就是当前图且显示正常：不重复加载（避免 tier 低清图闪一下）
  if (i === index && viewer.view && errorEl.classList.contains("hidden")) return;
  jumpTo(i);
};

// ---------- 显示状态防御：任何显示状态变化都强制重绘 ----------

viewer.onRafSuspended = () => diag("rAF 被暂停（窗口遮挡/最小化），已同步绘制兜底");
// 焦点/可见性变化只补绘；仅当画布实际尺寸变化时才会重新 fit，用户的缩放平移不受影响
window.addEventListener("focus", () => viewer.resize());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) viewer.resize();
});
new ResizeObserver(() => viewer.resize()).observe(stage);

// 帧保活：页面可见时定时静默补推一帧，对抗合成器丢帧/呈现冻结（静默：不触发缩放指示）
setInterval(() => {
  if (!document.hidden && viewer.view) viewer.paint({ silent: true });
}, KEEPALIVE_MS);

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

/** 首帧就绪后显示窗口：白屏/隐形过渡全部发生在看不见的阶段 */
function showWindowWhenReady() {
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    void getCurrentWindow().show();
  };
  requestAnimationFrame(() => requestAnimationFrame(show));
  setTimeout(show, SHOW_WINDOW_FALLBACK_MS); // 兜底：隐藏窗口下 rAF 可能不跑
}

(async () => {
  // 启动参数（文件关联 / 手动传入）
  try {
    const args = await invoke<string[]>("cli_args");
    const target = args.find((a) => a && !a.startsWith("-"));
    if (target) {
      // 窗口本身已按配置全屏，这里直接挂灯箱样式，首帧即蒙板+胶片条
      enterLightbox();
      showWindowWhenReady();
      await openPath(target);
      return;
    }
  } catch { /* ignore */ }
  emptyEl.classList.remove("hidden");
  showWindowWhenReady();
})();
