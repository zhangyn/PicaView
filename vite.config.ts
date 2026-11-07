import { defineConfig } from "vite";

// Tauri 需要固定端口；clearScreen 避免打断 cargo 输出
export default defineConfig({
  clearScreen: false,
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
