// 通用小工具

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i + 1).toLowerCase() : "";
}

export const IMAGE_EXTS = ["jpg", "jpeg", "png", "bmp", "gif", "webp"];

export function isImageExt(path: string): boolean {
  return IMAGE_EXTS.includes(extOf(path));
}

/** 无透明通道的格式 */
export function isOpaqueExt(path: string): boolean {
  const e = extOf(path);
  return e === "jpg" || e === "jpeg" || e === "bmp";
}

export function isJpeg(path: string): boolean {
  const e = extOf(path);
  return e === "jpg" || e === "jpeg";
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function toast(msg: string, ms = 2500): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => el.classList.add("hidden"), ms);
}

export function setTitle(t: string): void {
  document.title = t;
  // Tauri 不联动 document.title，需显式设置原生窗口标题
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(t))
    .catch(() => {});
}

// ---------- 闲置隐藏控件 ----------

let idleTimer = 0;
let forced = false;

function wake() {
  document.body.classList.remove("controls-off");
  if (!forced) {
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (!forced) document.body.classList.add("controls-off");
    }, 3000);
  }
}

/** 强制显示（对话框打开时） */
export function controlsForce(on: boolean) {
  forced = on;
  if (on) wake();
}

export function attachIdleHider() {
  window.addEventListener("mousemove", wake);
  window.addEventListener("mousedown", wake);
  window.addEventListener("wheel", wake, { passive: true });
  wake();
}
