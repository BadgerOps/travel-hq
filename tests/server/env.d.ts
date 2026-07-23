import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// `env` from cloudflare:test is typed as `Cloudflare.Env`, an ambient
// namespace declared (empty, for merging) by @cloudflare/workers-types. This
// file is a module (it imports a type), so the augmentation must go through
// `declare global` to reach the ambient namespace rather than a module-scoped
// one.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      // Declared because wrangler.toml binds [ai] (issue #6). Tests must
      // NEVER call env.AI.run — every extraction test injects a fake
      // `{ run: async () => ... }` so CI never touches a real model.
      AI: Ai;
      ENCRYPTION_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
