// 快捷键一览（?）：静态表格 + 版本号
//
// 快捷键已经二十多个，全散在 README 里不现实；这个面板是唯一的"发现入口"。

import { Modal } from "./modal";

export class HelpPanel {
  private readonly modal: Modal;

  constructor() {
    this.modal = new Modal(
      document.getElementById("help-backdrop")!,
      () => document.getElementById("help-close") as HTMLElement,
    );
    document.getElementById("help-close")!.addEventListener("click", () => this.modal.close());

    const version = document.getElementById("help-version");
    if (version) version.textContent = `PicaView v${__APP_VERSION__} · MIT`;
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  toggle() {
    if (this.modal.isOpen) this.modal.close();
    else this.modal.open();
  }

  open() {
    this.modal.open();
  }
}
