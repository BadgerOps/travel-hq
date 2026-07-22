import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/server/architecture.test.ts"],
    environment: "node",
  },
});
