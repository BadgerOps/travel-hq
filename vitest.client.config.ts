import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Mirrors vite.config.ts. The client tests do not go through the app build, so
// without this define __APP_VERSION__ is simply undefined here and anything
// rendering it fails in a way that looks like a component bug rather than a
// missing build-time substitution.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    // Both extensions: several client tests are plain .ts (the api client,
    // the date helpers) because they render nothing.
    include: ["tests/client/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/client/setup.ts"],
  },
});
