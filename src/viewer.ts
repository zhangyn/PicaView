// 渲染引擎：静图 canvas 双缓冲（交叉淡入），动图 <img> + CSS transform
// 视图状态统一用"设备像素"表示，对外 API 用 CSS 像素

import {
  CANVAS_WILL_READ_FREQUENTLY, HQ_RESTORE_MS, RAF_SUSPEND_WARN_MS, RAF_WATCHDOG_MS,
} from "./config";

export interface Placement {
  iw: number;      // 图像宽（像素）
  ih: number;
  scale: number;   // 设备像素/图像像素
  tx: number;      // 设备像素偏移
  ty: number;
}

export interface SetBitmapOpts {
  alpha?: boolean;      // 可能有透明区域，显示棋盘格
  transition?: boolean; // 交叉淡入
}

export interface PaintOpts {
  /** 静默重绘：不触发 onPaint（不刷新缩放指示/滑块），用于保活与补绘 */
  silent?: boolean;
}

const ZOOM_MIN_FACTOR = 0.05;  // 相对 fit 的最小缩放
const ZOOM_MAX_SCALE = 64;     // 绝对最大（设备像素）
const CANVAS_MIN_PX = 50;      // 小于该尺寸视为异常（clientWidth 为 0 时 canvas 会是 1×1）
const MASK_FILL = "rgba(0,0,0,0.6)";
const SHADOW_COLOR = "rgba(0,0,0,0.65)";
const SHADOW_BLUR = 36;        // CSS 像素

export class Viewer {
  private canvA: HTMLCanvasElement;
  private canvB: HTMLCanvasElement;
  private animImg: HTMLImageElement;
  private checker: HTMLElement;
  private active: HTMLCanvasElement;
  private rafId = 0;
  private paintSilent = true;

  dpr = 1;
  view: Placement | null = null;
  private bitmap: ImageBitmap | null = null;
  animated = false;
  private alpha = false;
  /** 当前视图是否处于"适应窗口"状态（用户未手动缩放/平移） */
  private fitted = true;
  /** 交互中（拖动/缩放）用低质量插值，停止后补一次高质量 */
  private interacting = false;
  private hqTimer = 0;
  /** 蒙板：图片外区域灰色半透明 */
  maskOn = false;
  /** 灯箱模式下的适配比例：图片只占视口的一部分（Picasa 式适中展示） */
  fitRatio: number | null = null;
  private rafWatchdog = 0;

  /** 每次实际绘制后回调（用于缩放指示）；silent 绘制不触发 */
  onPaint: ((pct: number) => void) | null = null;
  /** rAF 被系统暂停（遮挡/最小化）时回调（诊断用） */
  onRafSuspended: (() => void) | null = null;

  constructor() {
    this.canvA = document.getElementById("view-a") as HTMLCanvasElement;
    this.canvB = document.getElementById("view-b") as HTMLCanvasElement;
    this.animImg = document.getElementById("view-anim") as HTMLImageElement;
    this.checker = document.getElementById("checker")!;
    this.active = this.canvA;
    this.canvA.classList.add("front");
    this.canvB.classList.add("back");
    window.addEventListener("resize", () => this.resize());
    // GPU 上下文丢失/恢复：丢时不销毁（允许自动恢复），恢复后重绘
    for (const c of [this.canvA, this.canvB]) {
      c.addEventListener("contextlost", (e) => e.preventDefault());
      c.addEventListener("contextrestored", () => this.paint({ silent: true }));
    }
    this.resize();
  }

  // ---------- 画布尺寸 ----------

  /**
   * 窗口/容器尺寸变化、获得焦点、重新可见时调用。
   * 画布实际尺寸（含 DPR）没变：只静默补绘，不动用户的缩放平移；
   * 变了：处于适应状态则重新 fit，否则保持视图中心点与缩放比例不变。
   */
  resize() {
    const prev = { w: this.cw, h: this.ch, dpr: this.dpr };
    if (!this.syncSize()) {
      this.paint({ silent: true });
      return;
    }
    this.relayout(prev);
    this.paint();
  }

  /** 同步 canvas 像素尺寸到 CSS 尺寸 × DPR；返回是否有变化（不绘制） */
  private syncSize(): boolean {
    const dpr = window.devicePixelRatio || 1;
    let changed = dpr !== this.dpr;
    this.dpr = dpr;
    for (const c of [this.canvA, this.canvB]) {
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
        changed = true;
      }
    }
    return changed;
  }

  /** 画布尺寸变化后调整视图（不绘制） */
  private relayout(prev: { w: number; h: number; dpr: number }) {
    const p = this.view;
    if (!p) return;
    if (this.fitted) {
      this.fitView();
      return;
    }
    // 用户已手动缩放：保持画面中心对应的图像点不变，缩放比例随 DPR 等比换算
    const ix = (prev.w / 2 - p.tx) / p.scale;
    const iy = (prev.h / 2 - p.ty) / p.scale;
    p.scale *= this.dpr / prev.dpr;
    p.tx = this.cw / 2 - ix * p.scale;
    p.ty = this.ch / 2 - iy * p.scale;
    this.clampPlacement();
  }

  /**
   * 交互后的视图约束：小于视口的轴居中，大于视口的轴不留空隙。
   * 没有它时可以把图片整张拖出视口，只留下空白，用户只能靠双击恢复。
   */
  private clampPlacement() {
    const p = this.view;
    if (!p) return;
    const w = p.iw * p.scale;
    const h = p.ih * p.scale;
    p.tx = w <= this.cw ? (this.cw - w) / 2 : Math.min(0, Math.max(this.cw - w, p.tx));
    p.ty = h <= this.ch ? (this.ch - h) / 2 : Math.min(0, Math.max(this.ch - h, p.ty));
  }

  private get cw() { return this.active.width; }
  private get ch() { return this.active.height; }

  /** 适配比例（含灯箱比例，设备像素/图像像素）——fit 与过渡绘制共用 */
  private fitScaleFor(iw: number, ih: number, cw: number, ch: number): number {
    return Math.min(cw / iw, ch / ih) * (this.fitRatio ?? 1);
  }

  /** 适配窗口时的居中布局——fit() 与 drawFittedTo() 共用同一计算 */
  private fitPlacement(iw: number, ih: number, cw: number, ch: number): Placement {
    const s = this.fitScaleFor(iw, ih, cw, ch);
    return { iw, ih, scale: s, tx: (cw - iw * s) / 2, ty: (ch - ih * s) / 2 };
  }

  /** 适配窗口的缩放比（含灯箱比例，设备像素） */
  get fitScale(): number {
    if (!this.view) return 1;
    return this.fitScaleFor(this.view.iw, this.view.ih, this.cw, this.ch);
  }

  isZoomed(): boolean {
    if (!this.view) return false;
    return this.view.scale > this.fitScale * 1.02;
  }

  zoomPct(): number {
    if (!this.view) return 100;
    return (this.view.scale / this.dpr) * 100;
  }

  /** 适应窗口时的百分比（供滑块标定） */
  fitPct(): number {
    if (!this.view) return 100;
    return (this.fitScale / this.dpr) * 100;
  }

  /** 按百分比设置缩放（以视口中心为锚点） */
  setZoomPct(pct: number) {
    if (!this.view) return;
    this.setScaleAtDevice((pct / 100) * this.dpr, this.cw / 2, this.ch / 2);
  }

  // ---------- 内容管理 ----------

  /** 显示静图位图。预览升级到全图时重算 fit */
  setBitmap(bmp: ImageBitmap, opts: SetBitmapOpts) {
    this.animated = false;
    this.animImg.style.display = "none";
    this.canvA.style.visibility = "";
    this.canvB.style.visibility = "";
    this.alpha = !!opts.alpha;
    this.checker.classList.toggle("show", this.alpha);

    const old = this.bitmap;

    if (opts.transition && old) {
      // 画到备用画布再淡入
      const target = this.active === this.canvA ? this.canvB : this.canvA;
      this.drawFittedTo(target, bmp);
      this.swap(target);
    } else {
      this.drawFittedTo(this.active, bmp);
    }

    this.bitmap = bmp;
    // 视图状态：先置单位变换，再 fit 计算居中
    this.view = { iw: bmp.width, ih: bmp.height, scale: 1, tx: 0, ty: 0 };
    this.fit();
    old?.close();
  }

  /**
   * 用 <img> 通道显示（动图播放 / 大图位图解码失败时的兜底）。
   * isCurrent：每次 await 之后调用，返回 false 表示请求已过期——此时不触碰当前画面，返回 false。
   */
  async showUrl(url: string, alpha: boolean, isCurrent: () => boolean = () => true): Promise<boolean> {
    // 先用游离的 Image 解码：过期时不会干扰正在显示的 <img>
    const probe = new Image();
    probe.src = url;
    await probe.decode(); // 首帧可用
    if (!isCurrent()) return false;
    const img = this.animImg;
    img.src = url;
    await img.decode(); // 同一 URL，资源已缓存
    if (!isCurrent()) return false;
    this.bitmap?.close();
    this.bitmap = null;
    this.animated = true;
    this.alpha = alpha;
    this.checker.classList.toggle("show", alpha);
    this.syncImgMask();
    // 视图尺寸取自然尺寸
    this.view = { iw: img.naturalWidth, ih: img.naturalHeight, scale: 1, tx: 0, ty: 0 };
    this.fit();
    this.placeAnim();
    img.style.display = "block";
    this.canvA.style.visibility = "hidden";
    this.canvB.style.visibility = "hidden";
    return true;
  }

  clear() {
    this.bitmap?.close();
    this.bitmap = null;
    this.view = null;
    this.animated = false;
    this.animImg.removeAttribute("src");
    this.animImg.style.display = "none";
    this.animImg.classList.remove("masked");
    this.canvA.style.visibility = "";
    this.canvB.style.visibility = "";
    this.ctxOf(this.canvA).clearRect(0, 0, this.canvA.width, this.canvA.height);
    this.ctxOf(this.canvB).clearRect(0, 0, this.canvB.width, this.canvB.height);
    this.checker.classList.remove("show");
  }

  // ---------- 视图操作 ----------

  /** 重置为适应窗口（不绘制） */
  private fitView() {
    const p = this.view;
    if (!p) return;
    Object.assign(p, this.fitPlacement(p.iw, p.ih, this.cw, this.ch));
    this.fitted = true;
  }

  fit() {
    if (!this.view) return;
    this.fitView();
    this.paint();
  }

  /** 100% = 1 图像像素 : 1 设备像素（HiDPI 下即"实际大小"） */
  actualSize() {
    if (!this.view) return;
    this.setScaleAtDevice(this.dpr, this.cw / 2, this.ch / 2);
  }

  /** 双击切换 适配窗口 ↔ 实际大小 */
  toggleFitActual() {
    if (!this.view) return;
    if (this.isZoomed() || Math.abs(this.view.scale - this.dpr) < 0.01) {
      this.fit();
    } else {
      this.actualSize();
    }
  }

  /** CSS 坐标锚点缩放 */
  zoomAt(cx: number, cy: number, factor: number) {
    if (!this.view) return;
    this.setScaleAtDevice(this.view.scale * factor, cx * this.dpr, cy * this.dpr);
  }

  private setScaleAtDevice(s2: number, cxDev: number, cyDev: number) {
    const p = this.view;
    if (!p) return;
    const min = this.fitScale * ZOOM_MIN_FACTOR;
    const max = Math.max(ZOOM_MAX_SCALE, this.fitScale * 2);
    s2 = Math.min(Math.max(s2, min), max);
    const f = s2 / p.scale;
    p.tx = cxDev - (cxDev - p.tx) * f;
    p.ty = cyDev - (cyDev - p.ty) * f;
    p.scale = s2;
    this.fitted = false;
    this.clampPlacement();
    this.markInteracting();
    this.paint();
  }

  /** CSS 像素平移 */
  panBy(dx: number, dy: number) {
    const p = this.view;
    if (!p) return;
    p.tx += dx * this.dpr;
    p.ty += dy * this.dpr;
    this.fitted = false;
    this.clampPlacement();
    this.markInteracting();
    this.paint();
  }

  /** 进入交互态（低质量插值）；停止 HQ_RESTORE_MS 后静默补一次高质量 */
  private markInteracting() {
    this.interacting = true;
    clearTimeout(this.hqTimer);
    this.hqTimer = window.setTimeout(() => {
      this.interacting = false;
      this.paint({ silent: true });
    }, HQ_RESTORE_MS);
  }

  // ---------- 绘制 ----------

  paint(opts?: PaintOpts) {
    const silent = !!opts?.silent;
    if (this.rafId) {
      // 已有待执行的绘制：只要有一次非静默请求，这一帧就要通知 UI
      if (!silent) this.paintSilent = false;
      return;
    }
    this.paintSilent = silent;
    const t0 = Date.now();
    const draw = () => {
      cancelAnimationFrame(this.rafId); // 看门狗先触发时，取消仍挂着的 rAF，避免重复绘制
      clearTimeout(this.rafWatchdog);
      this.rafId = 0;
      if (Date.now() - t0 > RAF_SUSPEND_WARN_MS) this.onRafSuspended?.();
      this.drawNow(this.paintSilent);
    };
    this.rafId = requestAnimationFrame(draw);
    // rAF 看门狗：窗口被遮挡/最小化时 Chromium 可能暂停 rAF，
    // 超时未触发就同步绘制，保证任何状态下画面必达
    this.rafWatchdog = window.setTimeout(draw, RAF_WATCHDOG_MS);
  }

  private drawNow(silent: boolean) {
    // 画布尺寸异常自愈（clientWidth 为 0 时 canvas 会是 1×1）
    if (this.active.width < CANVAS_MIN_PX || this.active.height < CANVAS_MIN_PX) {
      const prev = { w: this.cw, h: this.ch, dpr: this.dpr };
      if (this.syncSize()) this.relayout(prev);
    }
    if (this.animated) this.placeAnim();
    else if (this.bitmap && this.view) this.drawTo(this.active, this.bitmap, this.view);
    if (!silent) this.onPaint?.(this.zoomPct());
  }

  private ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
    return c.getContext("2d", { willReadFrequently: CANVAS_WILL_READ_FREQUENTLY })!;
  }

  private drawTo(c: HTMLCanvasElement, bmp: ImageBitmap, p: Placement) {
    const ctx = this.ctxOf(c);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.interacting ? "low" : "high";
    if (this.maskOn) {
      // 灯箱模式：先铺暗蒙板，再带投影绘制图片
      this.fillMask(ctx, p);
      ctx.save();
      ctx.shadowColor = SHADOW_COLOR;
      ctx.shadowBlur = SHADOW_BLUR * this.dpr;
      ctx.drawImage(bmp, p.tx, p.ty, p.iw * p.scale, p.ih * p.scale);
      ctx.restore();
    } else {
      ctx.drawImage(bmp, p.tx, p.ty, p.iw * p.scale, p.ih * p.scale);
    }
  }

  /** 图片外区域铺深色半透明蒙板（canvas 路径） */
  private fillMask(ctx: CanvasRenderingContext2D, p: Placement) {
    const W = this.active.width, H = this.active.height;
    const x0 = Math.max(0, p.tx);
    const y0 = Math.max(0, p.ty);
    const x1 = Math.min(W, p.tx + p.iw * p.scale);
    const y1 = Math.min(H, p.ty + p.ih * p.scale);
    if (x1 <= x0 || y1 <= y0) return; // 图片完全在视口外
    ctx.fillStyle = MASK_FILL;
    ctx.fillRect(0, 0, W, y0);                       // 上
    ctx.fillRect(0, y1, W, H - y1);                  // 下
    ctx.fillRect(0, y0, x0, y1 - y0);                // 左
    ctx.fillRect(x1, y0, W - x1, y1 - y0);           // 右
  }

  /** img 通道的蒙板用超大 box-shadow 实现 */
  private syncImgMask() {
    this.animImg.classList.toggle("masked", this.maskOn);
  }

  setMask(on: boolean) {
    this.maskOn = on;
    this.syncImgMask();
    this.paint();
  }

  /** 过渡用：把新位图按"适配窗口"布局画到目标画布，布局与随后的 fit() 完全一致 */
  private drawFittedTo(c: HTMLCanvasElement, bmp: ImageBitmap) {
    this.drawTo(c, bmp, this.fitPlacement(bmp.width, bmp.height, c.width, c.height));
  }

  private swap(target: HTMLCanvasElement) {
    this.active.classList.replace("front", "back");
    target.classList.replace("back", "front");
    this.active = target;
  }

  /** 把当前视图应用到动图 <img>（CSS transform，与 canvas 数学好一致） */
  private placeAnim() {
    const p = this.view;
    if (!p || !this.animated) return;
    const img = this.animImg;
    img.style.width = `${p.iw}px`;
    img.style.height = `${p.ih}px`;
    img.style.transform =
      `translate(${p.tx / this.dpr}px, ${p.ty / this.dpr}px) scale(${p.scale / this.dpr})`;
  }
}
