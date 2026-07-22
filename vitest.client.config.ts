import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Both extensions: several client tests are plain .ts (the api client,
    // the date helpers) because they render nothing.
    include: ["tests/client/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/client/setup.ts"],
  },
});
