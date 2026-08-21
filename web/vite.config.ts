import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds into worker/public, which is what wrangler.toml's [assets] binding
 * serves. The Worker and the dashboard are one deploy: there is no separate
 * static host to keep in sync, and no CORS to configure, because the SPA and the
 * API answer on the same origin.
 *
 * `emptyOutDir` is on so a renamed chunk from a previous build cannot linger and
 * be served alongside the new index.html.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../worker/public",
    emptyOutDir: true,
    // Source maps: the bundle is public anyway and a stack trace from a real
    // browser is worth more than the few KB.
    sourcemap: true,
  },
  server: {
    // `npm run dev` talks to the deployed Worker rather than needing a local
    // one, so the dashboard can be developed against real data.
    proxy: {
      "/api": {
        target: "https://taiwan-semicon-revenue.tech-441.workers.dev",
        changeOrigin: true,
      },
    },
  },
});
