import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // readD1Migrations reads migrations/ (ordered by number, each split into
      // individual statements) so a setup file can apply them to the local D1.
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        // Never open a remote Workers AI proxy in tests; extraction injects a
        // fake binding and CI must not call a billable model.
        wrangler: {
          configPath: "./wrangler.toml",
          environment: "testing",
          remoteBindings: false,
        },
        miniflare: {
          // Test-only binding; not declared in wrangler.toml.
          // TEST_MIGRATIONS: applied to the local D1 by the setup file.
          // ENCRYPTION_KEY: a fixed test key so the suite is self-contained and
          // does NOT depend on a local `.dev.vars` (which is gitignored, so CI
          // has none — a route that reaches loadKeyring() would 500 there).
          // <key_id> <base64-32-bytes>, per loadKeyring's format.
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENCRYPTION_KEY: "server-v1 Y2ktdGVzdC1rZXktMzItYnl0ZXMtMDAwMDAwMDAwMDA=",
          },
        },
      };
    }),
  ],
  test: {
    include: ["tests/server/**/*.test.ts"],
    exclude: ["tests/server/architecture.test.ts", "node_modules/**"],
    setupFiles: ["./tests/server/apply-migrations.ts"],
    // Each workers-pool file spins up its own workerd; running many in parallel
    // deadlocks in constrained/sandboxed environments. D1 isolated-storage
    // suites are fine serial, and it keeps the run stable everywhere.
    fileParallelism: false,
  },
});
