import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The SPA lives in web/ and builds to dist/, which the Worker serves as ASSETS.
export default defineConfig({
  plugins: [react()],
  root: "web",
  resolve: {
    alias: {
      "@schema": fileURLToPath(new URL("./schema", import.meta.url)),
      "@web": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // During `vite` dev, proxy API + WS calls to `wrangler dev`.
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
