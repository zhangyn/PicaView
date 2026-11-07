// 幻灯片：3s 自动播放，进入全屏（全屏/蒙板联动由 main 注入）

const INTERVAL_MS = 3000;

export class Slideshow {
  private timer = 0;
  playing = false;
  onNext: (() => void) | null = null;
  /** 全屏开关由 main 注入（含蒙板联动） */
  fullscreenHandler: ((on: boolean) => void) | null = null;
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
    this.btn.classList.add("active");
    this.fullscreenHandler?.(true);
    this.timer = window.setInterval(() => this.onNext?.(), INTERVAL_MS);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.btn.classList.remove("active");
    clearInterval(this.timer);
    this.fullscreenHandler?.(false);
  }
}
