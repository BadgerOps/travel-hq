import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
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

/**
 * Tesseract normally downloads executable worker/core code and trained data
 * from jsDelivr at scan time. Passport images would still be processed in a
 * Web Worker, but executing remotely hosted code in the privacy boundary is
 * an unnecessary dependency and also breaks the PWA offline. Serve the npm-
 * locked assets from our own origin without putting 15 MB of generated binary
 * files in git. Nothing here is part of index.html or a module preload; the
 * browser requests it only after a person chooses a passport photo.
 */
function localOcrAssets(): Plugin {
  const root = new URL("./node_modules/", import.meta.url);
  const coreDir = new URL("tesseract.js-core/", root);
  const sources = [
    new URL("tesseract.js/dist/worker.min.js", root),
    new URL("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", root),
    ...readdirSync(coreDir)
      // OEM 1 below is LSTM-only, so the worker can select among baseline,
      // SIMD and relaxed-SIMD without shipping the three legacy-core builds.
      .filter((name) => /^tesseract-core(?:-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(name))
      .map((name) => new URL(name, coreDir)),
  ];
  const byPath = new Map(
    sources.map((source) => [`/assets/ocr/${basename(source.pathname)}`, source]),
  );

  return {
    name: "local-ocr-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const source = byPath.get(request.url?.split("?", 1)[0] ?? "");
        if (!source) return next();
        const name = basename(source.pathname);
        response.setHeader(
          "content-type",
          name.endsWith(".wasm")
            ? "application/wasm"
            : name.endsWith(".gz")
              ? "application/gzip"
              : "text/javascript",
        );
        response.end(readFileSync(source));
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      const target = resolve(options.dir, "assets/ocr");
      mkdirSync(target, { recursive: true });
      for (const source of sources) {
        copyFileSync(source, resolve(target, basename(source.pathname)));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), localOcrAssets()],
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
