import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发模式固定端口，且不能在端口被占用时自动切换，
// 否则 Rust 侧 devUrl 会对不上。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    sourcemap: false,
  },
});
