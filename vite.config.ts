import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/core/target/**",
        "**/test-results/**",
        "**/playwright-report/**",
      ],
    },
  },
  worker: { format: "es" },
  build: { target: "es2022" },
});
