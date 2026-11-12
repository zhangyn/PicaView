// 右键菜单：跟随光标显示，点外面 / Esc / 滚轮 / 窗口失焦都关闭
//
// 与 ⋯ 菜单共用 .popup 的视觉样式；这里是"按需构建条目"，所以条目由调用方给出。

export interface MenuEntry {
  label: string;
  /** 右侧快捷键提示 */
  hint?: string;
  action: () => void;
  disabled?: boolean;
}

export type MenuItem = MenuEntry | "separator";

export class ContextMenu {
  private readonly host: HTMLElement;
  private opened = false;

  constructor(host: HTMLElement) {
    this.host = host;
    window.addEventListener("pointerdown", (e) => {
      if (!this.opened) return;
      if (this.host.contains(e.target as Node)) return;
      this.close();
    }, true);
    window.addEventListener("keydown", (e) => {
      if (!this.opened) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // 不要顺带退出灯箱/关窗
        this.close();
      }
    }, true);
    window.addEventListener("blur", () => this.close());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 在光标位置弹出；超出视口时自动往回收 */
  show(clientX: number, clientY: number, items: MenuItem[]) {
    this.host.textContent = "";
    for (const item of items) {
      if (item === "separator") {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        sep.setAttribute("role", "separator");
        this.host.append(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.disabled = !!item.disabled;
      const label = document.createElement("span");
      label.textContent = item.label;
      btn.append(label);
      if (item.hint) {
        const kbd = document.createElement("kbd");
        kbd.textContent = item.hint;
        btn.append(kbd);
      }
      btn.addEventListener("click", () => {
        this.close();
        item.action();
      });
      this.host.append(btn);
    }

    this.opened = true;
    this.host.classList.remove("hidden");
    // 先显示再测量，才能按实际尺寸夹进视口
    const r = this.host.getBoundingClientRect();
    const pad = 6;
    this.host.style.left = `${Math.max(pad, Math.min(clientX, window.innerWidth - r.width - pad))}px`;
    this.host.style.top = `${Math.max(pad, Math.min(clientY, window.innerHeight - r.height - pad))}px`;
    this.host.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    this.host.classList.add("hidden");
    this.host.textContent = "";
  }
}
