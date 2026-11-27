import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri wird von Rust selbst beobachtet
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri erwartet ein festes Build-Verzeichnis
  build: {
    target: "esnext",
    outDir: "dist",
  },
});
