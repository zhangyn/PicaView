// 幻灯片：3s 自动播放，进入全屏（全屏/蒙板联动由 main 注入）

import { SLIDESHOW_INTERVAL_MS } from "./config";

export class Slideshow {
  private timer = 0;
  playing = false;
  /** 全屏状态是幻灯片自己进入的（stop 时才需要退出） */
  private enteredFullscreen = false;
  onNext: (() => void) | null = null;
  /** 全屏开关由 main 注入（含蒙板联动） */
  fullscreenHandler: ((on: boolean) => void) | null = null;
  /** 查询窗口当前是否已全屏，由 main 注入 */
  isFullscreen: (() => Promise<boolean>) | null = null;
  private btn: HTMLButtonElement;

  constructor() {
    this.btn = document.getElementById("btn-slideshow") as HTMLButtonElement;
  }

  toggle() {
    this.playing ? this.stop() : this.start();
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.enteredFullscreen = false;
    this.btn.classList.add("active");
    this.timer = window.setInterval(() => this.onNext?.(), SLIDESHOW_INTERVAL_MS);
    void this.enterFullscreen();
  }

  /** 开始前已全屏则不动；否则进入全屏并记下"是我进的" */
  private async enterFullscreen() {
    let already = false;
    try {
      already = (await this.isFullscreen?.()) ?? false;
    } catch { /* 查询失败按未全屏处理 */ }
    if (!this.playing || already) return; // await 期间已被 stop
    this.enteredFullscreen = true;
    this.fullscreenHandler?.(true);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.btn.classList.remove("active");
    clearInterval(this.timer);
    if (this.enteredFullscreen) {
      this.enteredFullscreen = false;
      this.fullscreenHandler?.(false);
    }
  }
}
