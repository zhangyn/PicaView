// "更多操作"菜单：复制图片 / 复制文件 / 设为桌面壁纸
//
// 复制图片走 CF_DIB（长边超限先缩小），复制文件走 CF_HDROP（粘贴出来是文件，零转码）。

import { invoke } from "@tauri-apps/api/core";

import { COPY_IMAGE_MAX_SIDE } from "./config";
import { toast } from "./util";

/** 复制当前图片到剪贴板；返回是否成功 */
export async function copyImage(path: string): Promise<boolean> {
  try {
    const [w, h] = await invoke<[number, number]>("copy_image", {
      path,
      maxSide: COPY_IMAGE_MAX_SIDE,
    });
    toast(`已复制图片 ${w}×${h}，可直接粘贴`);
    return true;
  } catch (e) {
    toast(`复制图片失败：${String(e)}`);
    return false;
  }
}

/** 把文件本身放到剪贴板 */
export async function copyFiles(paths: string[]): Promise<boolean> {
  try {
    const n = await invoke<number>("copy_files", { paths });
    toast(n > 1 ? `已复制 ${n} 个文件` : "已复制文件，可直接粘贴");
    return true;
  } catch (e) {
    toast(`复制文件失败：${String(e)}`);
    return false;
  }
}

export async function setWallpaper(path: string): Promise<boolean> {
  try {
    await invoke("set_wallpaper", { path });
    toast("已设为桌面壁纸");
    return true;
  } catch (e) {
    toast(`设为壁纸失败：${String(e)}`);
    return false;
  }
}

export type MenuAction = "copy-image" | "copy-file" | "wallpaper";

/** 下拉菜单：按钮展开、点外面/Esc/选中后关闭，焦点回到按钮 */
export class MoreMenu {
  private root: HTMLElement;
  private btn: HTMLButtonElement;
  private open = false;

  constructor(
    btn: HTMLButtonElement,
    root: HTMLElement,
    private getPath: () => string | null,
    private onPick: (act: MenuAction) => void,
  ) {
    this.btn = btn;
    this.root = root;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
    root.addEventListener("click", (e) => {
      const target = (e.target as Element | null)?.closest?.("[data-act]");
      const act = target?.getAttribute("data-act") as MenuAction | null;
      if (!act) return;
      this.close();
      this.onPick(act);
    });
    // 点外面关闭（捕获阶段，避免和舞台的双击/点击逻辑抢）
    window.addEventListener("pointerdown", (e) => {
      if (!this.open) return;
      const t = e.target as Node | null;
      if (t && (this.root.contains(t) || this.btn.contains(t))) return;
      this.close();
    }, true);
    window.addEventListener("keydown", (e) => {
      if (!this.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // 不要顺带退出灯箱/关窗
        this.close();
      }
    }, true);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (this.open) return;
    if (!this.getPath()) {
      toast("没有打开的图片");
      return;
    }
    this.open = true;
    this.root.classList.remove("hidden");
    this.btn.classList.add("active");
    this.btn.setAttribute("aria-expanded", "true");
    (this.root.querySelector("[role=menuitem]") as HTMLElement | null)?.focus();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add("hidden");
    this.btn.classList.remove("active");
    this.btn.setAttribute("aria-expanded", "false");
    if (this.root.contains(document.activeElement)) this.btn.focus();
  }
}
