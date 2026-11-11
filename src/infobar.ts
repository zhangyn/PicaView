// 左下信息浮层：文件名 / 序号 / 尺寸 / 大小 / 拍摄信息

import { humanSize } from "./util";
import type { ExifInfo, ImageEntry } from "./types";

export class InfoBar {
  private root: HTMLElement;
  private nameEl: HTMLElement;
  private metaEl: HTMLElement;
  visible = true;
  // 分段保存，避免二次更新时互相覆盖
  private base = "";
  private dims: { w: number; h: number } | null = null;
  private exif: ExifInfo | null = null;

  constructor() {
    this.root = document.getElementById("infobar")!;
    this.nameEl = document.getElementById("info-name")!;
    this.metaEl = document.getElementById("info-meta")!;
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  /** 显示/隐藏（启动时按设置恢复） */
  setVisible(v: boolean) {
    this.visible = v;
    this.root.classList.toggle("hidden2", !v);
  }

  /** 打开文件后立即更新（尺寸信息稍后补） */
  show(entry: ImageEntry, index: number, total: number) {
    this.dims = null;
    this.exif = null;
    this.setPosition(entry, index, total);
  }

  /** 仅刷新文件名/序号/大小，保留已读到的尺寸与 EXIF（列表就绪后更新"第 n/N 张"用） */
  setPosition(entry: ImageEntry, index: number, total: number) {
    this.nameEl.textContent = entry.name;
    this.base = `第 ${index + 1}/${total} 张 · ${humanSize(entry.size)}`;
    this.render();
  }

  /** 全图解码 / EXIF 读取完成后补充 */
  updateMeta(dims: { w: number; h: number } | null, exif: ExifInfo | null) {
    if (dims) this.dims = dims;
    if (exif) this.exif = exif;
    this.render();
  }

  private render() {
    const parts = [this.base];
    if (this.dims) parts.push(`${this.dims.w}×${this.dims.h}`);
    if (this.exif?.date_taken) parts.push(this.exif.date_taken);
    if (this.exif?.camera) parts.push(this.exif.camera);
    this.metaEl.textContent = parts.join(" · ");
  }
}
