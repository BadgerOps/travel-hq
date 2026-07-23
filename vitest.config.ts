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
        // Single source of truth for bindings: the testing environment's DB.
        wrangler: { configPath: "./wrangler.toml", environment: "testing" },
        // wrangler.toml now declares the [ai] binding (issue #6), and Workers
        // AI has no local simulator — with this left at its default (true)
        // the pool starts a REMOTE proxy session against the real Cloudflare
        // API, which needs a CLOUDFLARE_API_TOKEN and would let tests reach a
        // real model. Both are wrong for this suite: extraction tests inject
        // a fake `{ run: async () => ... }` binding, so the real one must
        // simply not exist here.
        remoteBindings: false,
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
