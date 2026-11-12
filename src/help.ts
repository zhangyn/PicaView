// 快捷键一览（?）：静态表格 + 版本号 + 打开日志
//
// 快捷键已经二十多个，全散在 README 里不现实；这个面板是唯一的"发现入口"。

import { invoke } from "@tauri-apps/api/core";

import { Modal } from "./modal";
import { toast } from "./util";

export class HelpPanel {
  private readonly modal: Modal;

  constructor() {
    this.modal = new Modal(
      document.getElementById("help-backdrop")!,
      () => document.getElementById("help-close") as HTMLElement,
    );
    document.getElementById("help-close")!.addEventListener("click", () => this.modal.close());
    document.getElementById("help-log")!.addEventListener("click", () => void this.openLog());

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

  private async openLog() {
    try {
      const path = await invoke<string | null>("log_path");
      if (!path) {
        toast("找不到日志目录");
        return;
      }
      await invoke("reveal_in_explorer", { path });
    } catch (e) {
      toast(`无法打开日志：${String(e)}`);
    }
  }
}
