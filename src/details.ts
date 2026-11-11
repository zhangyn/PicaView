// 右侧"详细信息"面板：打开/关闭、按需（防抖）取数、渲染、复制与定位
// 所有取值只用 textContent 写入 DOM，不拼 HTML

import { invoke } from "@tauri-apps/api/core";
import { DETAILS_DEBOUNCE_MS } from "./config";
import type { ImageDetails } from "./types";
import { formatDateTime, humanSize, toast } from "./util";

type Row = [label: string, value: string | null | undefined, warn?: boolean];

const ORIENTATION_TEXT: Record<number, string> = {
  1: "正常",
  2: "水平翻转",
  3: "旋转 180°",
  4: "垂直翻转",
  5: "水平翻转并逆时针旋转 90°",
  6: "顺时针旋转 90°",
  7: "水平翻转并顺时针旋转 90°",
  8: "逆时针旋转 90°",
};

function fmtNum(v: number): string {
  return String(Number(v.toFixed(2)));
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} 字节` : `${humanSize(n)}（${n.toLocaleString("en-US")} 字节）`;
}

function fmtDpi(x: number | null, y: number | null): string | null {
  if (x != null && y != null) return x === y ? `${fmtNum(x)} DPI` : `${fmtNum(x)} × ${fmtNum(y)} DPI`;
  const one = x ?? y;
  return one != null ? `${fmtNum(one)} DPI` : null;
}

function fmtDegree(v: number, pos: string, neg: string): string {
  return `${Math.abs(v).toFixed(6)}° ${v >= 0 ? pos : neg}`;
}

/** 选中元素内的文本（剪贴板不可用时的回退，用户可直接 Ctrl+C） */
function selectText(el: HTMLElement | null) {
  if (!el) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

async function copyText(text: string, fallback: HTMLElement | null, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    selectText(fallback);
    toast(fallback ? "复制失败，已选中文本，请按 Ctrl+C" : "复制失败");
  }
}

export class DetailsPanel {
  private readonly root = document.getElementById("details-panel")!;
  private readonly body = document.getElementById("details-body")!;
  private readonly toggleBtn = document.getElementById("btn-details")!;
  private readonly closeBtn = document.getElementById("details-close")!;
  private readonly copyPathBtn = document.getElementById("details-copy-path") as HTMLButtonElement;
  private readonly revealBtn = document.getElementById("details-reveal") as HTMLButtonElement;

  private opened = false;
  /** 当前显示的图片路径（由 main 在切图时通知） */
  private path: string | null = null;
  /** 最近一次成功取到的详情及其对应路径 */
  private data: ImageDetails | null = null;
  private dataFor: string | null = null;
  /** 请求令牌：每次刷新自增，过期响应直接丢弃 */
  private token = 0;
  private timer = 0;
  /** 渲染出的、可作为"选中回退"目标的元素 */
  private pathEl: HTMLElement | null = null;
  private coordEl: HTMLElement | null = null;

  constructor() {
    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.close());
    this.copyPathBtn.addEventListener("click", () => void this.copyPath());
    this.revealBtn.addEventListener("click", () => void this.reveal());
    this.syncActions();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  toggle() {
    if (this.opened) this.close();
    else this.open();
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this.root.classList.add("open");
    document.body.classList.add("details-open");
    this.toggleBtn.classList.add("active");
    this.toggleBtn.setAttribute("aria-expanded", "true");
    this.refresh(true);
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    // 面板内持有焦点时，关闭后把焦点交还给开关按钮，避免焦点落到不可见元素上
    const hadFocus = this.root.contains(document.activeElement);
    this.root.classList.remove("open");
    document.body.classList.remove("details-open");
    this.toggleBtn.classList.remove("active");
    this.toggleBtn.setAttribute("aria-expanded", "false");
    clearTimeout(this.timer);
    this.token++; // 作废在途请求
    if (hadFocus) this.toggleBtn.focus();
  }

  /** 当前图片变化（含无图 null）。面板打开时防抖刷新，关闭时只记录 */
  setPath(path: string | null) {
    this.path = path;
    this.syncActions();
    if (this.opened) this.refresh(false);
  }

  // ---------- 取数 ----------

  private refresh(immediate: boolean) {
    clearTimeout(this.timer);
    const token = ++this.token;
    if (!this.path) {
      this.showMessage("没有打开的图片");
      return;
    }
    // 保留旧内容但标记为过期（变暗、按钮不可点），新数据到达前不误导
    this.body.classList.add("stale");
    this.body.setAttribute("aria-busy", "true");
    if (!this.data) this.showMessage("读取中…", true);
    if (immediate) void this.load(token);
    else this.timer = window.setTimeout(() => void this.load(token), DETAILS_DEBOUNCE_MS);
  }

  private async load(token: number) {
    const path = this.path;
    if (!path || token !== this.token) return;
    try {
      const d = await invoke<ImageDetails>("get_image_details", { path });
      if (token !== this.token) return;
      this.data = d;
      this.dataFor = path;
      this.render(d);
    } catch (e) {
      if (token !== this.token) return;
      this.showMessage(`无法读取详细信息：${String(e)}`);
    }
  }

  // ---------- 渲染 ----------

  private showMessage(msg: string, keepStale = false) {
    this.pathEl = null;
    this.coordEl = null;
    if (!keepStale) {
      this.data = null;
      this.dataFor = null;
      this.body.classList.remove("stale");
      this.body.removeAttribute("aria-busy");
    }
    const p = document.createElement("p");
    p.className = "d-msg";
    p.textContent = msg;
    this.body.replaceChildren(p);
  }

  private render(d: ImageDetails) {
    this.pathEl = null;
    this.coordEl = null;
    this.body.classList.remove("stale");
    this.body.removeAttribute("aria-busy");

    const f = d.file;
    const im = d.image;
    const frag = document.createDocumentFragment();

    const format = f.format
      ? (f.ext_mismatch ? `${f.format}（扩展名 .${f.ext} 与实际格式不符）` : f.format)
      : null;
    const fileSec = this.section("文件", [
      ["名称", f.name],
      ["完整路径", f.path],
      ["所在文件夹", f.folder],
      ["大小", fmtSize(f.size)],
      ["格式", format, f.ext_mismatch],
      ["动图", f.animated ? "是" : null],
      ["创建时间", formatDateTime(f.created)],
      ["修改时间", formatDateTime(f.modified)],
      ["访问时间", formatDateTime(f.accessed)],
      ["只读", f.readonly ? "是" : null],
    ]);
    this.pathEl = fileSec.cell("完整路径");
    frag.append(fileSec.el);

    const size = im.width != null && im.height != null
      ? `${im.width} × ${im.height} 像素${im.megapixels ? `（${im.megapixels} MP）` : ""}`
      : null;
    const imgSec = this.section("图像", [
      ["尺寸", size],
      ["方向", im.orientation != null
        ? `${ORIENTATION_TEXT[im.orientation] ?? "未知"}（EXIF ${im.orientation}）`
        : null],
      ["分辨率", fmtDpi(im.dpi_x, im.dpi_y)],
      ["色彩空间", im.color_space],
      ["ICC 配置文件", im.has_icc == null ? null : im.has_icc ? "有" : "无"],
    ]);
    if (imgSec.count) frag.append(imgSec.el);
    if (d.histogram_luma && d.histogram_luma.length === 256) {
      frag.append(this.histogram(d.histogram_luma));
    }

    const s = d.shot;
    if (s) {
      const shot = this.section("拍摄信息", [
        ["厂商", s.make],
        ["型号", s.model],
        ["镜头", s.lens],
        ["软件", s.software],
        ["拍摄时间", s.date_taken],
        ["曝光时间", s.exposure_time],
        ["光圈", s.f_number],
        ["ISO", s.iso != null ? String(s.iso) : null],
        ["焦距", s.focal_length],
        ["等效焦距（35mm）", s.focal_length_35mm != null ? `${s.focal_length_35mm} mm` : null],
        ["曝光补偿", s.exposure_bias],
        ["测光模式", s.metering_mode],
        ["闪光灯", s.flash],
        ["白平衡", s.white_balance],
        ["曝光程序", s.exposure_program],
      ]);
      if (shot.count) frag.append(shot.el);
    }

    const g = d.gps;
    if (g) {
      const gps = this.section("位置（GPS）", [
        ["纬度", fmtDegree(g.latitude, "N", "S")],
        ["经度", fmtDegree(g.longitude, "E", "W")],
        ["海拔", g.altitude != null ? `${fmtNum(g.altitude)} m` : null],
        ["十进制坐标", this.coordText(g.latitude, g.longitude)],
      ]);
      this.coordEl = gps.cell("十进制坐标");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "d-btn";
      btn.textContent = "复制坐标";
      btn.setAttribute("aria-label", "复制坐标");
      btn.addEventListener("click", () => void this.copyCoords());
      gps.el.append(btn);
      frag.append(gps.el);
    }

    this.body.replaceChildren(frag);
  }

  /** 亮度直方图：对数刻度，避免一个尖峰把其余细节压平 */
  private histogram(bins: number[]): HTMLElement {
    const el = document.createElement("section");
    el.className = "d-sec";
    const title = document.createElement("h3");
    title.textContent = "直方图";

    const W = 236;
    const H = 64;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = document.createElement("canvas");
    cv.className = "d-hist";
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", "亮度直方图");

    const ctx = cv.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      const max = Math.max(1, ...bins);
      const norm = (v: number) => Math.log1p(v) / Math.log1p(max);
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < bins.length; i++) {
        const x = (i / (bins.length - 1)) * W;
        ctx.lineTo(x, H - norm(bins[i]) * (H - 2));
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = "rgba(74, 158, 255, 0.5)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    el.append(title, cv);
    return el;
  }

  private coordText(lat: number, lon: number): string {
    return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }

  /** 构造一节；无值的行不渲染 */
  private section(title: string, rows: Row[]) {
    const el = document.createElement("section");
    el.className = "d-sec";
    const h = document.createElement("h3");
    h.textContent = title;
    const dl = document.createElement("dl");
    const cells = new Map<string, HTMLElement>();
    let count = 0;
    for (const [label, value, warn] of rows) {
      if (!value) continue;
      const row = document.createElement("div");
      row.className = "d-row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (warn) dd.classList.add("warn");
      row.append(dt, dd);
      dl.append(row);
      cells.set(label, dd);
      count++;
    }
    el.append(h, dl);
    return { el, count, cell: (label: string) => cells.get(label) ?? null };
  }

  // ---------- 操作 ----------

  private syncActions() {
    const has = !!this.path;
    this.copyPathBtn.disabled = !has;
    this.revealBtn.disabled = !has;
  }

  /** 当前数据是否确属当前图片（切图后、新数据到达前为 null） */
  private fresh(): ImageDetails | null {
    return this.data && this.dataFor === this.path ? this.data : null;
  }

  private async copyPath() {
    if (!this.path) return;
    const d = this.fresh();
    const text = d ? d.file.path : this.path;
    await copyText(text, d ? this.pathEl : null, "已复制路径");
  }

  private async copyCoords() {
    const g = this.fresh()?.gps;
    if (!g) return;
    await copyText(this.coordText(g.latitude, g.longitude), this.coordEl, "已复制坐标");
  }

  private async reveal() {
    if (!this.path) return;
    try {
      await invoke("reveal_in_explorer", { path: this.path });
    } catch (e) {
      toast(`无法在资源管理器中显示：${String(e)}`);
    }
  }
}
