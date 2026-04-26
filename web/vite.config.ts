import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../public",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080"
    }
  }
});
