// 通用模态面板（导出 / 设置）：背景点击与 Esc 关闭、打开时焦点进入面板、关闭后还原焦点
//
// 与 dialog.ts 的确认框共存：确认框（可能由模态内部弹出）优先处理按键，
// 并且它的键盘监听注册在 document 上、比这里的 window 捕获更晚，
// 所以必须先让位，否则 stopPropagation 会让确认框收不到 Esc。

import { dialogOpen, modalBegin, modalEnd } from "./dialog";

export class Modal {
  private opened = false;
  private prevFocus: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    /** 打开时聚焦的控件 */
    private readonly initial: () => HTMLElement | null,
    /** 每次打开前的准备（回填控件状态等） */
    private readonly prepare?: () => void,
  ) {
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (!this.opened || dialogOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // 不要顺带退出灯箱 / 关窗
        this.close();
      }
    }, true);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    modalBegin();
    this.prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.prepare?.();
    this.root.classList.remove("hidden");
    this.initial()?.focus();
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    this.root.classList.add("hidden");
    modalEnd();
    if (this.prevFocus?.isConnected) this.prevFocus.focus();
    this.prevFocus = null;
    this.onClosed?.();
  }

  /** 关闭后的清理钩子（子类/调用方覆盖） */
  onClosed?: () => void;
}
