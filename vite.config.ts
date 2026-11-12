import { defineConfig } from "vite";

// Tauri 需要固定端口；clearScreen 避免打断 cargo 输出
export default defineConfig({
  clearScreen: false,
  // 关于/快捷键面板里显示版本号；直接用 npm 传进来的 package.json 版本
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
  },
});
