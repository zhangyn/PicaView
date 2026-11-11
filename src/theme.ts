// 主题：深色 / 浅色 / 跟随系统
//
// DOM 上打 data-theme（style.css 末尾的浅色覆盖块据此生效），
// 同时同步原生标题栏配色（需要 core:window:allow-set-theme 权限）。

import { getCurrentWindow } from "@tauri-apps/api/window";

import { getSettings, type Theme } from "./settings";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

export function isLightTheme(theme: Theme): boolean {
  return theme === "light" || (theme === "system" && !systemPrefersDark());
}

/** 应用主题；窗口配色失败（无权限/非 Tauri）不影响页面主题 */
export function applyTheme(theme: Theme) {
  const light = isLightTheme(theme);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  try {
    void getCurrentWindow().setTheme(light ? "light" : "dark").catch(() => {});
  } catch { /* 非 Tauri 环境（纯浏览器调试） */ }
}

/** 跟随系统时，系统切换深浅色要实时跟上 */
export function watchSystemTheme() {
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (getSettings().theme === "system") applyTheme("system");
  });
}
