// 设置面板：灯箱 / 胶片条 / 信息浮层 / 排序 / 主题
//
// 除"打开即灯箱"（下次打开图片才生效）外，改动立即作用到界面并落盘。

import { Modal } from "./modal";
import {
  getSettings, updateSettings, type RotateMode, type SortMode, type Theme, type WheelMode,
} from "./settings";

export interface SettingsHooks {
  setFilmstrip(v: boolean): void;
  setInfo(v: boolean): void;
  setSort(v: SortMode): void;
  setTheme(v: Theme): void;
  setRotateMode(v: RotateMode): void;
  setFrameless(v: boolean): void;
}

export class SettingsPanel {
  private readonly modal: Modal;
  private readonly lightboxEl = document.getElementById("set-lightbox") as HTMLInputElement;
  private readonly framelessEl = document.getElementById("set-frameless") as HTMLInputElement;
  private readonly filmstripEl = document.getElementById("set-filmstrip") as HTMLInputElement;
  private readonly infobarEl = document.getElementById("set-infobar") as HTMLInputElement;
  private readonly sortEl = document.getElementById("set-sort") as HTMLSelectElement;
  private readonly themeEl = document.getElementById("set-theme") as HTMLSelectElement;
  private readonly rotateEl = document.getElementById("set-rotate") as HTMLSelectElement;
  private readonly wheelEl = document.getElementById("set-wheel") as HTMLSelectElement;
  private readonly restoreEl = document.getElementById("set-restore") as HTMLInputElement;
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
    this.framelessEl.addEventListener("change", () => {
      updateSettings({ frameless: this.framelessEl.checked });
      this.hooks.setFrameless(this.framelessEl.checked);
      this.hint(this.framelessEl.checked
        ? "已隐藏标题栏：右键拖动移动窗口，Esc 退出软件"
        : "已恢复标题栏");
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
    this.wheelEl.addEventListener("change", () => {
      updateSettings({ wheel: this.wheelEl.value as WheelMode });
      this.hint(this.wheelEl.value === "page"
        ? "滚轮翻页，Ctrl+滚轮缩放"
        : "滚轮缩放（Ctrl+滚轮也是缩放）");
    });
    this.restoreEl.addEventListener("change", () => {
      updateSettings({ restore_last_dir: this.restoreEl.checked });
      this.hint(this.restoreEl.checked ? "下次启动会打开最近一次浏览的文件夹" : "下次启动显示空状态");
    });
    this.rotateEl.addEventListener("change", () => {
      const mode = this.rotateEl.value as RotateMode;
      updateSettings({ rotate_mode: mode });
      this.hooks.setRotateMode(mode);
      this.hint(mode === "view"
        ? "旋转只影响显示，不改动图片文件；方向会被记住，导出/复制时一并应用"
        : "旋转会直接写入图片（JPEG 无损）；已记下的显示方向会在下一次旋转时一起写入");
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
    this.framelessEl.checked = s.frameless;
    this.filmstripEl.checked = s.filmstrip;
    this.infobarEl.checked = s.infobar;
    this.sortEl.value = s.sort;
    this.themeEl.value = s.theme;
    this.rotateEl.value = s.rotate_mode;
    this.wheelEl.value = s.wheel;
    this.restoreEl.checked = s.restore_last_dir;
    this.hintEl.textContent = "";
  }

  private hint(text: string) {
    this.hintEl.textContent = text;
  }
}
