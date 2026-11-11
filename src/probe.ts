// 鼠标位置的像素坐标与颜色（C 键开关）
//
// 采样走"源位图 + 1×1 离屏画布"，绝不读主画布：主画布是 GPU 光栅化，
// getImageData 会触发 GPU→CPU 同步，鼠标一动就掉帧。

import type { Viewer } from "./viewer";

export class PixelProbe {
  private readonly root: HTMLElement;
  private readonly swatch: HTMLElement;
  private readonly label: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly viewer: Viewer;
  private raf = 0;
  private pending: { x: number; y: number } | null = null;
  private shown = false;
  enabled = false;

  constructor(viewer: Viewer, stage: HTMLElement, root: HTMLElement) {
    this.viewer = viewer;
    this.stage = stage;
    this.root = root;
    this.swatch = root.querySelector(".pp-swatch")!;
    this.label = root.querySelector(".pp-text")!;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    if (!this.enabled) this.hide();
    return this.enabled;
  }

  /** 鼠标在舞台上移动时调用；rAF 节流，一帧最多算一次 */
  onMove(clientX: number, clientY: number) {
    if (!this.enabled) return;
    this.pending = { x: clientX, y: clientY };
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const p = this.pending;
      this.pending = null;
      if (p && this.enabled) this.update(p.x, p.y);
    });
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.root.classList.add("hidden");
  }

  private update(clientX: number, clientY: number) {
    const view = this.viewer.view;
    if (!view) {
      this.hide();
      return;
    }
    const rect = this.stage.getBoundingClientRect();
    // CSS 坐标 → 设备像素 → 位图坐标 → 源图像素坐标（LOD 降采样时两者不同）
    const bx = ((clientX - rect.left) * this.viewer.dpr - view.tx) / view.scale;
    const by = ((clientY - rect.top) * this.viewer.dpr - view.ty) / view.scale;
    if (bx < 0 || by < 0 || bx >= view.iw || by >= view.ih) {
      this.hide();
      return;
    }
    const sx = Math.floor(bx / this.viewer.lodRatio);
    const sy = Math.floor(by / this.viewer.lodRatio);
    const color = this.viewer.sampleColor(Math.floor(bx), Math.floor(by));
    if (!color) {
      this.hide();
      return;
    }
    const [r, g, b, a] = color;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    this.swatch.style.background = a === 0 ? "transparent" : `rgba(${r},${g},${b},${a / 255})`;
    this.label.textContent = `${sx}, ${sy} · ${hex}${a < 255 ? ` · α${Math.round((a / 255) * 100)}%` : ""}`;

    // 贴着光标显示，靠近窗口边缘时翻到另一侧
    const pad = 14;
    this.root.classList.remove("hidden");
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const x = clientX + pad + w > window.innerWidth ? clientX - pad - w : clientX + pad;
    const y = clientY + pad + h > window.innerHeight ? clientY - pad - h : clientY + pad;
    this.root.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
    this.shown = true;
  }
}
