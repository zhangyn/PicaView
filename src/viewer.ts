// 渲染引擎：静图 canvas 双缓冲（交叉淡入），动图 <img> + CSS transform
// 视图状态统一用"设备像素"表示，对外 API 用 CSS 像素

export interface Placement {
  iw: number;      // 图像宽（像素）
  ih: number;
  scale: number;   // 设备像素/图像像素
  tx: number;      // 设备像素偏移
  ty: number;
}

export interface SetBitmapOpts {
  preview?: boolean;    // 低清预览（后续会被全图替换）
  alpha?: boolean;      // 可能有透明区域，显示棋盘格
  transition?: boolean; // 交叉淡入
}

const ZOOM_MIN_FACTOR = 0.05;  // 相对 fit 的最小缩放
const ZOOM_MAX_SCALE = 64;     // 绝对最大（设备像素）

export class Viewer {
  private canvA: HTMLCanvasElement;
  private canvB: HTMLCanvasElement;
  private animImg: HTMLImageElement;
  private checker: HTMLElement;
  private active: HTMLCanvasElement;
  private rafId = 0;

  dpr = 1;
  view: Placement | null = null;
  private bitmap: ImageBitmap | null = null;
  animated = false;
  private isPreview = false;
  private alpha = false;
  /** 蒙板：图片外区域灰色半透明 */
  maskOn = false;
  private rafWatchdog = 0;

  /** 每次实际绘制后回调（用于缩放指示） */
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
      c.addEventListener("contextrestored", () => this.paint());
    }
    this.resize();
  }

  // ---------- 画布尺寸 ----------

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvA, this.canvB]) {
      const w = Math.max(1, Math.round(c.clientWidth * this.dpr));
      const h = Math.max(1, Math.round(c.clientHeight * this.dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    if (this.bitmap) {
      this.fit();
    } else if (this.animated) {
      this.fit();
      this.placeAnim();
    }
  }

  private get cw() { return this.active.width; }
  private get ch() { return this.active.height; }

  /** 适配窗口的缩放比（设备像素） */
  get fitScale(): number {
    if (!this.view) return 1;
    return Math.min(this.cw / this.view.iw, this.ch / this.view.ih);
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

  /** 显示静图位图。preview 升级到全图时重算 fit */
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
    this.isPreview = !!opts.preview;
    // 视图状态：先置单位变换，再 fit 计算居中
    this.view = { iw: bmp.width, ih: bmp.height, scale: 1, tx: 0, ty: 0 };
    this.fit();
    old?.close();
  }

  /** 用 <img> 通道显示（动图播放 / 大图位图解码失败时的兜底） */
  async showUrl(url: string, alpha: boolean): Promise<void> {
    const img = this.animImg;
    img.src = url;
    await img.decode(); // 首帧可用
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

  /** 当前显示的是否为低清预览 */
  get showingPreview(): boolean {
    return this.isPreview;
  }

  // ---------- 视图操作 ----------

  fit() {
    if (!this.view) return;
    const p = this.view;
    const s = Math.min(this.cw / p.iw, this.ch / p.ih);
    p.scale = s;
    p.tx = (this.cw - p.iw * s) / 2;
    p.ty = (this.ch - p.ih * s) / 2;
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
    this.paint();
  }

  /** CSS 像素平移 */
  panBy(dx: number, dy: number) {
    const p = this.view;
    if (!p) return;
    p.tx += dx * this.dpr;
    p.ty += dy * this.dpr;
    this.paint();
  }

  // ---------- 绘制 ----------

  paint() {
    if (this.rafId) return;
    const t0 = Date.now();
    const draw = () => {
      this.rafId = 0;
      clearTimeout(this.rafWatchdog);
      if (Date.now() - t0 > 120) this.onRafSuspended?.();
      this.drawNow();
    };
    this.rafId = requestAnimationFrame(draw);
    // rAF 看门狗：窗口被遮挡/最小化时 Chromium 可能暂停 rAF，
    // 250ms 未触发就同步绘制，保证任何状态下画面必达
    this.rafWatchdog = window.setTimeout(draw, 250);
  }

  private drawNow() {
    // 画布尺寸异常自愈（clientWidth 为 0 时 canvas 会是 1×1）
    if (this.active.width < 50 || this.active.height < 50) {
      this.resize();
    }
    if (this.animated) this.placeAnim();
    else if (this.bitmap && this.view) this.drawTo(this.active, this.bitmap, this.view);
    this.onPaint?.(this.zoomPct());
  }

  private ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
    // willReadFrequently: 强制软件光栅化——部分显卡驱动下 GPU 画布纹理无法合成（呈现为透明）
    return c.getContext("2d", { willReadFrequently: true })!;
  }

  private drawTo(c: HTMLCanvasElement, bmp: ImageBitmap, p: Placement) {
    const ctx = this.ctxOf(c);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (this.maskOn) {
      // 灯箱模式：先铺暗蒙板，再带投影绘制图片
      this.fillMask(ctx, p);
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = 36 * this.dpr;
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
    ctx.fillStyle = "rgba(0,0,0,0.6)";
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

  private drawFittedTo(c: HTMLCanvasElement, bmp: ImageBitmap) {
    const s = Math.min(c.width / bmp.width, c.height / bmp.height);
    const p: Placement = {
      iw: bmp.width, ih: bmp.height, scale: s,
      tx: (c.width - bmp.width * s) / 2, ty: (c.height - bmp.height * s) / 2,
    };
    this.drawTo(c, bmp, p);
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
