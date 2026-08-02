import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The one place the running version comes from. Settings displays
// __APP_VERSION__ so a bug report can name its build; reading package.json
// here means that number cannot disagree with the package or with the release
// CHANGELOG.md records (tests/server/architecture.test.ts asserts the pair).
// The same define is repeated in vitest.client.config.ts -- without it the
// constant is undefined under the jsdom suite.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    proxy: {
      // Same-origin in production (one tunnel, one hostname), so the client
      // only ever writes relative /api paths. This makes dev match that.
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
