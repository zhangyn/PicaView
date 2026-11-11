// 设置面板：灯箱 / 胶片条 / 信息浮层 / 排序 / 主题
//
// 除"打开即灯箱"（下次打开图片才生效）外，改动立即作用到界面并落盘。

import { Modal } from "./modal";
import { getSettings, updateSettings, type SortMode, type Theme } from "./settings";

export interface SettingsHooks {
  setFilmstrip(v: boolean): void;
  setInfo(v: boolean): void;
  setSort(v: SortMode): void;
  setTheme(v: Theme): void;
}

export class SettingsPanel {
  private readonly modal: Modal;
  private readonly lightboxEl = document.getElementById("set-lightbox") as HTMLInputElement;
  private readonly filmstripEl = document.getElementById("set-filmstrip") as HTMLInputElement;
  private readonly infobarEl = document.getElementById("set-infobar") as HTMLInputElement;
  private readonly sortEl = document.getElementById("set-sort") as HTMLSelectElement;
  private readonly themeEl = document.getElementById("set-theme") as HTMLSelectElement;
  private readonly hintEl = document.getElementById("settings-hint")!;

  constructor(private readonly hooks: SettingsHooks) {
    this.modal = new Modal(
      document.getElementById("settings-backdrop")!,
      () => this.lightboxEl,
      () => this.sync(),
    );

    this.lightboxEl.addEventListener("change", () => {
      updateSettings({ lightbox: this.lightboxEl.checked });
      this.hint(this.lightboxEl.checked
        ? "打开图片时将进入全屏灯箱（下次打开生效）"
        : "打开图片时使用普通窗口（下次打开生效）");
    });
    this.filmstripEl.addEventListener("change", () => {
      updateSettings({ filmstrip: this.filmstripEl.checked });
      this.hooks.setFilmstrip(this.filmstripEl.checked);
    });
    this.infobarEl.addEventListener("change", () => {
      updateSettings({ infobar: this.infobarEl.checked });
      this.hooks.setInfo(this.infobarEl.checked);
    });
    this.sortEl.addEventListener("change", () => {
      const sort = this.sortEl.value as SortMode;
      updateSettings({ sort });
      this.hooks.setSort(sort);
    });
    this.themeEl.addEventListener("change", () => {
      const theme = this.themeEl.value as Theme;
      updateSettings({ theme });
      this.hooks.setTheme(theme);
    });

    document.getElementById("settings-close")!.addEventListener("click", () => this.modal.close());
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open() {
    this.modal.open();
  }

  private sync() {
    const s = getSettings();
    this.lightboxEl.checked = s.lightbox;
    this.filmstripEl.checked = s.filmstrip;
    this.infobarEl.checked = s.infobar;
    this.sortEl.value = s.sort;
    this.themeEl.value = s.theme;
    this.hintEl.textContent = "";
  }

  private hint(text: string) {
    this.hintEl.textContent = text;
  }
}
