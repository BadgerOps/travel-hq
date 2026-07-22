# Cloudflare Plan A — Server Re-platform to D1 / Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the entire Travel HQ server from Node + `node:sqlite` to a single Cloudflare Worker on D1, preserving the HTTP API contract and the React client (`src/client/`) unchanged, with all tests green on the `@cloudflare/vitest-pool-workers` harness and the old `node:sqlite` server deleted.

**Architecture:** One Hono Worker (`src/server/worker.ts`) reads/writes **D1** (`env.DB`), encrypts document numbers with **WebCrypto** AES-256-GCM (key from a Workers secret), and authenticates humans with **Cloudflare Access** via `jose`. Every repository method becomes `async` and `await`s D1. The tenancy guarantee is re-solved on D1's explicit indexed parameters: `{scope}` reserves `?1` for the household id, callers write `?2`, `?3`, …. Tests run against a local D1 under the workers pool.

**Tech Stack:** Cloudflare Workers (workerd), D1, Hono, `jose`, `uuid`, `zod`, WebCrypto, Wrangler, `@cloudflare/vitest-pool-workers`, Vitest 4, TypeScript 5.7.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-22-cloudflare-replatform-design.md`. Every task's requirements implicitly include this section.

- **D1 prepared statements are positional-only** — ordered `?NNN` and anonymous `?`, **NO named parameters** (`:name`). The API is async: `await env.DB.prepare(sql).bind(...values).all()` / `.first()` / `.run()`.
- **D1 supports `ON DELETE CASCADE`** and foreign keys; wrap any migration needing it in `PRAGMA defer_foreign_keys = on`. D1 enforces FKs by default — the old `PRAGMA foreign_keys = ON` is dropped.
- **WebCrypto is async** — `crypto.subtle.encrypt/decrypt/importKey`. There is no `node:crypto` on Workers. AES-GCM returns the auth tag **appended** to the ciphertext.
- **Encryption is kept.** The AES-256-GCM key is a 32-byte value from a **Workers secret** (`env.ENCRYPTION_KEY`, base64), never a file.
- **Tenancy binding, `?1`-reserved rule:** `{scope}` expands to `household_id = ?1`. The base **reserves index `?1`** for the household id and binds it FIRST (`stmt.bind(ctx.householdId, ...callerParams)`). Repository queries write their own parameters starting at **`?2`, `?3`, …**, never `?1`.
- **Only the three human roles** exist in this plan: `owner | adult | viewer`. `requireWrite()` denies viewer; `requireReveal()` denies viewer. The `machine` role, `requireIngestWrite`, and `insert()`'s guard parameter are **DEFERRED with ingest — not in this plan**.
- **HTTP API contract preserved.** Routes, request/response shapes, the error taxonomy (`RepoError` → `TenantScopeError` 500 / `ForbiddenError` 403 / `NotFoundError` 404 / `ValidationError` 400; `AuthError` 401 / `HouseholdAccessError` 403), and the masked-value discipline stay identical. A route that returned 404 for a foreign id still does; a viewer still gets 403; a masked value is never returned as plaintext.
- **No ORM or query builder** — hand-written SQL, tenancy guarantee in one small auditable place.
- **IDs are UUIDv7** (`newId()`), never autoincrement integers.
- **Timestamps** are stored as UTC ISO-8601 strings, always paired with an IANA timezone column.
- **TDD, always:** write the failing test, run it red, implement, run it green, commit. **Every task ends green and with one commit.** Never leave the suite red at a task boundary — this is why the routes are in the same plan as the repos.

## Deferred — NOT in this plan (later plans)

- `inbound_email` table, `InboundEmailRepo`, `/api/inbound-email` routes, `/import` review UI. (The `/import` nav entry stays a stub — but the CLIENT is not modified in Plan A at all.)
- The `machine` role, `requireIngestWrite`, `createServiceTokenVerifier`, `householdExists`, `WorkersAiExtractor`, the ingest `email()` handler, `household_settings` / agent-config.
- Static client hosting (Plan B). GitHub / CI/CD / email forwarding (Plan C).

---

## Verified Cloudflare fact (checked against current docs)

`@cloudflare/vitest-pool-workers` (Vitest 4 line) supports a **local D1 with automatic migration application**. The documented shape used by this plan:

- The `cloudflareTest` plugin (from `@cloudflare/vitest-pool-workers`) is added to `vitest.config.ts`. It accepts either a static `{ wrangler, miniflare }` object or an **async factory** returning the same.
- `readD1Migrations(migrationsPath)` (from `@cloudflare/vitest-pool-workers`) reads the `migrations/` directory, returns the migrations ordered by number, each split into individual SQL statements.
- The migrations array is injected as a **test-only Miniflare binding** (`TEST_MIGRATIONS`).
- A **setup file** imports `applyD1Migrations` and `env` from `cloudflare:test` and applies them: `await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`.
- The `DB` binding itself is declared once in `wrangler.toml` (`[[d1_databases]] binding = "DB"`, `migrations_dir = "migrations"`) and reached in tests via `import { env } from "cloudflare:test"`.

This is the config Task 1 builds and every later task's tests run under.

---

## Porting sequence and green-at-each-boundary

The server is one async dependency chain (envelope → repos → auth → routes), so tasks run **bottom-up**, and **each task leaves the workers-pool suite green for everything ported so far**.

- Modules are **rewritten in place** (same paths — `src/server/crypto/envelope.ts`, `src/server/repos/base.ts`, …). WebCrypto/D1 replace `node:crypto`/`node:sqlite`.
- **The workers pool is the sole server test command from Task 1.** The old node-based `vitest.config.ts` is replaced in Task 1; the client config (`vitest.client.config.ts`, jsdom) is untouched throughout.
- Each task **ports that module's tests to the pool and deletes the superseded node test** in the same commit. So there is never a node:sqlite test running against a rewritten module.
- Four leftover node-only files (`db/connection.ts`, `db/migrate.ts`, `serve.ts`, the old node `index.ts`) become unreferenced by their downstream ports but are only **deleted in Task 8**, together with the last old tests. They keep compiling because the server tsconfig carries `node` types until Task 8 removes them.

## File Structure

```
wrangler.toml                       ← Task 1 (bindings, [env.testing]/[env.production])
vitest.config.ts                    ← Task 1 (rewritten: cloudflareTest pool)
tsconfig.server.json                ← Task 1 (workers types)
migrations/
  0001_initial.sql                  ← Task 2 (was db/migrations/001_initial.sql, minus schema_migration/inbound_email)
tests/server/
  env.d.ts                          ← Task 1 (cloudflare:test ProvidedEnv)
  apply-migrations.ts               ← Task 1 (setup file)
  smoke.test.ts                     ← Task 1 (rewritten: /healthz under pool)
src/server/
  worker.ts                         ← Task 1 (minimal /healthz) → Task 8 (createApp().fetch)
  ids.ts                            ← unchanged (uuid v7)
  time.ts                           ← unchanged (pure)
  schemas/booking-kinds.ts          ← unchanged (zod)
  crypto/envelope.ts                ← Task 3 (WebCrypto)
  repos/base.ts                     ← Task 4 (async TenantRepo, ?1-reserved)
  repos/confirmation.ts             ← Task 6 (async)
  repos/person.ts                   ← Task 5 (async, D1)
  repos/trip.ts                     ← Task 5 (async, D1)
  repos/booking.ts                  ← Task 6 (async, D1)
  repos/itinerary.ts                ← Task 6 (async, D1)
  repos/checklist.ts                ← Task 6 (async, D1)
  repos/rollup.ts                   ← Task 6 (async, D1)
  auth.ts                           ← Task 7 (async D1 membership, resolveVerifier(env))
  index.ts                          ← Task 8 (createApp(overrides), AppEnv bindings)
  routes/{people,trips,bookings,itinerary,checklist,errors}.ts  ← Task 8 (await async repos)
```

Deleted in Task 8: `src/server/db/connection.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/`, `src/server/serve.ts`, `src/server/repos/inbound-email.ts`, `src/server/routes/inbound-email.ts`, the ingest modules, and the corresponding old tests.

---

### Task 1: Scaffold + workers-pool test harness

Stands up `wrangler.toml`, the dependencies and scripts, the `cloudflareTest` Vitest config with a local D1 and automatic migration application, a minimal Worker with `/healthz`, and a smoke test that runs under the pool and hits it. Node 22 dev still works via `nix develop -c`.

**Files:**
- Create: `wrangler.toml`
- Modify: `package.json`
- Create/replace: `vitest.config.ts`
- Modify: `tsconfig.server.json`
- Create: `tests/server/env.d.ts`
- Create: `tests/server/apply-migrations.ts`
- Create: `migrations/0001_initial.sql` (placeholder — full schema lands in Task 2; a minimal table here lets the harness apply *a* migration and prove the pipeline)
- Create/replace: `src/server/worker.ts`
- Replace: `tests/server/smoke.test.ts`

**Interfaces:**
- Produces: `src/server/worker.ts` exports `default { fetch }` (a Hono app). The `AppBindings` type (`DB: D1Database; AI: Ai; ENCRYPTION_KEY: string; …`) is finalized in Task 8; Task 1 uses a minimal inline `Bindings`.
- Produces: the `cloudflare:test` `ProvidedEnv` (`DB`, `AI`, `ENCRYPTION_KEY`, `TEST_MIGRATIONS`) that every later test imports via `import { env } from "cloudflare:test"`.

- [ ] **Step 1: Install the new dev dependencies**

Run (in the nix dev shell so Node 22 is on PATH):

```bash
nix develop -c npm install --save-dev wrangler @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

Expected: `package.json` gains the three devDeps; `package-lock.json` updates. (`vitest@^4.1.10` and `hono`/`jose`/`uuid`/`zod` are already present and stay.)

- [ ] **Step 2: Write `wrangler.toml`**

```toml
name = "travel-hq"
main = "src/server/worker.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

# Static client assets are Plan B. Declared as a placeholder, commented out so
# `wrangler dev` does not fail on a missing dist/ directory yet.
# [assets]
# directory = "dist"

[[d1_databases]]
binding = "DB"
database_name = "travel-hq-dev"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[ai]
binding = "AI"

# --- testing (PR preview target; its own D1) --------------------------------
[env.testing]
[[env.testing.d1_databases]]
binding = "DB"
database_name = "travel-hq-testing"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[env.testing.ai]
binding = "AI"

# --- production (deployed from master; its own D1) --------------------------
[env.production]
[[env.production.d1_databases]]
binding = "DB"
database_name = "travel-hq-production"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[env.production.ai]
binding = "AI"
```

The `database_id` placeholders are filled with the real ids (from `wrangler d1 create`) in Plan C; a placeholder is fine for local dev and the test pool, which use a local SQLite file, not the remote database.

- [ ] **Step 3: Rewrite `vitest.config.ts` to the workers pool**

```ts
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
        miniflare: {
          // Test-only binding; not declared in wrangler.toml.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    include: ["tests/server/**/*.test.ts"],
    setupFiles: ["./tests/server/apply-migrations.ts"],
  },
});
```

- [ ] **Step 4: Write the migration-applying setup file `tests/server/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker before any test. applyD1Migrations records applied
// migrations in the d1_migrations table, so re-runs are no-ops; isolated
// storage gives each test a clean database seeded from these migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 5: Declare the `cloudflare:test` environment in `tests/server/env.d.ts`**

```ts
import type { D1Database, D1Migration, Ai } from "@cloudflare/workers-types";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    AI: Ai;
    ENCRYPTION_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

- [ ] **Step 6: Update `tsconfig.server.json` for Workers types**

Replace the file with (keeps `node` for the not-yet-deleted `db/connection.ts`/`db/migrate.ts`/`serve.ts`; Task 8 removes `node`):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/server/**/*.ts", "tests/server/**/*.ts"]
}
```

- [ ] **Step 7: Update `package.json` scripts and dependency placement**

Set the `scripts` block to (removes `--experimental-sqlite`, `dev:server`, `dev:all`, `start`, `seed` — those are removed with `serve.ts` in Task 8; `dev` becomes `wrangler dev`; client dev keeps Vite):

```json
  "scripts": {
    "dev": "wrangler dev",
    "dev:client": "vite --host 0.0.0.0",
    "build": "tsc -b && vite build",
    "preview": "vite preview --host 0.0.0.0",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:client": "vitest run -c vitest.client.config.ts",
    "test:all": "npm test && npm run test:client",
    "typecheck": "tsc -b && tsc -p tsconfig.server.json && tsc -p tsconfig.test.json",
    "deploy:testing": "wrangler deploy --env testing",
    "deploy:production": "wrangler deploy --env production"
  },
```

Leave `dependencies`/`devDevpendencies` otherwise as-is for now; `@anthropic-ai/sdk`, `@hono/node-server`, and `tsx` are removed in Task 8 when their last consumers go.

- [ ] **Step 8: Write a minimal placeholder migration `migrations/0001_initial.sql`**

Task 2 replaces this with the full schema. For now, one table proves the pipeline:

```sql
CREATE TABLE household (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

- [ ] **Step 9: Write the minimal Worker `src/server/worker.ts`**

```ts
import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/healthz", (c) => c.text("ok"));

export default { fetch: app.fetch };
```

- [ ] **Step 10: Write the failing smoke test `tests/server/smoke.test.ts`**

Replace the existing file entirely:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/server/worker.js";

describe("worker smoke", () => {
  it("serves /healthz", async () => {
    const res = await worker.fetch(new Request("http://x/healthz"), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("has a migrated D1 with the household table", async () => {
    // Proves the harness applied migrations/0001_initial.sql to the local D1.
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='household'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("household");
  });
});
```

- [ ] **Step 11: Run the smoke test — expect PASS (green harness)**

Run:

```bash
nix develop -c npm test
```

Expected: 2 passed. If `cloudflare:test` cannot resolve, confirm `@cloudflare/vitest-pool-workers` installed and `vitest.config.ts` uses the `cloudflareTest` plugin. If migrations don't apply, confirm `migrations_dir = "migrations"` in `wrangler.toml` and the setup file path in `test.setupFiles`.

- [ ] **Step 12: Confirm Node 22 dev shell still works**

Run:

```bash
nix develop -c node --version
```

Expected: `v22.x` (the flake pins `nodejs_22`). This is a smoke check that the nix environment is intact; the Worker itself runs on workerd, not Node.

- [ ] **Step 13: Commit**

```bash
git add wrangler.toml vitest.config.ts tsconfig.server.json package.json package-lock.json migrations/ tests/server/env.d.ts tests/server/apply-migrations.ts tests/server/smoke.test.ts src/server/worker.ts
git commit -m "feat(cf): scaffold Worker + vitest-pool-workers harness with local D1 migrations"
```

---

### Task 2: D1 initial migration + cascade-delete test

Replaces the placeholder migration with the full core schema (the current `db/migrations/001_initial.sql` **minus** the `inbound_email` table — that lives in the deleted `002` and is deferred — and **minus** any `schema_migration` table, since Wrangler tracks applied migrations in `d1_migrations`). `ON DELETE CASCADE` is kept; there is no `PRAGMA foreign_keys` line — D1 enforces FKs by default.

**wrangler d1 migrations layout the pool expects:** the `migrations/` directory at the repo root (matching `migrations_dir` in `wrangler.toml`), files named `NNNN_description.sql` in ascending order (`0001_initial.sql`, then `0002_…` in later plans). `readD1Migrations` reads them in that order; `applyD1Migrations` records each in the `d1_migrations` table so re-application is a no-op.

**Files:**
- Replace: `migrations/0001_initial.sql`
- Create: `tests/server/db/schema.test.ts`
- Delete (superseded): none yet (`db/migrate.ts`'s node test `tests/server/db/migrate.test.ts` is deleted in Task 8 with the module)

**Interfaces:**
- Produces: a migrated local D1 with tables `household`, `user`, `household_member`, `person`, `loyalty_account`, `trip`, `trip_person`, `booking`, `booking_person`, `checklist_item`, all `household`-owned tables cascading on `household` delete.

- [ ] **Step 1: Write the failing schema test `tests/server/db/schema.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

// Each test starts from the migrated-but-empty database (isolated storage).
async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("0001_initial schema", () => {
  beforeEach(async () => {
    // Clean the rows a prior test may have left; the schema itself persists.
    await env.DB.exec("DELETE FROM household");
  });

  it("creates every core table and no inbound_email", async () => {
    expect(await tableNames()).toEqual([
      "booking",
      "booking_person",
      "checklist_item",
      "household",
      "household_member",
      "loyalty_account",
      "person",
      "trip",
      "trip_person",
      "user",
    ]);
  });

  it("cascades a household delete down to its trips and bookings", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind("hh-a", "A", now)
      .run();
    await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
      .bind("t1", "hh-a", "Mine", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO booking (id, household_id, trip_id, kind, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("b1", "hh-a", "t1", "other", "Hotel", now)
      .run();

    await env.DB.prepare("DELETE FROM household WHERE id = ?").bind("hh-a").run();

    const trip = await env.DB.prepare("SELECT id FROM trip WHERE id = ?").bind("t1").first();
    const booking = await env.DB.prepare("SELECT id FROM booking WHERE id = ?").bind("b1").first();
    expect(trip).toBeNull();
    expect(booking).toBeNull();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `nix develop -c npx vitest run tests/server/db/schema.test.ts`
Expected: FAIL — the placeholder migration has only `household`, so the table-list assertion fails and the cascade insert into `trip` errors (no such table).

- [ ] **Step 3: Replace `migrations/0001_initial.sql` with the full schema**

```sql
CREATE TABLE household (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE user (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  auth_subject  TEXT UNIQUE,
  created_at    TEXT NOT NULL
);

CREATE TABLE household_member (
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner','adult','viewer')),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE person (
  id                    TEXT PRIMARY KEY,
  household_id          TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  user_id               TEXT REFERENCES user(id) ON DELETE SET NULL,
  display_name          TEXT NOT NULL,
  dob                   TEXT,
  notes                 TEXT,
  passport_number       TEXT,   -- encrypted envelope
  passport_expiry       TEXT,
  passport_country      TEXT,
  known_traveler_number TEXT,   -- encrypted envelope
  redress_number        TEXT,   -- encrypted envelope
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_person_household ON person(household_id);

CREATE TABLE loyalty_account (
  id                  TEXT PRIMARY KEY,
  household_id        TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  person_id           TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  program             TEXT NOT NULL,
  account_number      TEXT,     -- encrypted envelope
  status_tier         TEXT,
  balance             INTEGER,
  balance_updated_at  TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_loyalty_household ON loyalty_account(household_id);

CREATE TABLE trip (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  destination   TEXT,
  starts_on     TEXT,
  ends_on       TEXT,
  status        TEXT NOT NULL DEFAULT 'planning'
                  CHECK (status IN ('planning','active','complete','cancelled')),
  notes         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_trip_household ON trip(household_id);

CREATE TABLE trip_person (
  trip_id    TEXT NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (trip_id, person_id)
);

CREATE TABLE booking (
  id                   TEXT PRIMARY KEY,
  household_id         TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  trip_id              TEXT NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  location             TEXT,
  starts_at            TEXT,
  starts_at_tz         TEXT,
  ends_at              TEXT,
  ends_at_tz           TEXT,
  confirmation_number  TEXT,
  cost_cents           INTEGER,
  points_used          INTEGER,
  points_program       TEXT,
  status               TEXT NOT NULL DEFAULT 'planned'
                         CHECK (status IN ('draft','planned','booked','cancelled')),
  details              TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_booking_household ON booking(household_id);
CREATE INDEX idx_booking_trip_starts ON booking(trip_id, starts_at);

CREATE TABLE booking_person (
  booking_id  TEXT NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (booking_id, person_id)
);
CREATE INDEX idx_booking_person_person ON booking_person(person_id);

CREATE TABLE checklist_item (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  trip_id       TEXT NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  person_id     TEXT REFERENCES person(id) ON DELETE SET NULL,
  label         TEXT NOT NULL,
  due_on        TEXT,
  done_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_checklist_household ON checklist_item(household_id);
```

- [ ] **Step 4: Run it green**

Run: `nix develop -c npm test`
Expected: the schema test's 2 cases pass, plus the Task 1 smoke test's 2 cases. (The migrated-DB pipeline now applies the full schema.)

- [ ] **Step 5: Commit**

```bash
git add migrations/0001_initial.sql tests/server/db/schema.test.ts
git commit -m "feat(cf): full D1 0001_initial migration + cascade-delete test"
```

---

### Task 3: WebCrypto envelope + `loadKeyring` from a secret

Rewrites `crypto/envelope.ts` on `crypto.subtle`. `Keyring.encrypt`/`decrypt` become **async**. The envelope format is redefined for WebCrypto — `v1.<key_id>.<iv_b64url>.<ctAndTag_b64url>` (four parts; AES-GCM returns the tag appended to the ciphertext, so there is no separate tag segment). The key is imported per-operation with `crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt','decrypt'])`; the constructor stays synchronous and holds raw 32-byte keys. `mask()` and `assertNotMasked()` are unchanged (sync). `loadKeyring` now parses a **secret string** (the same `<key_id> <base64-32-bytes>` line format), not a file — the last line is the active key.

**Async ripple:** `PersonRepo.seal`/`unsealAndMask` and `BookingRepo`'s confirmation path become async in Tasks 5–6. Nothing else consumes the envelope directly.

**Files:**
- Replace: `src/server/crypto/envelope.ts`
- Replace: `tests/server/crypto/envelope.test.ts`

**Interfaces:**
- Produces: `class Keyring { constructor(activeKeyId: string, keys: Record<string, Uint8Array>); encrypt(plaintext: string): Promise<string>; decrypt(envelope: string): Promise<string> }`
- Produces: `mask(plaintext: string | null): string | null` (sync); `assertNotMasked(field: string, value: string): void` (sync); `MASK_GLYPH: string`.
- Produces: `loadKeyring(contents: string): Keyring` — parses `<id> <base64>` lines from the secret value.

- [ ] **Step 1: Write the failing test `tests/server/crypto/envelope.test.ts`**

Replace the file entirely (13 `it` blocks):

```ts
import { describe, it, expect } from "vitest";
import { Keyring, loadKeyring, mask } from "../../../src/server/crypto/envelope.js";

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function keyToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const key = randomKey();
const ring = new Keyring("server-v1", { "server-v1": key });

describe("envelope", () => {
  it("round-trips a value", async () => {
    const env = await ring.encrypt("C03X72119");
    expect(await ring.decrypt(env)).toBe("C03X72119");
  });

  it("produces different ciphertext for the same plaintext", async () => {
    expect(await ring.encrypt("same")).not.toBe(await ring.encrypt("same"));
  });

  it("tags the envelope with the key id and format", async () => {
    const env = await ring.encrypt("x");
    expect(env.startsWith("v1.server-v1.")).toBe(true);
    // Four dot-separated parts: format, keyId, iv, ct+tag.
    expect(env.split(".")).toHaveLength(4);
  });

  it("can decrypt under an older key after rotation", async () => {
    const oldEnv = await ring.encrypt("legacy");
    const rotated = new Keyring("server-v2", {
      "server-v1": key,
      "server-v2": randomKey(),
    });
    expect(await rotated.decrypt(oldEnv)).toBe("legacy");
    expect((await rotated.encrypt("new")).startsWith("v1.server-v2.")).toBe(true);
  });

  it("rejects a tampered envelope", async () => {
    const env = await ring.encrypt("secret");
    const parts = env.split(".");
    // The ciphertext+tag is the 4th part now; corrupt it.
    parts[3] = "AAAAAAAAAAAAAAAAAAAAAA";
    await expect(ring.decrypt(parts.join("."))).rejects.toThrow();
  });

  it("throws on a malformed envelope", async () => {
    await expect(ring.decrypt("not-an-envelope")).rejects.toThrow(/malformed/i);
  });

  it("throws on an unknown key id", async () => {
    await expect(ring.decrypt("v1.nope.AAAA.BBBB")).rejects.toThrow(/unknown key/i);
  });

  it("masks to the last four characters for values longer than four characters", () => {
    expect(mask("C03X72119")).toBe("••••2119");
    expect(mask(null)).toBe(null);
  });

  describe("mask() on short values", () => {
    it("fully masks a value shorter than four characters", () => {
      expect(mask("ab")).toBe("••••••••");
    });
    it("fully masks a value of exactly four characters", () => {
      expect(mask("ABCD")).toBe("••••••••");
    });
    it("fully masks an empty string", () => {
      expect(mask("")).toBe("••••••••");
    });
    it("still reveals the trailing four characters of a longer value", () => {
      expect(mask("ABCDE")).toBe("••••BCDE");
    });
    it("never lets a short mask leak the plaintext it stands in for", () => {
      expect(mask("ab")).not.toContain("ab");
      expect(mask("ABCD")).not.toContain("ABCD");
    });
  });
});

describe("loadKeyring", () => {
  const k1 = keyToB64(randomKey());
  const k2 = keyToB64(randomKey());

  it("parses a single-key secret and uses it as the active key", async () => {
    const ring2 = loadKeyring(`server-v1 ${k1}\n`);
    const env = await ring2.encrypt("hello");
    expect(env.startsWith("v1.server-v1.")).toBe(true);
    expect(await ring2.decrypt(env)).toBe("hello");
  });

  it("treats the last listed line as the active key", async () => {
    const ring2 = loadKeyring(`server-v1 ${k1}\nserver-v2 ${k2}\n`);
    expect((await ring2.encrypt("x")).startsWith("v1.server-v2.")).toBe(true);
  });

  it("ignores blank lines and comments", async () => {
    const ring2 = loadKeyring(`# comment\n\n  \nserver-v1 ${k1}\n`);
    expect((await ring2.encrypt("x")).startsWith("v1.server-v1.")).toBe(true);
  });

  it("rejects a malformed key line", () => {
    expect(() => loadKeyring(`server-v1-with-no-key-value\n`)).toThrow(/malformed/i);
  });

  it("rejects a secret with no keys", () => {
    expect(() => loadKeyring(`\n  \n`)).toThrow(/no keys/i);
  });
});
```

That is 13 top-level `it`s under `envelope` (5 in the nested `mask()` block) + 5 under `loadKeyring` = 18 `it` blocks. Adjust the count only if you change the tests.

- [ ] **Step 2: Run it red**

Run: `nix develop -c npx vitest run tests/server/crypto/envelope.test.ts`
Expected: FAIL — the current `Keyring.encrypt` is sync and returns a 5-part envelope; `await ring.encrypt(...)` awaiting a string still "works" for round-trip but the 4-part assertion and the async `.rejects` cases fail, and `loadKeyring` still expects a file path.

- [ ] **Step 3: Rewrite `src/server/crypto/envelope.ts`**

```ts
const FORMAT = "v1";
const IV_BYTES = 12;

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Keyring {
  constructor(
    private readonly activeKeyId: string,
    private readonly keys: Record<string, Uint8Array>,
  ) {
    if (!keys[activeKeyId]) {
      throw new Error(`Active key "${activeKeyId}" is not present in the keyring`);
    }
    for (const [id, key] of Object.entries(keys)) {
      if (key.length !== 32) {
        throw new Error(`Key "${id}" must be 32 bytes, got ${key.length}`);
      }
    }
  }

  private importKey(id: string): Promise<CryptoKey> {
    // Imported per operation. Workers have no node:crypto; a raw AES-GCM key is
    // non-extractable and used only for encrypt/decrypt.
    return crypto.subtle.importKey("raw", this.keys[id]!, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = await this.importKey(this.activeKeyId);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    // WebCrypto AES-GCM returns ciphertext WITH the auth tag appended.
    const ctAndTag = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
    );
    return [FORMAT, this.activeKeyId, bytesToB64url(iv), bytesToB64url(ctAndTag)].join(".");
  }

  async decrypt(envelope: string): Promise<string> {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== FORMAT) {
      throw new Error("Malformed encryption envelope");
    }
    const [, keyId, ivB64, ctB64] = parts as [string, string, string, string];
    if (!this.keys[keyId]) {
      throw new Error(`Cannot decrypt: unknown key id "${keyId}"`);
    }
    const key = await this.importKey(keyId);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlToBytes(ivB64) },
      key,
      b64urlToBytes(ctB64),
    );
    return new TextDecoder().decode(plaintext);
  }
}

/**
 * A fixed-width stand-in for a value too short to safely mask by trailing
 * characters. Carries no plaintext at all.
 */
const FULLY_MASKED = "••••••••";

/**
 * Mask a plaintext value for display. Never pass an envelope to this.
 * Values of 4 characters or fewer are masked in full.
 */
export function mask(plaintext: string | null): string | null {
  if (plaintext === null) return null;
  if (plaintext.length <= 4) return FULLY_MASKED;
  return `••••${plaintext.slice(-4)}`;
}

/** The character mask() composes its output from: U+2022 BULLET. */
export const MASK_GLYPH = "•";

/**
 * Refuses a value that is plainly a masked display string being handed back as
 * if it were plaintext. Throws a plain Error; the repository layer turns it
 * into a ValidationError (400), because crypto/ sits below the repo layer.
 */
export function assertNotMasked(field: string, value: string): void {
  if (value.includes(MASK_GLYPH)) {
    throw new Error(
      `${field} looks like a masked placeholder rather than a real value. ` +
        `Omit the field to leave it unchanged, or send null to clear it.`,
    );
  }
}

/**
 * Load the keyring from a secret string (a Workers secret value, not a file).
 * Contains base64 keys, one per line, as `<key_id> <base64-32-bytes>`. The
 * last non-comment line is the active key.
 */
export function loadKeyring(contents: string): Keyring {
  const lines = contents
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) {
    throw new Error("Encryption key secret contains no keys");
  }

  const keys: Record<string, Uint8Array> = {};
  let activeKeyId = "";
  for (const line of lines) {
    const [id, b64] = line.split(/\s+/);
    if (!id || !b64) throw new Error("Malformed key line in encryption key secret");
    keys[id] = b64ToBytes(b64);
    activeKeyId = id;
  }
  return new Keyring(activeKeyId, keys);
}
```

- [ ] **Step 4: Run it green**

Run: `nix develop -c npx vitest run tests/server/crypto/envelope.test.ts`
Expected: 18 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/crypto/envelope.ts tests/server/crypto/envelope.test.ts
git commit -m "feat(cf): WebCrypto AES-GCM envelope, async encrypt/decrypt, keyring from secret"
```

---

### Task 4: The async `TenantRepo` — re-solved tenancy binding (SECURITY-CRITICAL)

Rewrites `repos/base.ts` for D1's async, positional-only API. **This is the single largest risk in the port.** The old code bound its tenancy predicate as a NAMED parameter (`:__scope_household`) — a fix an adversarial review forced after the original `?`-counting proved exploitable. **Named params do not exist on D1.** The re-solution:

- `{scope}` expands to `household_id = ?1`. The base **reserves index `?1`** for the household id.
- Repository queries write their own parameters starting at **`?2`, `?3`, …** (explicit indices), **never `?1`**.
- Binding is always `stmt.bind(ctx.householdId, ...callerParams)` — household id first, then the caller's params in order. So caller param *k* (1-based) binds to `?${k+1}`.
- **Why it is safe where `?`-counting was not:** nothing counts anonymous `?` to find a splice position; the household id owns a fixed explicit index (`?1`) the caller never writes, so a `?` in a comment or string literal cannot shift it.

**All existing shape guards port unchanged:** a query must contain exactly one `{scope}` token (outside comments/strings) or it throws; reject `OR` at or above the token's nesting depth, `UNION`/`EXCEPT`/`INTERSECT` at or above it, or the token hidden inside a comment or string literal. The comment/string-aware `scanSql` scanner ports directly.

**Two NEW guards** (added and tested this task): reject any query where a caller writes `?1` (reserved); reject any query where `?1` appears outside the `{scope}` expansion. Both manifest as a literal `?1` in the caller's SQL text (the expansion is injected *after* scanning, so the scanner never sees the legitimate `?1`) — so one scanner addition covers both: `scanSql` records every `?NNN`/`?` placeholder with its numeric index, and `scopeQuery` throws if any placeholder in the caller's text has index exactly `1` (`?10`, `?11`, … are allowed).

**Roles:** only `owner | adult | viewer`. `requireWrite()` denies viewer; `requireReveal()` denies viewer. **No `machine` role, no `requireIngestWrite`, no `insert()` guard parameter** — deferred with ingest. Error taxonomy unchanged: `RepoError` base, `TenantScopeError` (500, message carries no SQL), `ForbiddenError` (403), `NotFoundError` (404), `ValidationError` (400).

**Files:**
- Replace: `src/server/repos/base.ts`
- Replace: `tests/server/repos/base.test.ts`
- Replace: `tests/server/repos/base-adversarial.test.ts`

**Interfaces:**
- Produces: `type Role = "owner" | "adult" | "viewer"`; `type HouseholdContext = { householdId: string; userId: string; role: Role }`.
- Produces: `abstract class RepoError extends Error`; `class TenantScopeError`, `ForbiddenError`, `NotFoundError`, `ValidationError` extends `RepoError`.
- Produces: `abstract class TenantRepo` with protected async `all<T>(sql, ...params): Promise<T[]>`, `get<T>(sql, ...params): Promise<T | undefined>`, `run(sql, ...params): Promise<void>`, `insert(table, values): Promise<void>`, `unscoped<T>(reason, sql, ...params): Promise<T[]>`, `unscopedRun(reason, sql, ...params): Promise<void>`, and `requireWrite()`/`requireReveal()` (sync). Constructor: `constructor(db: D1Database, ctx: HouseholdContext)`.

- [ ] **Step 1: Write the failing base test `tests/server/repos/base.test.ts`**

Replace the file entirely. The `Probe` methods are async and take a `D1Database`; seeding uses `env.DB`. 22 `it` blocks.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TenantRepo, TenantScopeError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

class TripProbe extends TenantRepo {
  listTitles(): Promise<{ title: string }[]> {
    return this.all<{ title: string }>("SELECT title FROM trip WHERE {scope}");
  }
  listUnscoped(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip");
  }
  rename(id: string, title: string): Promise<void> {
    // Caller params: title -> ?2, id -> ?3 (household id is ?1).
    return this.run("UPDATE trip SET title = ?2 WHERE {scope} AND id = ?3", title, id);
  }
  scopeOrTautology(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip WHERE {scope} OR 1=1");
  }
  scopeTokenInComment(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip -- {scope}\nWHERE 1=1");
  }
  scopeTokenInString(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip WHERE title != '{scope}'");
  }
  legitimateNestedOr(): Promise<{ title: string }[]> {
    return this.all<{ title: string }>(
      "SELECT title FROM trip WHERE {scope} AND (title = 'Guerneville' OR title = 'nope')",
    );
  }
  writeViaRunWithoutRequireWrite(id: string, title: string): Promise<void> {
    return this.run("UPDATE trip SET title = ?2 WHERE {scope} AND id = ?3", title, id);
  }
  insertViaInsertWithoutRequireWrite(id: string, title: string): Promise<void> {
    return this.insert("trip", { id, title, created_at: new Date().toISOString() });
  }
  insertBadTable(): Promise<void> {
    return this.insert("trip; DROP TABLE trip;--", { id: "bad", title: "x" });
  }
  insertBadColumn(): Promise<void> {
    return this.insert("trip", { "id; DROP TABLE trip;--": "bad" });
  }
  callRequireWrite(): void {
    this.requireWrite();
  }
  callRequireReveal(): void {
    this.requireReveal();
  }
  // Caller writes the RESERVED ?1 (new guard).
  callerWritesReservedIndex(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip WHERE {scope} AND id = ?1");
  }
  // ?1 appears outside the {scope} expansion, in a select position (new guard).
  reservedIndexOutsideScope(): Promise<unknown[]> {
    return this.all("SELECT ?1 AS x FROM trip WHERE {scope}");
  }
  attachTraveler(tripId: string, personId: string): Promise<void> {
    return this.unscopedRun(
      "trip_person carries no household_id; ids proven scoped by the caller",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      tripId,
      personId,
    );
  }
  travelerIds(tripId: string): Promise<{ person_id: string }[]> {
    return this.unscoped<{ person_id: string }>(
      "trip_person carries no household_id; tripId proven scoped by the caller",
      "SELECT person_id FROM trip_person WHERE trip_id = ? ORDER BY person_id",
      tripId,
    );
  }
  unscopedWithoutReason(tripId: string): Promise<unknown[]> {
    return this.unscoped("", "SELECT person_id FROM trip_person WHERE trip_id = ?", tripId);
  }
  unscopedRunWithoutReason(tripId: string, personId: string): Promise<void> {
    return this.unscopedRun(
      "   ",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      tripId,
      personId,
    );
  }
}

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

async function title(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT title FROM trip WHERE id = ?").bind(id).first<{ title: string }>();
  return row?.title;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind(id, id, now).run();
  }
  await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .bind("t1", "hh-a", "Guerneville", now).run();
  await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .bind("t2", "hh-b", "Someone Else's Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
    .bind("p-ava", "hh-a", "Ava", now).run();
});

describe("TenantRepo", () => {
  it("returns only the current household's rows", async () => {
    expect((await new TripProbe(env.DB, ctxA).listTitles()).map((r) => r.title)).toEqual(["Guerneville"]);
  });

  it("isolates a different household", async () => {
    expect((await new TripProbe(env.DB, ctxB).listTitles()).map((r) => r.title)).toEqual(["Someone Else's Trip"]);
  });

  it("refuses a query with no {scope} placeholder", async () => {
    await expect(new TripProbe(env.DB, ctxA).listUnscoped()).rejects.toThrow(TenantScopeError);
  });

  it("rejects an empty household id at construction", () => {
    expect(() => new TripProbe(env.DB, { ...ctxA, householdId: "" })).toThrow(TenantScopeError);
  });

  it("binds correctly with the household id at ?1 and caller params at ?2+", async () => {
    await new TripProbe(env.DB, ctxA).rename("t1", "Renamed");
    expect(await title("t1")).toBe("Renamed");
  });

  it("does not update another household's row", async () => {
    await new TripProbe(env.DB, ctxA).rename("t2", "Hijacked");
    expect(await title("t2")).toBe("Someone Else's Trip");
  });

  it("throws when OR sits at the same nesting level as the scope token", async () => {
    await expect(new TripProbe(env.DB, ctxA).scopeOrTautology()).rejects.toThrow(TenantScopeError);
  });

  it("throws when the scope token is hidden inside a comment", async () => {
    await expect(new TripProbe(env.DB, ctxA).scopeTokenInComment()).rejects.toThrow(TenantScopeError);
  });

  it("throws when the scope token is hidden inside a string literal", async () => {
    await expect(new TripProbe(env.DB, ctxA).scopeTokenInString()).rejects.toThrow(TenantScopeError);
  });

  it("still allows an OR nested strictly deeper than the scope token", async () => {
    expect((await new TripProbe(env.DB, ctxA).legitimateNestedOr()).map((r) => r.title)).toEqual(["Guerneville"]);
  });

  it("a viewer cannot write through run() even if the subclass never calls requireWrite()", async () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.writeViaRunWithoutRequireWrite("t1", "Hijacked")).rejects.toThrow(ForbiddenError);
    expect(await title("t1")).toBe("Guerneville");
  });

  it("a viewer cannot write through insert() even if the subclass never calls requireWrite()", async () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.insertViaInsertWithoutRequireWrite("t-new", "Sneaky")).rejects.toThrow(ForbiddenError);
    expect(await title("t-new")).toBeUndefined();
  });

  // NEW GUARD 1: a caller must not write the reserved ?1.
  it("rejects a query where the caller writes the reserved ?1", async () => {
    await expect(new TripProbe(env.DB, ctxA).callerWritesReservedIndex()).rejects.toThrow(TenantScopeError);
  });

  // NEW GUARD 2: ?1 must never appear outside the {scope} expansion.
  it("rejects a query where ?1 appears outside the {scope} expansion", async () => {
    await expect(new TripProbe(env.DB, ctxA).reservedIndexOutsideScope()).rejects.toThrow(TenantScopeError);
  });

  it("requireWrite() denial throws ForbiddenError, not TenantScopeError", async () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    let caught: unknown;
    try {
      await viewer.rename("t1", "Nope");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(caught).not.toBeInstanceOf(TenantScopeError);
  });

  it("requireReveal() denies a viewer", () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    expect(() => viewer.callRequireReveal()).toThrow(ForbiddenError);
  });

  it("unscoped()/unscopedRun() support the join-table shapes", async () => {
    const repo = new TripProbe(env.DB, ctxA);
    await repo.attachTraveler("t1", "p-ava");
    expect((await repo.travelerIds("t1")).map((r) => r.person_id)).toEqual(["p-ava"]);
  });

  it("unscoped() requires a non-empty reason", async () => {
    await expect(new TripProbe(env.DB, ctxA).unscopedWithoutReason("t1")).rejects.toThrow(TenantScopeError);
  });

  it("unscopedRun() requires a non-empty reason", async () => {
    await expect(new TripProbe(env.DB, ctxA).unscopedRunWithoutReason("t1", "p-ava")).rejects.toThrow(TenantScopeError);
  });

  it("rejects an invalid table name passed to insert()", async () => {
    await expect(new TripProbe(env.DB, ctxA).insertBadTable()).rejects.toThrow(TenantScopeError);
  });

  it("rejects an invalid column name passed to insert()", async () => {
    await expect(new TripProbe(env.DB, ctxA).insertBadColumn()).rejects.toThrow(TenantScopeError);
  });

  it("rejects a whitespace-only household id at construction", () => {
    expect(() => new TripProbe(env.DB, { ...ctxA, householdId: "   " })).toThrow(TenantScopeError);
  });

  it("rejects a role outside the three permitted values", () => {
    expect(
      () => new TripProbe(env.DB, { ...ctxA, role: "machine" as unknown as HouseholdContext["role"] }),
    ).toThrow(TenantScopeError);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `nix develop -c npx vitest run tests/server/repos/base.test.ts`
Expected: FAIL — the current `base.ts` imports `node:sqlite`, has a sync API and a `machine` role, and does not implement the `?1` guards.

- [ ] **Step 3: Rewrite `src/server/repos/base.ts`**

```ts
export type Role = "owner" | "adult" | "viewer";

export type HouseholdContext = {
  householdId: string;
  userId: string;
  role: Role;
};

const ROLES: readonly Role[] = ["owner", "adult", "viewer"];

/** Shared base for every error the repository layer throws. */
export abstract class RepoError extends Error {}

/**
 * A bug in how a repository (not a caller/request) was written: a query
 * missing its {scope} token, a token hidden in a comment/string, a query
 * shaped so the tenancy predicate can be neutralized, a caller writing the
 * reserved ?1, or an invalid identifier passed to insert(). Map to 500. The
 * .message never contains SQL or column/table names.
 */
export class TenantScopeError extends RepoError {}

/** The caller's role does not permit the attempted operation. Map to 403. */
export class ForbiddenError extends RepoError {}

/** The requested row does not exist in this household (or anywhere). Map to 404. */
export class NotFoundError extends RepoError {}

/** The request itself is malformed in a way only the repo layer can catch. Map to 400. */
export class ValidationError extends RepoError {}

function logScopeBug(reason: string, detail: string): void {
  // Never silent outside production so tests/dev/CI see the offending SQL.
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.NODE_ENV;
  if (nodeEnv !== "production") {
    console.error(`[TenantScopeError] ${reason}\n${detail}`);
  }
}

function scopeBug(reason: string, detail: string): never {
  logScopeBug(reason, detail);
  throw new TenantScopeError(reason);
}

const SCOPE_TOKEN = "{scope}";
// {scope} expands to household_id = ?1. ?1 is RESERVED for the household id,
// bound first by every all()/get()/run() below. Callers write ?2, ?3, ...
const SCOPE_SQL = "household_id = ?1";

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
const WRITE_KEYWORD_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

type Hit = { index: number; depth: number };
type ParamHit = { index: number; number: number };

/**
 * Single left-to-right scan of the raw SQL that skips comments and string
 * literals, tracks paren depth, and records:
 *  - every literal {scope} token (with depth),
 *  - every bare OR / UNION / EXCEPT / INTERSECT keyword (with depth),
 *  - every positional placeholder (?, ?NNN) OUTSIDE comments/strings, with its
 *    numeric index (0 for an anonymous ?), and
 *  - `stripped`: the SQL with comments removed (string literals kept), for the
 *    write-keyword check.
 */
function scanSql(sql: string): {
  scopeHits: Hit[];
  orHits: Hit[];
  setHits: Hit[];
  paramHits: ParamHit[];
  stripped: string;
} {
  const scopeHits: Hit[] = [];
  const orHits: Hit[] = [];
  const setHits: Hit[] = [];
  const paramHits: ParamHit[] = [];
  let stripped = "";
  let depth = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      stripped += sql.slice(start, i);
      continue;
    }
    if (c === "(") {
      depth++;
      stripped += c;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      stripped += c;
      i++;
      continue;
    }
    if (c === "?") {
      // A positional placeholder. Read any following digits to get its index.
      let j = i + 1;
      while (j < n && sql[j]! >= "0" && sql[j]! <= "9") j++;
      const digits = sql.slice(i + 1, j);
      paramHits.push({ index: i, number: digits.length > 0 ? Number(digits) : 0 });
      stripped += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql.startsWith(SCOPE_TOKEN, i)) {
      scopeHits.push({ index: i, depth });
      stripped += SCOPE_TOKEN;
      i += SCOPE_TOKEN.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c!)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      const word = match[0].toUpperCase();
      if (word === "OR") orHits.push({ index: i, depth });
      else if (word === "UNION" || word === "EXCEPT" || word === "INTERSECT") {
        setHits.push({ index: i, depth });
      }
      stripped += match[0];
      i += match[0].length;
      continue;
    }
    stripped += c;
    i++;
  }

  return { scopeHits, orHits, setHits, paramHits, stripped };
}

/**
 * Base class for all domain repositories.
 *
 * Queries MUST contain the literal {scope} token exactly once, outside any
 * comment or string literal. It expands to `household_id = ?1`. The household
 * id is RESERVED at index ?1 and bound as the FIRST value by all()/get()/run();
 * caller params start at ?2. Nothing counts anonymous ? to find a splice
 * position, so a ? in a comment or string literal cannot shift the household
 * id: it owns a fixed explicit index the caller never writes.
 *
 * A query without the token throws rather than running. So does a query shaped
 * so the predicate can be neutralized (a bare OR, or a UNION/EXCEPT/INTERSECT,
 * at or above the token's nesting depth), one where the token is hidden in a
 * comment or string literal, and one where the caller writes ?1 anywhere
 * (reserved) or ?1 appears outside the {scope} expansion.
 *
 * Bypassing all of the above requires unscoped()/unscopedRun(), which take a
 * human-readable reason so every bypass is greppable.
 */
export abstract class TenantRepo {
  private readonly db: D1Database;
  protected readonly ctx: HouseholdContext;

  constructor(db: D1Database, ctx: HouseholdContext) {
    if (typeof ctx.householdId !== "string" || ctx.householdId.trim() === "") {
      throw new TenantScopeError("HouseholdContext.householdId must be a non-empty string");
    }
    if (typeof ctx.userId !== "string" || ctx.userId.trim() === "") {
      throw new TenantScopeError("HouseholdContext.userId must be a non-empty string");
    }
    if (!ROLES.includes(ctx.role)) {
      throw new TenantScopeError(`HouseholdContext.role must be one of ${ROLES.join(", ")}`);
    }
    this.db = db;
    this.ctx = ctx;
  }

  /**
   * Validates the scope token's shape and rewrites {scope} to `household_id =
   * ?1`. Throws (never returns a partially-scoped string) if the token is
   * missing, duplicated, hidden in a comment/string, the query is shaped so the
   * predicate could be neutralized, or the caller writes the reserved ?1.
   */
  private scopeQuery(sql: string): string {
    const { scopeHits, orHits, setHits, paramHits } = scanSql(sql);

    if (scopeHits.length !== 1) {
      scopeBug(
        `Query must contain exactly one ${SCOPE_TOKEN} token outside comments and string literals`,
        `found ${scopeHits.length} valid occurrence(s):\n${sql}`,
      );
    }

    const { depth: scopeDepth } = scopeHits[0]!;

    if (orHits.some((h) => h.depth <= scopeDepth)) {
      scopeBug(
        "Query has an OR at or above the scope token's nesting level; it can neutralize the tenancy predicate",
        sql,
      );
    }
    if (setHits.some((h) => h.depth <= scopeDepth)) {
      scopeBug(
        "Query has a UNION/EXCEPT/INTERSECT at or above the scope token's nesting level; it can bypass the tenancy predicate",
        sql,
      );
    }
    // NEW GUARDS: ?1 is reserved for the household id, injected only by the
    // expansion below (after this scan). Any ?1 the scanner sees is the
    // caller's, and is illegal whether written as a value placeholder or in a
    // select position -- both cases are exactly "index === 1 in caller SQL".
    if (paramHits.some((p) => p.number === 1)) {
      scopeBug(
        "Query writes the reserved ?1 parameter; the household id owns ?1, caller params start at ?2",
        sql,
      );
    }

    const { index } = scopeHits[0]!;
    return sql.slice(0, index) + SCOPE_SQL + sql.slice(index + SCOPE_TOKEN.length);
  }

  protected async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const scoped = this.scopeQuery(sql);
    const { results } = await this.db
      .prepare(scoped)
      .bind(this.ctx.householdId, ...params)
      .all<T>();
    return results;
  }

  protected async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const scoped = this.scopeQuery(sql);
    const row = await this.db
      .prepare(scoped)
      .bind(this.ctx.householdId, ...params)
      .first<T>();
    return row ?? undefined;
  }

  protected async run(sql: string, ...params: unknown[]): Promise<void> {
    if (isWriteQuery(sql)) this.requireWrite();
    const scoped = this.scopeQuery(sql);
    await this.db
      .prepare(scoped)
      .bind(this.ctx.householdId, ...params)
      .run();
  }

  /**
   * Inserts are the one case with no WHERE clause to scope. The household id is
   * supplied by the context, not the caller, so a caller cannot insert into
   * another tenant even if they try. Placeholders here are anonymous ? bound in
   * column order -- there is no {scope} expansion and no ?1 reservation.
   */
  protected async insert(table: string, values: Record<string, unknown>): Promise<void> {
    this.requireWrite();
    if (!IDENTIFIER_RE.test(table)) {
      scopeBug("insert(): invalid table identifier", `table=${table}`);
    }
    const withScope: Record<string, unknown> = { ...values, household_id: this.ctx.householdId };
    const cols = Object.keys(withScope);
    for (const col of cols) {
      if (!IDENTIFIER_RE.test(col)) {
        scopeBug("insert(): invalid column identifier", `table=${table} column=${col}`);
      }
    }
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
      .map(() => "?")
      .join(", ")})`;
    await this.db
      .prepare(sql)
      .bind(...cols.map((c) => withScope[c] as never))
      .run();
  }

  /** Denies viewer (may read but not modify). */
  protected requireWrite(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not modify data");
    }
  }

  private requireReason(reason: string): void {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new TenantScopeError("unscoped access requires a non-empty, human-readable reason");
    }
  }

  /**
   * Escape hatch for SQL against tables that carry no household_id of their own
   * (pure join tables). Bypasses every guarantee above: no {scope}, no OR/UNION
   * guard, no identifier validation, no ?1 reservation. Every call site must
   * supply a reason so a bypass is greppable and self-documenting. Read-only.
   */
  protected async unscoped<T>(reason: string, sql: string, ...params: unknown[]): Promise<T[]> {
    this.requireReason(reason);
    const { results } = await this.db.prepare(sql).bind(...(params as never[])).all<T>();
    return results;
  }

  /** The mutation counterpart of unscoped(). Same rules apply. */
  protected async unscopedRun(reason: string, sql: string, ...params: unknown[]): Promise<void> {
    this.requireReason(reason);
    if (isWriteQuery(sql)) this.requireWrite();
    await this.db.prepare(sql).bind(...(params as never[])).run();
  }

  /**
   * Guards reads of encrypted/sensitive fields the same way requireWrite()
   * guards mutations. A viewer may see masked output but must not unmask it.
   */
  protected requireReveal(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not reveal encrypted fields");
    }
  }
}

/**
 * True if sql, with comments stripped, begins (after whitespace) with a write
 * keyword. Stripping comments first closes the gap where a leading comment hid
 * the real keyword from a naive regex anchored at ^.
 */
function isWriteQuery(sql: string): boolean {
  return WRITE_KEYWORD_RE.test(scanSql(sql).stripped);
}
```

- [ ] **Step 4: Run the base test green**

Run: `nix develop -c npx vitest run tests/server/repos/base.test.ts`
Expected: 22 passed.

- [ ] **Step 5: Write the ported adversarial suite `tests/server/repos/base-adversarial.test.ts`**

Replace the file entirely. The 16 original attacks rewritten async against local D1, plus the two new `?1` guard attacks (A17, A18). Caller placeholders use explicit `?2`. 18 `it` blocks.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TenantRepo } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

class Probe extends TenantRepo {
  raw<T>(sql: string, ...p: unknown[]): Promise<T[]> { return this.all<T>(sql, ...p); }
  rawRun(sql: string, ...p: unknown[]): Promise<void> { return this.run(sql, ...p); }
  ins(t: string, v: Record<string, unknown>): Promise<void> { return this.insert(t, v); }
}
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let r: Probe;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind(id, id, now).run();
  }
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Mine", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t2", "hh-b", "SECRET", now).run();
  r = new Probe(env.DB, ctxA);
});

async function titleOf(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT title FROM trip WHERE id=?").bind(id).first<{ title: string }>();
  return row?.title;
}
const leaks = (rows: { title: string }[]) => rows.some((x) => x.title === "SECRET");

describe("independent attack suite", () => {
  it("A1 OR 1=1 after token", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE {scope} OR 1=1")).rejects.toThrow();
  });
  it("A2 OR before token", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE 1=1 OR {scope}")).rejects.toThrow();
  });
  it("A3 UNION after token", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE {scope} UNION SELECT title FROM trip")).rejects.toThrow();
  });
  it("A4 subquery + OR 1=1", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE id IN (SELECT id FROM trip WHERE {scope}) OR 1=1")).rejects.toThrow();
  });
  it("A5 HAVING OR", async () => {
    await expect(r.raw("SELECT title FROM trip GROUP BY title HAVING {scope} OR 1=1")).rejects.toThrow();
  });
  it("A6 token in comment", async () => {
    await expect(r.raw("SELECT title FROM trip -- {scope}\n")).rejects.toThrow();
  });
  it("A7 token in string literal", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE title = '{scope}'")).rejects.toThrow();
  });
  it("A8 ? in comment must not misbind", async () => {
    const rows = await r.raw<{ title: string }>("SELECT title FROM trip /* deleted? */ WHERE {scope} AND id = ?2", "t1");
    expect(leaks(rows)).toBe(false);
    expect(rows.map((x) => x.title)).toEqual(["Mine"]);
  });
  it("A9 ? in string literal must not misbind", async () => {
    const rows = await r.raw<{ title: string }>("SELECT title FROM trip WHERE {scope} AND title NOT LIKE '%?%' AND id = ?2", "t1");
    expect(leaks(rows)).toBe(false);
  });
  it("A10 cross-tenant UPDATE writes nothing", async () => {
    await r.rawRun("UPDATE trip SET title = ?2 WHERE {scope} AND id = ?3", "Hijacked", "t2");
    expect(await titleOf("t2")).toBe("SECRET");
  });
  it("A11 viewer cannot run() a write", async () => {
    const v = new Probe(env.DB, { ...ctxA, role: "viewer" });
    await expect(v.rawRun("UPDATE trip SET title=?2 WHERE {scope} AND id=?3", "x", "t1")).rejects.toThrow();
  });
  it("A12 viewer cannot insert()", async () => {
    const v = new Probe(env.DB, { ...ctxA, role: "viewer" });
    await expect(v.ins("trip", { id: "z", title: "z", created_at: "now" })).rejects.toThrow();
  });
  it("A13 error message leaks no schema", async () => {
    try {
      await r.raw("SELECT passport_number FROM person");
      throw new Error("should have thrown");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).not.toContain("passport_number");
      expect(m).not.toContain("person");
    }
  });
  it("A14 insert cannot smuggle household_id", async () => {
    await r.ins("trip", { id: "z", household_id: "hh-b", title: "z", created_at: "now" });
    const row = await env.DB.prepare("SELECT household_id FROM trip WHERE id='z'").first<{ household_id: string }>();
    expect(row?.household_id).toBe("hh-a");
  });
  it("A15 whitespace household id rejected", () => {
    expect(() => new Probe(env.DB, { ...ctxA, householdId: "   " })).toThrow();
  });
  it("A16 legit nested OR in subquery still allowed", async () => {
    const rows = await r.raw<{ title: string }>("SELECT title FROM trip WHERE {scope} AND id IN (SELECT id FROM trip WHERE title='Mine' OR title='Other')");
    expect(rows.map((x) => x.title)).toEqual(["Mine"]);
  });
  // NEW GUARD 1: a caller writing the reserved ?1 in a value position.
  it("A17 caller writing reserved ?1 is rejected", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE {scope} AND id = ?1")).rejects.toThrow();
    // And the row it targeted is untouched / not leaked.
    expect(await titleOf("t2")).toBe("SECRET");
  });
  // NEW GUARD 2: ?1 outside the {scope} expansion, in a select position.
  it("A18 ?1 outside the {scope} expansion is rejected", async () => {
    await expect(r.raw("SELECT ?1 AS x FROM trip WHERE {scope}")).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run the adversarial suite green**

Run: `nix develop -c npx vitest run tests/server/repos/base-adversarial.test.ts`
Expected: 18 passed.

- [ ] **Step 7: Run the whole server suite**

Run: `nix develop -c npm test`
Expected: green (smoke 2, schema 2, envelope 18, base 22, base-adversarial 18).

- [ ] **Step 8: Commit**

```bash
git add src/server/repos/base.ts tests/server/repos/base.test.ts tests/server/repos/base-adversarial.test.ts
git commit -m "feat(cf): async TenantRepo on D1, {scope}=?1 reserved, +2 new guards, ported adversarial suite"
```

> ## CONTROLLER GATE
>
> **An independent adversarial review of the re-solved tenancy binding is REQUIRED before any repository is built on it** — a fresh reviewer trying to make it leak across households, exactly as the original earned. The reviewer targets `src/server/repos/base.ts`: attempt cross-household reads/writes, attempt to shift the reserved `?1` with placeholders in comments/strings, attempt to smuggle `?1`, attempt to neutralize the predicate with `OR`/`UNION`/set operations at or above the scope depth, and attempt to slip a write past `requireWrite()`. **Do not proceed to Tasks 5–8 (the repositories and routes) until it clears.**

---

### Task 5: PersonRepo + TripRepo (async, D1, async crypto)

Ports `repos/person.ts` and `repos/trip.ts`. Every method becomes `async` and `await`s D1 and the async crypto. Person's `seal`/`unsealAndMask`/`toPerson` become async; `create`/`update`/`list`/`findById`/`revealDocument` become async. Scoped queries use explicit `?2`, `?3` placeholders. The `update` dynamic builder numbers its `SET` clauses from `?2` in the order they are bound.

**Files:**
- Replace: `src/server/repos/person.ts`
- Replace: `src/server/repos/trip.ts`
- Replace: `tests/server/repos/person.test.ts`
- Delete (superseded, folded into person.test.ts): `tests/server/repos/person-update.test.ts`
- Replace: `tests/server/repos/trip.test.ts`

**Interfaces:**
- Consumes: `TenantRepo` (Task 4), `Keyring` (Task 3), `newId` (`../ids.js`), `mask`/`assertNotMasked`.
- Produces `PersonRepo(db: D1Database, ctx: HouseholdContext, ring: Keyring)`: `create(input): Promise<Person>`, `update(id, input): Promise<Person>`, `list(): Promise<Person[]>`, `findById(id): Promise<Person | undefined>`, `revealDocument(personId, field): Promise<string | null>`. Exports `DOCUMENT_FIELDS`, types `Person`, `DocumentField`, `CreatePersonInput`, `UpdatePersonInput`.
- Produces `TripRepo(db, ctx)`: `create(input): Promise<Trip>`, `list(): Promise<Trip[]>`, `findById(id): Promise<Trip | undefined>`, `addTraveler(tripId, personId): Promise<void>`, `travelers(tripId): Promise<string[]>`. Exports `Trip`, `TripStatus`, `CreateTripInput`.

- [ ] **Step 1: Write the failing `tests/server/repos/person.test.ts`**

Replace the file entirely (async, D1, WebCrypto ring). 10 `it` blocks.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { PersonRepo } from "../../../src/server/repos/person.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError, ValidationError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind(id, id, now).run();
  }
});

describe("PersonRepo", () => {
  it("creates a person and masks the passport in list output", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    await repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.passportNumberMasked).toBe("••••2119");
    expect(JSON.stringify(list)).not.toContain("C03X72119");
  });

  it("isolates people by household", async () => {
    await new PersonRepo(env.DB, ctxA, ring).create({ displayName: "Ava" });
    await new PersonRepo(env.DB, ctxB, ring).create({ displayName: "Bo" });
    expect((await new PersonRepo(env.DB, ctxA, ring).list()).map((p) => p.displayName)).toEqual(["Ava"]);
  });

  it("reveals a document only through revealDocument", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    expect(await repo.revealDocument(person.id, "passport_number")).toBe("C03X72119");
  });

  it("a viewer cannot reveal a document", async () => {
    const owner = new PersonRepo(env.DB, ctxA, ring);
    const person = await owner.create({ displayName: "Ava", passportNumber: "C03X72119" });
    const viewer = new PersonRepo(env.DB, { ...ctxA, role: "viewer" }, ring);
    await expect(viewer.revealDocument(person.id, "passport_number")).rejects.toThrow(ForbiddenError);
  });

  it("revealDocument 404s for a person outside the household", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    await expect(repo.revealDocument("nope", "passport_number")).rejects.toThrow(NotFoundError);
  });

  it("revealDocument returns null when the field is unset", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava" });
    expect(await repo.revealDocument(person.id, "passport_number")).toBeNull();
  });

  it("update leaves an absent field unchanged, clears on null, replaces on string", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119", notes: "keep" });
    await repo.update(person.id, { knownTravelerNumber: "KTN999999" });
    expect(await repo.revealDocument(person.id, "passport_number")).toBe("C03X72119"); // untouched
    expect(await repo.revealDocument(person.id, "known_traveler_number")).toBe("KTN999999");
    await repo.update(person.id, { passportNumber: null });
    expect(await repo.revealDocument(person.id, "passport_number")).toBeNull();
  });

  it("update rejects a masked value handed back as plaintext", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    await expect(repo.update(person.id, { passportNumber: "••••2119" })).rejects.toThrow(ValidationError);
  });

  it("update 404s for a person outside the household", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    await expect(repo.update("nope", { displayName: "X" })).rejects.toThrow(NotFoundError);
  });

  it("a viewer cannot create", async () => {
    const viewer = new PersonRepo(env.DB, { ...ctxA, role: "viewer" }, ring);
    await expect(viewer.create({ displayName: "Ava" })).rejects.toThrow(ForbiddenError);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `nix develop -c npx vitest run tests/server/repos/person.test.ts`
Expected: FAIL — current `person.ts` is sync and imports `node:sqlite`.

- [ ] **Step 3: Rewrite `src/server/repos/person.ts`**

```ts
import { TenantRepo, TenantScopeError, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask, assertNotMasked } from "../crypto/envelope.js";
import { newId } from "../ids.js";

export const DOCUMENT_FIELDS = [
  "passport_number",
  "known_traveler_number",
  "redress_number",
] as const;

export type DocumentField = (typeof DOCUMENT_FIELDS)[number];

export type Person = {
  id: string;
  displayName: string;
  dob: string | null;
  notes: string | null;
  passportExpiry: string | null;
  passportCountry: string | null;
  passportNumberMasked: string | null;
  knownTravelerNumberMasked: string | null;
  redressNumberMasked: string | null;
};

export type CreatePersonInput = {
  displayName: string;
  dob?: string;
  notes?: string;
  passportNumber?: string;
  passportExpiry?: string;
  passportCountry?: string;
  knownTravelerNumber?: string;
  redressNumber?: string;
};

/**
 * Document fields are TRI-STATE: absent -> leave, null -> clear, string ->
 * encrypt and store.
 */
export type UpdatePersonInput = {
  displayName?: string;
  dob?: string | null;
  notes?: string | null;
  passportExpiry?: string | null;
  passportCountry?: string | null;
  passportNumber?: string | null;
  knownTravelerNumber?: string | null;
  redressNumber?: string | null;
};

const PLAIN_COLUMNS = {
  displayName: "display_name",
  dob: "dob",
  notes: "notes",
  passportExpiry: "passport_expiry",
  passportCountry: "passport_country",
} as const;

const ENCRYPTED_COLUMNS = {
  passportNumber: "passport_number",
  knownTravelerNumber: "known_traveler_number",
  redressNumber: "redress_number",
} as const;

function rejectMasked(field: string, value: string): void {
  try {
    assertNotMasked(field, value);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : String(err));
  }
}

type PersonRow = {
  id: string;
  display_name: string;
  dob: string | null;
  notes: string | null;
  passport_expiry: string | null;
  passport_country: string | null;
  passport_number: string | null;
  known_traveler_number: string | null;
  redress_number: string | null;
};

export class PersonRepo extends TenantRepo {
  constructor(
    db: D1Database,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  async create(input: CreatePersonInput): Promise<Person> {
    this.requireWrite();
    const id = newId();
    await this.insert("person", {
      id,
      display_name: input.displayName,
      dob: input.dob ?? null,
      notes: input.notes ?? null,
      passport_expiry: input.passportExpiry ?? null,
      passport_country: input.passportCountry ?? null,
      passport_number: await this.seal(input.passportNumber),
      known_traveler_number: await this.seal(input.knownTravelerNumber),
      redress_number: await this.seal(input.redressNumber),
      created_at: new Date().toISOString(),
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Person disappeared immediately after creation");
    return created;
  }

  async update(id: string, input: UpdatePersonInput): Promise<Person> {
    this.requireWrite();

    const existing = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      id,
    );
    if (!existing) throw new NotFoundError("Person not found in this household");

    const sets: string[] = [];
    const params: unknown[] = [];
    // Caller param k (1-based) binds to ?(k+1); the household id owns ?1.
    let next = 2;

    for (const [key, column] of Object.entries(PLAIN_COLUMNS)) {
      const value = input[key as keyof typeof PLAIN_COLUMNS];
      if (value === undefined) continue;
      if (key === "displayName" && (typeof value !== "string" || value.trim() === "")) {
        throw new ValidationError("displayName must be a non-empty string");
      }
      sets.push(`${column} = ?${next++}`);
      params.push(value ?? null);
    }

    for (const [key, column] of Object.entries(ENCRYPTED_COLUMNS)) {
      const value = input[key as keyof typeof ENCRYPTED_COLUMNS];
      if (value === undefined) continue;
      if (value === null) {
        sets.push(`${column} = ?${next++}`);
        params.push(null);
        continue;
      }
      rejectMasked(key, value);
      sets.push(`${column} = ?${next++}`);
      params.push(await this.ring.encrypt(value));
    }

    if (sets.length > 0) {
      // The id is the last caller param, so it takes the next index.
      await this.run(
        `UPDATE person SET ${sets.join(", ")} WHERE {scope} AND id = ?${next}`,
        ...params,
        id,
      );
    }

    const updated = await this.findById(id);
    if (!updated) throw new Error("Person disappeared immediately after update");
    return updated;
  }

  async list(): Promise<Person[]> {
    const rows = await this.all<PersonRow>("SELECT * FROM person WHERE {scope} ORDER BY display_name");
    const people: Person[] = [];
    for (const row of rows) {
      try {
        people.push(await this.toPerson(row));
      } catch (err) {
        // One unreadable envelope must not take down the whole list.
        console.error(`[PersonRepo] skipping person ${row.id} in list(): unreadable row`, err);
      }
    }
    return people;
  }

  async findById(id: string): Promise<Person | undefined> {
    const row = await this.get<PersonRow>("SELECT * FROM person WHERE {scope} AND id = ?2", id);
    return row ? this.toPerson(row) : undefined;
  }

  async revealDocument(personId: string, field: DocumentField): Promise<string | null> {
    this.requireReveal();
    if (!DOCUMENT_FIELDS.includes(field)) {
      throw new TenantScopeError("revealDocument() called with a field outside DOCUMENT_FIELDS");
    }
    const row = await this.get<{ value: string | null }>(
      `SELECT ${field} AS value FROM person WHERE {scope} AND id = ?2`,
      personId,
    );
    if (!row) throw new NotFoundError("Person not found in this household");
    return row.value === null ? null : this.ring.decrypt(row.value);
  }

  private async seal(plaintext: string | undefined): Promise<string | null> {
    return plaintext ? this.ring.encrypt(plaintext) : null;
  }

  private async unsealAndMask(envelope: string | null): Promise<string | null> {
    return envelope === null ? null : mask(await this.ring.decrypt(envelope));
  }

  private async toPerson(r: PersonRow): Promise<Person> {
    return {
      id: r.id,
      displayName: r.display_name,
      dob: r.dob,
      notes: r.notes,
      passportExpiry: r.passport_expiry,
      passportCountry: r.passport_country,
      passportNumberMasked: await this.unsealAndMask(r.passport_number),
      knownTravelerNumberMasked: await this.unsealAndMask(r.known_traveler_number),
      redressNumberMasked: await this.unsealAndMask(r.redress_number),
    };
  }
}
```

- [ ] **Step 4: Run the person test green**

Run: `nix develop -c npx vitest run tests/server/repos/person.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Delete the superseded update test**

```bash
git rm tests/server/repos/person-update.test.ts
```

Its behaviour (tri-state update, masked-value rejection, 404) is covered by the ported `person.test.ts` above.

- [ ] **Step 6: Write the failing `tests/server/repos/trip.test.ts`**

Replace the file entirely. 6 `it` blocks.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TripRepo } from "../../../src/server/repos/trip.js";
import { NotFoundError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trip_person");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
});

describe("TripRepo", () => {
  it("creates a trip with the default planning status", async () => {
    const trip = await new TripRepo(env.DB, ctxA).create({ title: "Guerneville" });
    expect(trip.status).toBe("planning");
    expect(trip.title).toBe("Guerneville");
  });

  it("lists trips scoped to the household, nulls-last by start", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    await repo.create({ title: "Later", startsOn: "2026-10-01" });
    await repo.create({ title: "Undated" });
    const list = await repo.list();
    expect(list.map((t) => t.title)).toEqual(["Later", "Undated"]);
  });

  it("findById returns undefined for a foreign id", async () => {
    expect(await new TripRepo(env.DB, ctxA).findById("nope")).toBeUndefined();
  });

  it("addTraveler links a person and travelers() lists them", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await repo.addTraveler(trip.id, "p-ava");
    expect(await repo.travelers(trip.id)).toEqual(["p-ava"]);
  });

  it("addTraveler 404s for a person outside the household", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await expect(repo.addTraveler(trip.id, "nope")).rejects.toThrow(NotFoundError);
  });

  it("a viewer cannot create a trip", async () => {
    const viewer = new TripRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.create({ title: "Nope" })).rejects.toThrow(ForbiddenError);
  });
});
```

- [ ] **Step 7: Run it red**

Run: `nix develop -c npx vitest run tests/server/repos/trip.test.ts`
Expected: FAIL — current `trip.ts` is sync / `node:sqlite`.

- [ ] **Step 8: Rewrite `src/server/repos/trip.ts`**

```ts
import { TenantRepo, NotFoundError } from "./base.js";
import { newId } from "../ids.js";

export type TripStatus = "planning" | "active" | "complete" | "cancelled";

export type Trip = {
  id: string;
  title: string;
  destination: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: TripStatus;
  notes: string | null;
};

export type CreateTripInput = {
  title: string;
  destination?: string;
  startsOn?: string;
  endsOn?: string;
  notes?: string;
};

type TripRow = {
  id: string;
  title: string;
  destination: string | null;
  starts_on: string | null;
  ends_on: string | null;
  status: TripStatus;
  notes: string | null;
};

export class TripRepo extends TenantRepo {
  async create(input: CreateTripInput): Promise<Trip> {
    this.requireWrite();
    const id = newId();
    await this.insert("trip", {
      id,
      title: input.title,
      destination: input.destination ?? null,
      starts_on: input.startsOn ?? null,
      ends_on: input.endsOn ?? null,
      status: "planning",
      notes: input.notes ?? null,
      created_at: new Date().toISOString(),
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Trip disappeared immediately after creation");
    return created;
  }

  async list(): Promise<Trip[]> {
    const rows = await this.all<TripRow>(
      "SELECT * FROM trip WHERE {scope} ORDER BY starts_on IS NULL, starts_on",
    );
    return rows.map(toTrip);
  }

  async findById(id: string): Promise<Trip | undefined> {
    const row = await this.get<TripRow>("SELECT * FROM trip WHERE {scope} AND id = ?2", id);
    return row ? toTrip(row) : undefined;
  }

  async addTraveler(tripId: string, personId: string): Promise<void> {
    this.requireWrite();
    if (!(await this.findById(tripId))) {
      throw new NotFoundError("Trip not found in this household");
    }
    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) {
      throw new NotFoundError("Person not found in this household");
    }
    // Unscoped by design: trip_person carries no household_id; both ids were
    // just confirmed in-household by the scoped queries above.
    await this.unscopedRun(
      "join-table write; tripId and personId already confirmed in-household above",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      tripId,
      personId,
    );
  }

  async travelers(tripId: string): Promise<string[]> {
    const rows = await this.all<{ person_id: string }>(
      `SELECT tp.person_id
         FROM trip_person tp
         JOIN trip t ON t.id = tp.trip_id
        WHERE {scope} AND tp.trip_id = ?2
        ORDER BY tp.person_id`,
      tripId,
    );
    return rows.map((r) => r.person_id);
  }
}

function toTrip(r: TripRow): Trip {
  return {
    id: r.id,
    title: r.title,
    destination: r.destination,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    status: r.status,
    notes: r.notes,
  };
}
```

- [ ] **Step 9: Run the trip test green, then the full suite**

Run: `nix develop -c npx vitest run tests/server/repos/trip.test.ts`
Expected: 6 passed.
Run: `nix develop -c npm test`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/server/repos/person.ts src/server/repos/trip.ts tests/server/repos/person.test.ts tests/server/repos/trip.test.ts
git commit -m "feat(cf): async PersonRepo + TripRepo on D1 with async WebCrypto"
```

---

### Task 6: BookingRepo + confirmation + ItineraryRepo + ChecklistRepo + RollupRepo (async, D1)

Ports the remaining five repository modules. Every behaviour is preserved: the masked-value guard via `assertNotMasked`, the shared `openConfirmation`, the timezone grouping (`localDateOf`), the `status IN ('booked','planned')` rollup predicate, and the checklist NULL-person handling. `openConfirmation` and `toBooking` become async (they decrypt). Scoped queries use explicit `?2`+ placeholders.

**Files:**
- Replace: `src/server/repos/confirmation.ts`
- Replace: `src/server/repos/booking.ts`
- Replace: `src/server/repos/itinerary.ts`
- Replace: `src/server/repos/checklist.ts`
- Replace: `src/server/repos/rollup.ts`
- Replace: `tests/server/repos/booking.test.ts`
- Replace: `tests/server/repos/itinerary.test.ts`
- Replace: `tests/server/repos/checklist.test.ts`
- Replace: `tests/server/repos/rollup.test.ts`

**Interfaces:**
- Consumes: `TenantRepo`, `Keyring`, `newId`, `parseDetails` (`../schemas/booking-kinds.js`), `isValidTimestamp`/`isValidTimezone` (`../time.js`).
- Produces `openConfirmation(ring: Keyring, stored: string | null): Promise<string | null>`.
- Produces `toBooking(ring: Keyring, row: BookingRow, personIds: string[]): Promise<Booking>`; `abstract class BookingAwareRepo` with `protected personIdsFor(bookingId): Promise<string[]>`; exports `BOOKING_STATUSES`, `BookingStatus`, `Booking`, `BookingRow`, `CreateBookingInput`.
- Produces `BookingRepo(db, ctx, ring)`: `create`, `findById`, `listByTrip`, `assignPerson`, `setStatus`, `revealConfirmation` — all async.
- Produces `ItineraryRepo(db, ctx, ring)`: `forPerson(tripId, personId): Promise<ItineraryDay[]>`, `forTrip(tripId): Promise<ItineraryDay[]>`. Exports `ItineraryDay`.
- Produces `ChecklistRepo(db, ctx)`: `create`, `findById`, `listByTrip`, `listAll`, `setDone` — all async. Exports `ChecklistItem`, `CreateChecklistInput`.
- Produces `RollupRepo(db, ctx)`: `forTrip(tripId): Promise<TripRollup>`. Exports `TripRollup`.

- [ ] **Step 1: Rewrite `src/server/repos/confirmation.ts`**

```ts
import type { Keyring } from "../crypto/envelope.js";

/**
 * Unseal a stored confirmation number. Lives in one place so no unmasking path
 * is duplicated.
 */
export async function openConfirmation(ring: Keyring, stored: string | null): Promise<string | null> {
  return stored === null ? null : ring.decrypt(stored);
}
```

- [ ] **Step 2: Rewrite `src/server/repos/booking.ts`**

```ts
import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask, assertNotMasked } from "../crypto/envelope.js";
import { openConfirmation } from "./confirmation.js";
import { newId } from "../ids.js";
import { parseDetails } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";

export const BOOKING_STATUSES = ["draft", "planned", "booked", "cancelled"] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type Booking = {
  id: string;
  tripId: string;
  kind: string;
  title: string;
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  confirmationNumberMasked: string | null;
  costCents: number | null;
  pointsUsed: number | null;
  pointsProgram: string | null;
  status: BookingStatus;
  details: unknown;
  personIds: string[];
};

export type CreateBookingInput = {
  tripId: string;
  kind: string;
  title: string;
  location?: string;
  startsAt?: string;
  startsAtTz?: string;
  endsAt?: string;
  endsAtTz?: string;
  confirmationNumber?: string;
  costCents?: number;
  pointsUsed?: number;
  pointsProgram?: string;
  status?: BookingStatus;
  details: unknown;
};

export type BookingRow = {
  id: string;
  trip_id: string;
  kind: string;
  title: string;
  location: string | null;
  starts_at: string | null;
  starts_at_tz: string | null;
  ends_at: string | null;
  ends_at_tz: string | null;
  confirmation_number: string | null;
  cost_cents: number | null;
  points_used: number | null;
  points_program: string | null;
  status: BookingStatus;
  details: string;
};

/**
 * THE mapping from a raw booking row (plus its person ids) to the public
 * Booking shape. Both BookingRepo and ItineraryRepo call this so a column
 * cannot silently vanish from one view.
 */
export async function toBooking(
  ring: Keyring,
  row: BookingRow,
  personIds: string[],
): Promise<Booking> {
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind,
    title: row.title,
    location: row.location,
    startsAt: row.starts_at,
    startsAtTz: row.starts_at_tz,
    endsAt: row.ends_at,
    endsAtTz: row.ends_at_tz,
    confirmationNumberMasked: mask(await openConfirmation(ring, row.confirmation_number)),
    costCents: row.cost_cents,
    pointsUsed: row.points_used,
    pointsProgram: row.points_program,
    status: row.status,
    details: JSON.parse(row.details),
    personIds,
  };
}

export abstract class BookingAwareRepo extends TenantRepo {
  constructor(
    db: D1Database,
    ctx: HouseholdContext,
    protected readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  /**
   * Unscoped by design: only ever called with a bookingId already proven
   * in-household by a scoped query in the calling subclass.
   */
  protected async personIdsFor(bookingId: string): Promise<string[]> {
    const rows = await this.unscoped<{ person_id: string }>(
      "read-only join-table lookup; bookingId always sourced from a scoped query in a subclass",
      "SELECT person_id FROM booking_person WHERE booking_id = ? ORDER BY person_id",
      bookingId,
    );
    return rows.map((r) => r.person_id);
  }
}

export class BookingRepo extends BookingAwareRepo {
  async create(input: CreateBookingInput): Promise<Booking> {
    this.requireWrite();
    assertTimezonePaired(input);

    const trip = await this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?2",
      input.tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");

    if (input.confirmationNumber !== undefined && input.confirmationNumber !== null) {
      try {
        assertNotMasked("confirmationNumber", input.confirmationNumber);
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
    }

    const details = parseDetails(input.kind, input.details);
    const id = newId();
    await this.insert("booking", {
      id,
      trip_id: input.tripId,
      kind: input.kind,
      title: input.title,
      location: input.location ?? null,
      starts_at: input.startsAt ?? null,
      starts_at_tz: input.startsAtTz ?? null,
      ends_at: input.endsAt ?? null,
      ends_at_tz: input.endsAtTz ?? null,
      confirmation_number: input.confirmationNumber
        ? await this.ring.encrypt(input.confirmationNumber)
        : null,
      cost_cents: input.costCents ?? null,
      points_used: input.pointsUsed ?? null,
      points_program: input.pointsProgram ?? null,
      status: input.status ?? "planned",
      details: JSON.stringify(details),
      created_at: new Date().toISOString(),
    });

    const created = await this.findById(id);
    if (!created) throw new Error("Booking disappeared immediately after creation");
    return created;
  }

  async findById(id: string): Promise<Booking | undefined> {
    const row = await this.get<BookingRow>("SELECT * FROM booking WHERE {scope} AND id = ?2", id);
    return row ? toBooking(this.ring, row, await this.personIdsFor(row.id)) : undefined;
  }

  async listByTrip(tripId: string): Promise<Booking[]> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const rows = await this.all<BookingRow>(
      `SELECT * FROM booking
        WHERE {scope} AND trip_id = ?2
          AND status != 'cancelled'
        ORDER BY starts_at IS NULL, starts_at`,
      tripId,
    );

    const bookings: Booking[] = [];
    for (const row of rows) {
      try {
        bookings.push(await toBooking(this.ring, row, await this.personIdsFor(row.id)));
      } catch (err) {
        console.error(`[BookingRepo] skipping booking ${row.id} in listByTrip: unreadable row`, err);
      }
    }
    return bookings;
  }

  async assignPerson(bookingId: string, personId: string): Promise<void> {
    this.requireWrite();
    const booking = await this.get<{ id: string; trip_id: string }>(
      "SELECT id, trip_id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");

    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) throw new NotFoundError("Person not found in this household");

    await this.unscopedRun(
      "join-table write; bookingId and personId already confirmed in-household above",
      "INSERT OR IGNORE INTO booking_person (booking_id, person_id) VALUES (?, ?)",
      bookingId,
      personId,
    );

    // Being on a booking for a trip means being on that trip.
    await this.unscopedRun(
      "join-table write; tripId (from the scoped booking row) and personId already confirmed in-household",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      booking.trip_id,
      personId,
    );
  }

  async setStatus(bookingId: string, status: BookingStatus): Promise<void> {
    this.requireWrite();
    const booking = await this.get<{ id: string }>(
      "SELECT id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");
    await this.run("UPDATE booking SET status = ?2 WHERE {scope} AND id = ?3", status, bookingId);
  }

  async revealConfirmation(bookingId: string): Promise<string | null> {
    this.requireReveal();
    const row = await this.get<{ value: string | null }>(
      "SELECT confirmation_number AS value FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!row) throw new NotFoundError("Booking not found in this household");
    return openConfirmation(this.ring, row.value);
  }
}

/**
 * A timestamp without its IANA zone renders every cross-timezone itinerary
 * wrong. Reject the unpaired case, an unparseable timestamp, and an invalid
 * timezone at the boundary.
 */
function assertTimezonePaired(input: CreateBookingInput): void {
  if (input.startsAt) {
    if (!input.startsAtTz) throw new ValidationError("startsAt requires startsAtTz (an IANA timezone)");
    if (!isValidTimestamp(input.startsAt)) throw new ValidationError("startsAt must be a parseable timestamp");
    if (!isValidTimezone(input.startsAtTz)) throw new ValidationError("startsAtTz must be a valid IANA timezone");
  }
  if (input.endsAt) {
    if (!input.endsAtTz) throw new ValidationError("endsAt requires endsAtTz (an IANA timezone)");
    if (!isValidTimestamp(input.endsAt)) throw new ValidationError("endsAt must be a parseable timestamp");
    if (!isValidTimezone(input.endsAtTz)) throw new ValidationError("endsAtTz must be a valid IANA timezone");
  }
}
```

- [ ] **Step 3: Rewrite `src/server/repos/itinerary.ts`**

```ts
import { BookingAwareRepo, toBooking } from "./booking.js";
import type { Booking, BookingRow } from "./booking.js";
import { NotFoundError } from "./base.js";

export type ItineraryDay = {
  /** Calendar date in the event's own local timezone, as YYYY-MM-DD. */
  date: string;
  bookings: Booking[];
};

export class ItineraryRepo extends BookingAwareRepo {
  async forPerson(tripId: string, personId: string): Promise<ItineraryDay[]> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) throw new NotFoundError("Person not found in this household");

    const rows = await this.all<BookingRow>(
      `SELECT b.*
         FROM booking b
         JOIN booking_person bp ON bp.booking_id = b.id
        WHERE {scope}
          AND b.trip_id = ?2
          AND bp.person_id = ?3
          AND b.status != 'cancelled'
          AND b.starts_at IS NOT NULL
        ORDER BY b.starts_at`,
      tripId,
      personId,
    );
    return this.group(rows);
  }

  async forTrip(tripId: string): Promise<ItineraryDay[]> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const rows = await this.all<BookingRow>(
      `SELECT b.*
         FROM booking b
        WHERE {scope}
          AND b.trip_id = ?2
          AND b.status != 'cancelled'
          AND b.starts_at IS NOT NULL
        ORDER BY b.starts_at`,
      tripId,
    );
    return this.group(rows);
  }

  /**
   * A row that can't be formatted (unparseable starts_at, unrecognized IANA
   * zone, or an undecryptable confirmation envelope) is skipped and logged
   * rather than allowed to throw and take down the whole day view.
   */
  private async group(rows: BookingRow[]): Promise<ItineraryDay[]> {
    const byDate = new Map<string, Booking[]>();

    for (const r of rows) {
      let date: string;
      let booking: Booking;
      try {
        date = localDateOf(r.starts_at!, r.starts_at_tz ?? "UTC");
        booking = await toBooking(this.ring, r, await this.personIdsFor(r.id));
      } catch (err) {
        console.error(`[ItineraryRepo] skipping booking ${r.id} in day view: cannot format row`, err);
        continue;
      }
      const list = byDate.get(date) ?? [];
      list.push(booking);
      byDate.set(date, list);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bookings]) => ({ date, bookings }));
  }
}

/**
 * The calendar date an event belongs to is its date in ITS OWN timezone.
 * en-CA formats natively as YYYY-MM-DD.
 */
function localDateOf(utcInstant: string, ianaZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcInstant));
}
```

- [ ] **Step 4: Rewrite `src/server/repos/checklist.ts`**

```ts
import { TenantRepo, NotFoundError } from "./base.js";
import { newId } from "../ids.js";

export type ChecklistItem = {
  id: string;
  tripId: string;
  /** NULL means a family-wide task rather than an assigned one. */
  personId: string | null;
  label: string;
  dueOn: string | null;
  doneAt: string | null;
};

export type CreateChecklistInput = {
  tripId: string;
  label: string;
  personId?: string;
  dueOn?: string;
};

type Row = {
  id: string;
  trip_id: string;
  person_id: string | null;
  label: string;
  due_on: string | null;
  done_at: string | null;
};

export class ChecklistRepo extends TenantRepo {
  async create(input: CreateChecklistInput): Promise<ChecklistItem> {
    this.requireWrite();

    const trip = await this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?2",
      input.tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");

    if (input.personId) {
      const person = await this.get<{ id: string }>(
        "SELECT id FROM person WHERE {scope} AND id = ?2",
        input.personId,
      );
      if (!person) throw new NotFoundError("Person not found in this household");
    }

    const id = newId();
    await this.insert("checklist_item", {
      id,
      trip_id: input.tripId,
      person_id: input.personId ?? null,
      label: input.label,
      due_on: input.dueOn ?? null,
      done_at: null,
      created_at: new Date().toISOString(),
    });

    const created = await this.findById(id);
    if (!created) throw new Error("Checklist item disappeared immediately after creation");
    return created;
  }

  async findById(id: string): Promise<ChecklistItem | undefined> {
    const row = await this.get<Row>("SELECT * FROM checklist_item WHERE {scope} AND id = ?2", id);
    return row ? toItem(row) : undefined;
  }

  async listByTrip(tripId: string): Promise<ChecklistItem[]> {
    const rows = await this.all<Row>(
      `SELECT * FROM checklist_item
        WHERE {scope} AND trip_id = ?2
        ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, created_at`,
      tripId,
    );
    return rows.map(toItem);
  }

  /** Every open item across all trips — the cross-trip checklist route. */
  async listAll(): Promise<ChecklistItem[]> {
    const rows = await this.all<Row>(
      `SELECT * FROM checklist_item
        WHERE {scope}
        ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, created_at`,
    );
    return rows.map(toItem);
  }

  async setDone(id: string, done: boolean): Promise<void> {
    this.requireWrite();
    if (!(await this.findById(id))) {
      throw new NotFoundError("Checklist item not found in this household");
    }
    await this.run(
      "UPDATE checklist_item SET done_at = ?2 WHERE {scope} AND id = ?3",
      done ? new Date().toISOString() : null,
      id,
    );
  }
}

function toItem(r: Row): ChecklistItem {
  return {
    id: r.id,
    tripId: r.trip_id,
    personId: r.person_id,
    label: r.label,
    dueOn: r.due_on,
    doneAt: r.done_at,
  };
}
```

- [ ] **Step 5: Rewrite `src/server/repos/rollup.ts`**

```ts
import { TenantRepo, NotFoundError } from "./base.js";

export type TripRollup = {
  bookedCents: number;
  plannedCents: number;
  totalCents: number;
  /** Count of draft bookings excluded from totalCents. */
  draftCount: number;
  points: { program: string; used: number }[];
};

export class RollupRepo extends TenantRepo {
  async forTrip(tripId: string): Promise<TripRollup> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const costs = await this.all<{ status: string; total: number }>(
      `SELECT status, COALESCE(SUM(cost_cents), 0) AS total
         FROM booking
        WHERE {scope} AND trip_id = ?2
          AND status IN ('booked', 'planned')
        GROUP BY status`,
      tripId,
    );

    const bookedCents = costs.find((c) => c.status === "booked")?.total ?? 0;
    const plannedCents = costs.find((c) => c.status === "planned")?.total ?? 0;

    const draft = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM booking WHERE {scope} AND trip_id = ?2 AND status = 'draft'`,
      tripId,
    );

    const points = await this.all<{ program: string; used: number }>(
      `SELECT points_program AS program, COALESCE(SUM(points_used), 0) AS used
         FROM booking
        WHERE {scope} AND trip_id = ?2
          AND status IN ('booked', 'planned')
          AND points_program IS NOT NULL
          AND points_used IS NOT NULL
        GROUP BY points_program
        ORDER BY points_program`,
      tripId,
    );

    return {
      bookedCents,
      plannedCents,
      totalCents: bookedCents + plannedCents,
      draftCount: draft?.count ?? 0,
      points,
    };
  }
}
```

- [ ] **Step 6: Write the failing repo tests**

Create/replace the four test files. A shared seed helper is repeated per file (tests read out of order). Counts: booking 7, itinerary 4, checklist 6, rollup 4.

`tests/server/repos/booking.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError, ValidationError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

async function seed(): Promise<string> {
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
  return "t1";
}

beforeEach(seed);

describe("BookingRepo", () => {
  it("creates a booking and masks the confirmation number in list output", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    await repo.create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} });
    const list = await repo.listByTrip("t1");
    expect(list[0]?.confirmationNumberMasked).toBe("••••X4T2");
    expect(JSON.stringify(list)).not.toContain("ABCDX4T2");
  });

  it("reveals the confirmation number through revealConfirmation", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    const b = await repo.create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} });
    expect(await repo.revealConfirmation(b.id)).toBe("ABCDX4T2");
  });

  it("a viewer cannot reveal a confirmation number", async () => {
    const b = await new BookingRepo(env.DB, ctxA, ring).create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} });
    const viewer = new BookingRepo(env.DB, { ...ctxA, role: "viewer" }, ring);
    await expect(viewer.revealConfirmation(b.id)).rejects.toThrow(ForbiddenError);
  });

  it("rejects a masked confirmation number handed back as plaintext", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    await expect(repo.create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "••••X4T2", details: {} })).rejects.toThrow(ValidationError);
  });

  it("rejects an unpaired timezone", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    await expect(repo.create({ tripId: "t1", kind: "other", title: "No tz", startsAt: "2026-10-10T02:00:00Z", details: {} })).rejects.toThrow(ValidationError);
  });

  it("listByTrip 404s for an unknown trip", async () => {
    await expect(new BookingRepo(env.DB, ctxA, ring).listByTrip("nope")).rejects.toThrow(NotFoundError);
  });

  it("assignPerson links the person to the booking and the trip, and setStatus updates", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    const b = await repo.create({ tripId: "t1", kind: "other", title: "Hotel", details: {} });
    await repo.assignPerson(b.id, "p-ava");
    await repo.setStatus(b.id, "booked");
    const list = await repo.listByTrip("t1");
    expect(list[0]?.personIds).toEqual(["p-ava"]);
    expect(list[0]?.status).toBe("booked");
  });
});
```

`tests/server/repos/itinerary.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { ItineraryRepo } from "../../../src/server/repos/itinerary.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
});

describe("ItineraryRepo", () => {
  it("groups a booking under its own local date", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    // 2026-10-10T02:00Z is 2026-10-09 19:00 in America/Los_Angeles.
    await bookings.create({ tripId: "t1", kind: "other", title: "Dinner", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "America/Los_Angeles", details: {} });
    const days = await new ItineraryRepo(env.DB, ctxA, ring).forTrip("t1");
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe("2026-10-09");
  });

  it("forPerson only includes bookings the person is on", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    const b = await bookings.create({ tripId: "t1", kind: "other", title: "Dinner", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "America/Los_Angeles", details: {} });
    await bookings.assignPerson(b.id, "p-ava");
    const mine = await new ItineraryRepo(env.DB, ctxA, ring).forPerson("t1", "p-ava");
    expect(mine).toHaveLength(1);
  });

  it("forTrip 404s for an unknown trip", async () => {
    await expect(new ItineraryRepo(env.DB, ctxA, ring).forTrip("nope")).rejects.toThrow(NotFoundError);
  });

  it("forPerson 404s for a person outside the household", async () => {
    await expect(new ItineraryRepo(env.DB, ctxA, ring).forPerson("t1", "nope")).rejects.toThrow(NotFoundError);
  });
});
```

`tests/server/repos/checklist.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ChecklistRepo } from "../../../src/server/repos/checklist.js";
import { NotFoundError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM checklist_item");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
});

describe("ChecklistRepo", () => {
  it("creates a family-wide item with a null personId", async () => {
    const item = await new ChecklistRepo(env.DB, ctxA).create({ tripId: "t1", label: "Pack passports" });
    expect(item.personId).toBeNull();
  });

  it("creates a person-assigned item", async () => {
    const item = await new ChecklistRepo(env.DB, ctxA).create({ tripId: "t1", label: "Pack", personId: "p-ava" });
    expect(item.personId).toBe("p-ava");
  });

  it("404s for a trip that does not exist", async () => {
    await expect(new ChecklistRepo(env.DB, ctxA).create({ tripId: "nope", label: "X" })).rejects.toThrow(NotFoundError);
  });

  it("listAll returns items across trips", async () => {
    const repo = new ChecklistRepo(env.DB, ctxA);
    await repo.create({ tripId: "t1", label: "One" });
    expect((await repo.listAll()).map((i) => i.label)).toContain("One");
  });

  it("setDone marks an item done and 404s for an unknown id", async () => {
    const repo = new ChecklistRepo(env.DB, ctxA);
    const item = await repo.create({ tripId: "t1", label: "One" });
    await repo.setDone(item.id, true);
    expect((await repo.findById(item.id))?.doneAt).not.toBeNull();
    await expect(repo.setDone("nope", true)).rejects.toThrow(NotFoundError);
  });

  it("a viewer cannot create an item", async () => {
    const viewer = new ChecklistRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.create({ tripId: "t1", label: "X" })).rejects.toThrow(ForbiddenError);
  });
});
```

`tests/server/repos/rollup.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { RollupRepo } from "../../../src/server/repos/rollup.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
});

describe("RollupRepo", () => {
  it("sums booked and planned but excludes draft from the total", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    await bookings.create({ tripId: "t1", kind: "other", title: "Booked", costCents: 20000, status: "booked", details: {} });
    await bookings.create({ tripId: "t1", kind: "other", title: "Planned", costCents: 5000, status: "planned", details: {} });
    await bookings.create({ tripId: "t1", kind: "other", title: "Draft", costCents: 50000, status: "draft", details: {} });
    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.totalCents).toBe(25000);
    expect(roll.draftCount).toBe(1);
  });

  it("aggregates points by program for booked/planned only", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    await bookings.create({ tripId: "t1", kind: "other", title: "P1", pointsUsed: 1000, pointsProgram: "UR", status: "booked", details: {} });
    await bookings.create({ tripId: "t1", kind: "other", title: "P2", pointsUsed: 500, pointsProgram: "UR", status: "planned", details: {} });
    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.points).toEqual([{ program: "UR", used: 1500 }]);
  });

  it("returns zeroes for a trip with no bookings", async () => {
    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.totalCents).toBe(0);
    expect(roll.points).toEqual([]);
  });

  it("404s for an unknown trip", async () => {
    await expect(new RollupRepo(env.DB, ctxA).forTrip("nope")).rejects.toThrow(NotFoundError);
  });
});
```

- [ ] **Step 7: Run the new repo tests red, then green**

Run: `nix develop -c npx vitest run tests/server/repos/booking.test.ts tests/server/repos/itinerary.test.ts tests/server/repos/checklist.test.ts tests/server/repos/rollup.test.ts`
Expected before implementing: FAIL. After Steps 1–5 are in place: booking 7, itinerary 4, checklist 6, rollup 4 — all pass.

- [ ] **Step 8: Run the whole server suite**

Run: `nix develop -c npm test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/server/repos/confirmation.ts src/server/repos/booking.ts src/server/repos/itinerary.ts src/server/repos/checklist.ts src/server/repos/rollup.ts tests/server/repos/booking.test.ts tests/server/repos/itinerary.test.ts tests/server/repos/checklist.test.ts tests/server/repos/rollup.test.ts
git commit -m "feat(cf): async Booking/Itinerary/Checklist/Rollup repos + confirmation on D1"
```

---

### Task 7: Auth on Workers

Ports `auth.ts`. The `jose` JWT logic (`jwtVerify`, JWKS fetch, the household-membership resolution and all its fail-safe rules) is unchanged in behaviour; the membership lookup becomes an async D1 query. The **service-token machinery, `machine` role, and `householdExists` are dropped** (deferred with ingest). The dev bypass ports as a **Worker-env variant** `resolveVerifier(env)`.

**Files:**
- Replace: `src/server/auth.ts`
- Replace: `tests/server/auth.test.ts`
- Delete (superseded): `tests/server/auth-service-token.test.ts`

**Interfaces:**
- Consumes: `Role` (Task 4), `D1Database`, `jose`.
- Produces: `class AuthError extends Error`; `class HouseholdAccessError extends AuthError`.
- Produces: `type Identity = { userId: string; email: string; householdId: string; role: Role }`.
- Produces: `resolveDevIdentity(db: D1Database, email: string): Promise<Identity | undefined>`.
- Produces: `createAccessVerifier(config: { teamDomain: string; audience: string; db: D1Database; fetchJwks?: () => Promise<JSONWebKeySet> }): (req: Request) => Promise<Identity>`.
- Produces: `resolveVerifier(env: { DB: D1Database; TRAVEL_HQ_ENV?: string; TRAVEL_HQ_DEV_EMAIL?: string; CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string }): (req: Request) => Promise<Identity>` — used by `createApp` in Task 8.

- [ ] **Step 1: Write the failing `tests/server/auth.test.ts`**

Replace the file entirely. Uses `jose` to mint real tokens and inject a matching JWKS. 8 `it` blocks.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet } from "jose";
import { createAccessVerifier, AuthError, HouseholdAccessError } from "../../src/server/auth.js";

const TEAM = "https://badgerops.cloudflareaccess.com";
const AUD = "test-aud";
const HEADER = "Cf-Access-Jwt-Assertion";
const HOUSEHOLD_HEADER = "X-Travel-HQ-Household";

let privateKey: CryptoKey;
let jwks: JSONWebKeySet;

async function token(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setExpirationTime("5m")
    .sign(privateKey);
}

function req(headers: Record<string, string>): Request {
  return new Request("http://x/api/me", { headers });
}

function verifier() {
  return createAccessVerifier({ teamDomain: TEAM, audience: AUD, db: env.DB, fetchJwks: async () => jwks });
}

beforeEach(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const pub = await exportJWK(pair.publicKey);
  pub.kid = "k1";
  pub.alg = "RS256";
  jwks = { keys: [pub] };

  await env.DB.exec("DELETE FROM household_member");
  await env.DB.exec("DELETE FROM user");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind(id, id, now).run();
  }
  await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)").bind("u1", "ava@example.com", now).run();
});

async function member(householdId: string, role: string) {
  await env.DB.prepare("INSERT INTO household_member (household_id,user_id,role) VALUES (?,?,?)").bind(householdId, "u1", role).run();
}

describe("createAccessVerifier", () => {
  it("rejects a missing Access header", async () => {
    await expect(verifier()(req({}))).rejects.toThrow(AuthError);
  });

  it("refuses a service-token JWT (common_name, no email) before the email check", async () => {
    await member("hh-a", "owner");
    const t = await token({ common_name: "svc" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(/Service tokens may not use the human API/);
  });

  it("rejects a token with no email claim", async () => {
    const t = await token({ sub: "x" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(/no email claim/);
  });

  it("rejects an email with no household membership", async () => {
    const t = await token({ email: "ava@example.com" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(/No household membership/);
  });

  it("resolves the sole membership when no header is given", async () => {
    await member("hh-a", "owner");
    const id = await verifier()(req({ [HEADER]: await token({ email: "ava@example.com" }) }));
    expect(id).toMatchObject({ userId: "u1", householdId: "hh-a", role: "owner" });
  });

  it("selects the requested household via the header", async () => {
    await member("hh-a", "owner");
    await member("hh-b", "viewer");
    const id = await verifier()(req({ [HEADER]: await token({ email: "ava@example.com" }), [HOUSEHOLD_HEADER]: "hh-b" }));
    expect(id).toMatchObject({ householdId: "hh-b", role: "viewer" });
  });

  it("throws HouseholdAccessError for a header naming a non-member household", async () => {
    await member("hh-a", "owner");
    await expect(
      verifier()(req({ [HEADER]: await token({ email: "ava@example.com" }), [HOUSEHOLD_HEADER]: "hh-b" })),
    ).rejects.toThrow(HouseholdAccessError);
  });

  it("throws AuthError for ambiguous membership with no header", async () => {
    await member("hh-a", "owner");
    await member("hh-b", "viewer");
    await expect(
      verifier()(req({ [HEADER]: await token({ email: "ava@example.com" }) })),
    ).rejects.toThrow(/Ambiguous household membership/);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `nix develop -c npx vitest run tests/server/auth.test.ts`
Expected: FAIL — current `auth.ts` imports `node:sqlite` and queries synchronously.

- [ ] **Step 3: Rewrite `src/server/auth.ts`**

```ts
import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";
import type { Role } from "./repos/base.js";

export class AuthError extends Error {}

/**
 * The caller authenticated (valid Access token, known user) but the household
 * they asked to act as is not one they belong to. Authorization failure (403),
 * not authentication (401). The message is deliberately identical whether the
 * named household exists and the caller isn't a member, or it doesn't exist at
 * all, so this can never be used as a membership oracle. Only change the class,
 * never the wording.
 */
export class HouseholdAccessError extends AuthError {}

export type Identity = {
  userId: string;
  email: string;
  householdId: string;
  role: Role;
};

export type AccessConfig = {
  /** e.g. https://badgerops.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  db: D1Database;
  /** Injectable for tests; defaults to fetching the team's certs endpoint. */
  fetchJwks?: () => Promise<JSONWebKeySet>;
};

const HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Selects which of the caller's households a request acts on. A SELECTOR, never
 * a discovery mechanism: verify() only ever returns a household the JWT-verified
 * email is already a confirmed member of.
 */
const HOUSEHOLD_HEADER = "X-Travel-HQ-Household";

const JWKS_TTL_MS = 60 * 60 * 1000;

type Membership = {
  user_id: string;
  email: string;
  household_id: string;
  role: Role;
};

const MEMBERSHIP_SQL = `SELECT u.id AS user_id, u.email, hm.household_id, hm.role
     FROM user u
     JOIN household_member hm ON hm.user_id = u.id
    WHERE u.email = ?
    ORDER BY hm.household_id`;

/**
 * Resolves an identity from a bare email, no JWT involved. Used only by the
 * development auth bypass; never skips the membership check. Returns undefined
 * for an email with no confirmed household_member row.
 */
export async function resolveDevIdentity(db: D1Database, email: string): Promise<Identity | undefined> {
  const row = await db.prepare(MEMBERSHIP_SQL).bind(email).first<Membership>();
  if (!row) return undefined;
  return { userId: row.user_id, email: row.email, householdId: row.household_id, role: row.role };
}

export function createAccessVerifier(config: AccessConfig) {
  const fetchJwks =
    config.fetchJwks ??
    (async () => {
      const res = await fetch(`${config.teamDomain}/cdn-cgi/access/certs`);
      if (!res.ok) throw new AuthError(`Could not fetch Access certs: ${res.status}`);
      return (await res.json()) as JSONWebKeySet;
    });

  let cached: { jwks: ReturnType<typeof createLocalJWKSet>; at: number } | null = null;

  async function keys() {
    if (!cached || Date.now() - cached.at > JWKS_TTL_MS) {
      cached = { jwks: createLocalJWKSet(await fetchJwks()), at: Date.now() };
    }
    return cached.jwks;
  }

  return async function verify(req: Request): Promise<Identity> {
    const token = req.headers.get(HEADER);
    if (!token) {
      throw new AuthError(`Missing ${HEADER}. Requests must arrive through Cloudflare Access.`);
    }

    let email: string;
    try {
      const { payload } = await jwtVerify(token, await keys(), {
        issuer: config.teamDomain,
        audience: config.audience,
      });
      // ORDER IS LOAD-BEARING. A service-token JWT carries common_name and no
      // email; this refusal must run before the email check or it is dead code.
      if (typeof payload.common_name === "string") {
        throw new AuthError("Service tokens may not use the human API");
      }
      if (typeof payload.email !== "string") {
        throw new AuthError("Access token carries no email claim");
      }
      email = payload.email;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`Invalid Access token: ${String(err)}`);
    }

    const { results: memberships } = await config.db.prepare(MEMBERSHIP_SQL).bind(email).all<Membership>();

    if (memberships.length === 0) {
      throw new AuthError(`No household membership for ${email}`);
    }

    const requested = req.headers.get(HOUSEHOLD_HEADER);
    let membership: Membership;

    if (requested !== null) {
      const match = memberships.find((m) => m.household_id === requested);
      if (!match) {
        // Same message whether the household is one the caller isn't in or
        // doesn't exist at all: no membership oracle.
        throw new HouseholdAccessError(
          `Not a member of the requested household. Provide a valid ${HOUSEHOLD_HEADER} header.`,
        );
      }
      membership = match;
    } else if (memberships.length === 1) {
      const only = memberships[0];
      if (!only) throw new AuthError(`No household membership for ${email}`);
      membership = only;
    } else {
      throw new AuthError(
        `Ambiguous household membership for ${email}; specify the ${HOUSEHOLD_HEADER} header.`,
      );
    }

    return {
      userId: membership.user_id,
      email: membership.email,
      householdId: membership.household_id,
      role: membership.role,
    };
  };
}

/**
 * Resolves the human verifier from the Worker env. Development must be opted
 * INTO explicitly (TRAVEL_HQ_ENV === "development" AND TRAVEL_HQ_DEV_EMAIL set):
 * unset means production, where the dev bypass is refused. The bypass resolves
 * an identity exactly as createAccessVerifier does once a JWT checks out — via
 * a confirmed household membership — it just skips the JWT because a laptop has
 * no Cloudflare Access in front of it.
 */
export type WorkerAuthEnv = {
  DB: D1Database;
  TRAVEL_HQ_ENV?: string;
  TRAVEL_HQ_DEV_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export function resolveVerifier(env: WorkerAuthEnv): (req: Request) => Promise<Identity> {
  const isDevelopment = env.TRAVEL_HQ_ENV === "development";
  const devEmail = env.TRAVEL_HQ_DEV_EMAIL;

  if (devEmail) {
    if (!isDevelopment) {
      throw new Error("TRAVEL_HQ_DEV_EMAIL must never be set outside development");
    }
    console.warn(`[dev] AUTH BYPASS ACTIVE -- every request acts as ${devEmail}`);
    return async function verifyDev(): Promise<Identity> {
      const identity = await resolveDevIdentity(env.DB, devEmail);
      if (!identity) {
        throw new AuthError(`No household membership for ${devEmail}.`);
      }
      return identity;
    };
  }

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (!teamDomain || !audience) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set");
  }
  return createAccessVerifier({ teamDomain, audience, db: env.DB });
}
```

- [ ] **Step 4: Run it green**

Run: `nix develop -c npx vitest run tests/server/auth.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Delete the superseded service-token test**

```bash
git rm tests/server/auth-service-token.test.ts
```

- [ ] **Step 6: Run the whole server suite**

Run: `nix develop -c npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/server/auth.ts tests/server/auth.test.ts
git commit -m "feat(cf): jose Access auth on Workers with async D1 membership + resolveVerifier(env)"
```

---

### Task 8: Routes + Worker entry; delete the old `node:sqlite` server

Ports the six route modules to `await` the async repos, rewrites `index.ts` as `createApp(overrides)` wiring the D1/AI/key bindings from `env` per request (auth middleware, `app.onError` → `mapError`), and makes `src/server/worker.ts` export `{ fetch: app.fetch }`. The **`email` handler is Plan C — NOT added here.** Ports the route tests to the pool, and **deletes** the old `node:sqlite` modules, the ingest modules, the old harness pieces, and the obsolete `package.json` scripts/deps. The final step verifies the whole suite is green, typecheck is clean, and documents the `wrangler dev` manual check.

**Files:**
- Replace: `src/server/index.ts`
- Replace: `src/server/routes/people.ts`, `routes/trips.ts`, `routes/bookings.ts`, `routes/itinerary.ts`, `routes/checklist.ts`
- Keep unchanged: `src/server/routes/errors.ts` (no node deps — imports from `base.js`/`auth.js` only)
- Replace: `src/server/worker.ts`
- Replace: `tests/server/routes/api.test.ts`, `routes/booking-status.test.ts`, `routes/people-update.test.ts`
- Keep unchanged: `tests/server/routes/errors.test.ts` (pure unit test of `mapError`)
- Create: `vitest.arch.config.ts`; modify `vitest.config.ts` to exclude the architecture test from the pool
- Modify: `tests/server/architecture.test.ts` (allowlist note; runs under the node config)
- Delete: `src/server/db/connection.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/`, `src/server/serve.ts`, `src/server/index.ts`'s old ingest wiring (via replacement), `src/server/repos/inbound-email.ts`, `src/server/routes/inbound-email.ts`, `src/server/ingest/` (all), and the corresponding old tests
- Modify: `package.json` (drop `@anthropic-ai/sdk`, `@hono/node-server`, `tsx`; add the arch test to `test:all`; drop `node` from `tsconfig.server.json` types)

**Interfaces:**
- Produces: `type AppBindings = { DB: D1Database; AI: Ai; ENCRYPTION_KEY: string; TRAVEL_HQ_ENV?: string; TRAVEL_HQ_DEV_EMAIL?: string; CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string }`.
- Produces: `type AppEnv = { Bindings: AppBindings; Variables: { db: D1Database; ring: Keyring; identity: Identity } }`.
- Produces: `createApp(overrides?: { verify?: (req: Request, env: AppBindings) => Promise<Identity>; ring?: Keyring }): Hono<AppEnv>`.

- [ ] **Step 1: Rewrite `src/server/index.ts`**

```ts
import { Hono } from "hono";
import { loadKeyring } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/envelope.js";
import { resolveVerifier } from "./auth.js";
import type { Identity, WorkerAuthEnv } from "./auth.js";
import { people } from "./routes/people.js";
import { trips } from "./routes/trips.js";
import { itinerary } from "./routes/itinerary.js";
import { bookings } from "./routes/bookings.js";
import { checklist } from "./routes/checklist.js";
import { mapError } from "./routes/errors.js";

export type AppBindings = {
  DB: D1Database;
  AI: Ai; // declared for later plans; unused here
  ENCRYPTION_KEY: string;
  TRAVEL_HQ_ENV?: string;
  TRAVEL_HQ_DEV_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    db: D1Database;
    ring: Keyring;
    identity: Identity;
  };
};

/**
 * Test seam. Production passes nothing: db/ring/verify are derived from the
 * per-request env. Tests inject `verify` (to supply an identity without a real
 * Access token) and `ring` (to control the encryption key).
 */
export type AppOverrides = {
  verify?: (req: Request, env: AppBindings) => Promise<Identity>;
  ring?: Keyring;
};

// The Access verifier caches JWKS; cache it per env object so that survives
// across requests within an isolate.
const verifierCache = new WeakMap<AppBindings, (req: Request) => Promise<Identity>>();

function verifierFor(env: AppBindings): (req: Request) => Promise<Identity> {
  let v = verifierCache.get(env);
  if (!v) {
    v = resolveVerifier(env as WorkerAuthEnv);
    verifierCache.set(env, v);
  }
  return v;
}

export function createApp(overrides: AppOverrides = {}) {
  const app = new Hono<AppEnv>();

  // The one place every thrown/rejected error in a route funnels through, so
  // there is exactly one status-mapping decision (routes/errors.ts).
  app.onError((err, c) => {
    const mapped = mapError(err);
    return c.json(mapped.body, mapped.status);
  });

  app.use("/api/*", async (c, next) => {
    const env = c.env;
    c.set("db", env.DB);
    c.set("ring", overrides.ring ?? loadKeyring(env.ENCRYPTION_KEY));
    const verify = overrides.verify ? (req: Request) => overrides.verify!(req, env) : verifierFor(env);
    // A real verify() rejects only with AuthError; app.onError maps it to 401.
    c.set("identity", await verify(c.req.raw));
    await next();
  });

  // Resolved by the middleware from the Access token + confirmed membership;
  // this route invents nothing.
  app.get("/api/me", (c) => c.json(c.get("identity")));

  app.route("/api/people", people);
  app.route("/api/trips", trips);
  app.route("/api", itinerary);
  app.route("/api/bookings", bookings);
  app.route("/api/checklist", checklist);

  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
```

- [ ] **Step 2: Rewrite `src/server/routes/people.ts`**

```ts
import { Hono } from "hono";
import { z } from "zod";
import { PersonRepo, DOCUMENT_FIELDS } from "../repos/person.js";
import type { DocumentField, UpdatePersonInput } from "../repos/person.js";
import type { AppEnv } from "../index.js";

const createPersonSchema = z.object({
  displayName: z.string().min(1),
  dob: z.string().optional(),
  notes: z.string().optional(),
  passportNumber: z.string().optional(),
  passportExpiry: z.string().optional(),
  passportCountry: z.string().optional(),
  knownTravelerNumber: z.string().optional(),
  redressNumber: z.string().optional(),
});

const updatePersonSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    dob: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    passportExpiry: z.string().nullable().optional(),
    passportCountry: z.string().nullable().optional(),
    passportNumber: z.string().min(1).nullable().optional(),
    knownTravelerNumber: z.string().min(1).nullable().optional(),
    redressNumber: z.string().min(1).nullable().optional(),
  })
  .strict();

export const people = new Hono<AppEnv>();

people.get("/", async (c) => {
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(await repo.list());
});

people.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createPersonSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid person", details: parsed.error.issues }, 400);
  }
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(await repo.create(parsed.data), 201);
});

people.put("/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updatePersonSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid person", details: parsed.error.issues }, 400);
  }
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(await repo.update(c.req.param("id"), parsed.data satisfies UpdatePersonInput));
});

people.get("/:id/reveal/:field", async (c) => {
  const field = c.req.param("field");
  if (!DOCUMENT_FIELDS.includes(field as DocumentField)) {
    return c.json({ error: `"${field}" is not a revealable document field` }, 400);
  }

  const identity = c.get("identity");
  const repo = new PersonRepo(c.get("db"), identity, c.get("ring"));
  const value = await repo.revealDocument(c.req.param("id"), field as DocumentField);

  console.info(
    JSON.stringify({
      event: "document_reveal",
      at: new Date().toISOString(),
      user: identity.email,
      household: identity.householdId,
      person: c.req.param("id"),
      field,
    }),
  );

  return c.json({ value });
});
```

- [ ] **Step 3: Rewrite `src/server/routes/trips.ts`**

```ts
import { Hono } from "hono";
import { z } from "zod";
import { TripRepo } from "../repos/trip.js";
import { BookingRepo } from "../repos/booking.js";
import { PersonRepo } from "../repos/person.js";
import { RollupRepo } from "../repos/rollup.js";
import { BOOKING_KINDS } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";
import type { AppEnv } from "../index.js";

const createTripSchema = z.object({
  title: z.string().min(1),
  destination: z.string().optional(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  notes: z.string().optional(),
});

const createBookingSchema = z
  .object({
    kind: z.enum(BOOKING_KINDS),
    title: z.string().min(1),
    location: z.string().optional(),
    startsAt: z.string().refine(isValidTimestamp, { message: "startsAt must be a parseable timestamp" }).optional(),
    startsAtTz: z.string().refine(isValidTimezone, { message: "startsAtTz must be a valid IANA timezone" }).optional(),
    endsAt: z.string().refine(isValidTimestamp, { message: "endsAt must be a parseable timestamp" }).optional(),
    endsAtTz: z.string().refine(isValidTimezone, { message: "endsAtTz must be a valid IANA timezone" }).optional(),
    confirmationNumber: z.string().optional(),
    costCents: z.number().int().optional(),
    pointsUsed: z.number().int().optional(),
    pointsProgram: z.string().optional(),
    status: z.enum(["draft", "planned", "booked", "cancelled"]).optional(),
    details: z.unknown(),
  })
  .refine((v) => !v.startsAt || v.startsAtTz, {
    message: "startsAt requires startsAtTz (an IANA timezone)",
    path: ["startsAtTz"],
  })
  .refine((v) => !v.endsAt || v.endsAtTz, {
    message: "endsAt requires endsAtTz (an IANA timezone)",
    path: ["endsAtTz"],
  });

export const trips = new Hono<AppEnv>();

trips.get("/", async (c) => c.json(await new TripRepo(c.get("db"), c.get("identity")).list()));

trips.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createTripSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid trip", details: parsed.error.issues }, 400);
  }
  return c.json(await new TripRepo(c.get("db"), c.get("identity")).create(parsed.data), 201);
});

trips.get("/:tripId/bookings", async (c) =>
  c.json(
    await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).listByTrip(c.req.param("tripId")),
  ),
);

trips.get("/:tripId/rollup", async (c) =>
  c.json(await new RollupRepo(c.get("db"), c.get("identity")).forTrip(c.req.param("tripId"))),
);

trips.post("/:tripId/bookings", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createBookingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid booking", details: parsed.error.issues }, 400);
  }
  const repo = new BookingRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(await repo.create({ ...parsed.data, tripId: c.req.param("tripId") }), 201);
});

trips.get("/:tripId/bookings/:bookingId/reveal", async (c) => {
  const identity = c.get("identity");
  const repo = new BookingRepo(c.get("db"), identity, c.get("ring"));
  const value = await repo.revealConfirmation(c.req.param("bookingId"));

  console.info(
    JSON.stringify({
      event: "confirmation_reveal",
      at: new Date().toISOString(),
      user: identity.email,
      household: identity.householdId,
      booking: c.req.param("bookingId"),
    }),
  );

  return c.json({ value });
});

trips.put("/:tripId/people/:personId", async (c) => {
  await new TripRepo(c.get("db"), c.get("identity")).addTraveler(
    c.req.param("tripId"),
    c.req.param("personId"),
  );
  return c.body(null, 204);
});

trips.get("/:tripId/travelers", async (c) => {
  const identity = c.get("identity");
  const db = c.get("db");
  const ids = new Set(await new TripRepo(db, identity).travelers(c.req.param("tripId")));
  const roster = await new PersonRepo(db, identity, c.get("ring")).list();
  return c.json(roster.filter((p) => ids.has(p.id)));
});
```

- [ ] **Step 4: Rewrite `src/server/routes/bookings.ts`**

```ts
import { Hono } from "hono";
import { z } from "zod";
import { BookingRepo, BOOKING_STATUSES } from "../repos/booking.js";
import type { AppEnv } from "../index.js";

const setStatusSchema = z.object({ status: z.enum(BOOKING_STATUSES) });

export const bookings = new Hono<AppEnv>();

bookings.put("/:bookingId/status", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = setStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid status", details: parsed.error.issues }, 400);
  }
  await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).setStatus(
    c.req.param("bookingId"),
    parsed.data.status,
  );
  return c.body(null, 204);
});
```

- [ ] **Step 5: Rewrite `src/server/routes/itinerary.ts`**

```ts
import { Hono } from "hono";
import { ItineraryRepo } from "../repos/itinerary.js";
import { BookingRepo } from "../repos/booking.js";
import type { AppEnv } from "../index.js";

export const itinerary = new Hono<AppEnv>();

itinerary.get("/trips/:tripId/itinerary", async (c) => {
  const repo = new ItineraryRepo(c.get("db"), c.get("identity"), c.get("ring"));
  const tripId = c.req.param("tripId");
  const personId = c.req.query("personId");
  return c.json(personId ? await repo.forPerson(tripId, personId) : await repo.forTrip(tripId));
});

itinerary.put("/bookings/:bookingId/people/:personId", async (c) => {
  await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).assignPerson(
    c.req.param("bookingId"),
    c.req.param("personId"),
  );
  return c.body(null, 204);
});
```

- [ ] **Step 6: Rewrite `src/server/routes/checklist.ts`**

```ts
import { Hono } from "hono";
import { z } from "zod";
import { ChecklistRepo } from "../repos/checklist.js";
import type { AppEnv } from "../index.js";

const createSchema = z.object({
  tripId: z.string().min(1),
  label: z.string().min(1),
  personId: z.string().optional(),
  dueOn: z.string().optional(),
});

const doneSchema = z.object({ done: z.boolean() });

export const checklist = new Hono<AppEnv>();

checklist.get("/", async (c) => c.json(await new ChecklistRepo(c.get("db"), c.get("identity")).listAll()));

checklist.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid checklist item", details: parsed.error.issues }, 400);
  }
  const repo = new ChecklistRepo(c.get("db"), c.get("identity"));
  return c.json(await repo.create(parsed.data), 201);
});

checklist.put("/:id/done", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = doneSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Expected { done: boolean }" }, 400);
  await new ChecklistRepo(c.get("db"), c.get("identity")).setDone(c.req.param("id"), parsed.data.done);
  return c.body(null, 204);
});
```

- [ ] **Step 7: Rewrite `src/server/worker.ts`**

```ts
import { createApp } from "./index.js";

// One app for the isolate; bindings arrive per request via env.
const app = createApp();

// The email() ingest handler is Plan C — deliberately NOT exported here.
export default { fetch: app.fetch };
```

`src/server/routes/errors.ts` is unchanged — it imports only from `base.js`/`auth.js` and has no runtime dependency on Node.

- [ ] **Step 8: Rewrite `tests/server/routes/api.test.ts`**

Replace the file entirely. `createApp` now takes `{ verify, ring }`; the D1 binding is passed to `app.request` as the third (env) argument. 36 `it` blocks (the same cases as the current suite).

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import { AuthError } from "../../../src/server/auth.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const identity: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity | (() => Promise<never>)) {
  const verify = typeof who === "function" ? who : async () => who;
  return createApp({ verify: verify as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}

let app: ReturnType<typeof createApp>;

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function postJson(path: string, body: unknown) {
  return request(app, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip_person");
  await env.DB.exec("DELETE FROM checklist_item");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", new Date().toISOString()).run();
  app = appAs(identity);
});

describe("API", () => {
  it("creates and lists people with masked documents", async () => {
    expect((await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).status).toBe(201);
    const body = (await (await request(app, "/api/people")).json()) as { passportNumberMasked: string }[];
    expect(body[0]?.passportNumberMasked).toBe("••••2119");
    expect(JSON.stringify(body)).not.toContain("C03X72119");
  });

  it("rejects an invalid person payload", async () => {
    expect((await postJson("/api/people", { dob: "2018-04-02" })).status).toBe(400);
  });

  it("returns a per-person itinerary", async () => {
    const person = (await (await postJson("/api/people", { displayName: "Ava" })).json()) as { id: string };
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as { id: string };
    const booking = (await (await postJson(`/api/trips/${trip.id}/bookings`, {
      kind: "other", title: "Rehearsal dinner", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "America/Los_Angeles", details: {},
    })).json()) as { id: string };
    expect((await request(app, `/api/bookings/${booking.id}/people/${person.id}`, { method: "PUT" })).status).toBe(204);
    const days = (await (await request(app, `/api/trips/${trip.id}/itinerary?personId=${person.id}`)).json()) as { date: string }[];
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe("2026-10-09");
  });

  it("returns 401 when authentication fails", async () => {
    const unauthed = appAs(async () => { throw new AuthError("nope"); });
    expect((await request(unauthed, "/api/people")).status).toBe(401);
  });

  it("returns 403 when a viewer attempts a write", async () => {
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const res = await request(viewerApp, "/api/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Nope" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 for a resource outside the caller's household", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const res = await request(app, `/api/trips/${trip.id}/people/does-not-exist`, { method: "PUT" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed request body", async () => {
    expect((await postJson("/api/trips", { title: "" })).status).toBe(400);
  });

  it("reveals a document only on the explicit endpoint", async () => {
    const person = (await (await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).json()) as { id: string };
    const res = await request(app, `/api/people/${person.id}/reveal/passport_number`);
    expect(await res.json()).toEqual({ value: "C03X72119" });
  });

  it("rejects revealing a field that is not a document", async () => {
    expect((await request(app, "/api/people/whatever/reveal/display_name")).status).toBe(400);
  });

  it("rejects a booking with an unpaired timezone", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "No tz", startsAt: "2026-10-10T02:00:00Z", details: {} });
    expect(res.status).toBe(400);
  });

  it("masks booking confirmations in lists and reveals them on request", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const booking = (await (await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} })).json()) as { id: string };
    const listed = await (await request(app, `/api/trips/${trip.id}/bookings`)).json();
    expect(JSON.stringify(listed)).not.toContain("ABCDX4T2");
    expect(JSON.stringify(listed)).toContain("••••X4T2");
    const revealed = await (await request(app, `/api/trips/${trip.id}/bookings/${booking.id}/reveal`)).json();
    expect(revealed).toEqual({ value: "ABCDX4T2" });
  });

  describe("C1: booking timestamp/timezone validation", () => {
    it("rejects an unparseable startsAt with 400", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Bad ts", startsAt: "garbage", startsAtTz: "America/Boise", details: {} });
      expect(res.status).toBe(400);
    });
    it("rejects an unrecognized startsAtTz with 400", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Bad tz", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "Not/AZone", details: {} });
      expect(res.status).toBe(400);
    });
  });

  it("rejects a booking with an unrecognized kind", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "banana", title: "Bad kind", details: {} });
    expect(res.status).toBe(400);
  });

  describe("I2: every route's errors are JSON-mapped", () => {
    it("GET /api/trips/:tripId/bookings for an unknown trip is a JSON 404", async () => {
      const res = await request(app, "/api/trips/does-not-exist/bookings");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    });
    it("GET /api/people/:id/reveal/:field for an unknown person is a JSON 404", async () => {
      const res = await request(app, "/api/people/does-not-exist/reveal/passport_number");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    });
  });

  describe("I3: reveal endpoints reject a viewer", () => {
    it("rejects a viewer revealing a document with 403", async () => {
      const person = (await (await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      expect((await request(viewerApp, `/api/people/${person.id}/reveal/passport_number`)).status).toBe(403);
    });
    it("rejects a viewer revealing a booking confirmation with 403", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const booking = (await (await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      expect((await request(viewerApp, `/api/trips/${trip.id}/bookings/${booking.id}/reveal`)).status).toBe(403);
    });
  });

  describe("I5: reveal and list distinguish missing from empty", () => {
    it("404s revealing a document for a person that does not exist", async () => {
      expect((await request(app, "/api/people/does-not-exist/reveal/passport_number")).status).toBe(404);
    });
    it("404s revealing a confirmation for a booking that does not exist", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      expect((await request(app, `/api/trips/${trip.id}/bookings/does-not-exist/reveal`)).status).toBe(404);
    });
    it("404s listing bookings for a trip that does not exist", async () => {
      expect((await request(app, "/api/trips/does-not-exist/bookings")).status).toBe(404);
    });
  });

  it("returns the caller's identity from /api/me", async () => {
    const body = (await (await request(app, "/api/me")).json()) as typeof identity;
    expect(body).toEqual({ userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" });
  });

  describe("GET /api/trips/:tripId/rollup", () => {
    it("wires bookings and drafts through to the rollup", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Booked", costCents: 20000, status: "booked", details: {} });
      await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Draft", costCents: 50000, status: "draft", details: {} });
      const res = await request(app, `/api/trips/${trip.id}/rollup`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { totalCents: number; draftCount: number };
      expect(body.totalCents).toBe(20000);
      expect(body.draftCount).toBe(1);
    });
    it("404s for a trip that does not exist", async () => {
      const res = await request(app, "/api/trips/does-not-exist/rollup");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    });
    it("404s for a trip belonging to another household", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const otherApp = appAs({ ...identity, householdId: "hh-b" });
      expect((await request(otherApp, `/api/trips/${trip.id}/rollup`)).status).toBe(404);
    });
  });

  describe("/api/checklist", () => {
    it("wires creation and cross-trip listing", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const createRes = await postJson("/api/checklist", { tripId: trip.id, label: "Pack passports" });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; label: string };
      expect(created.label).toBe("Pack passports");
      const listed = (await (await request(app, "/api/checklist")).json()) as { id: string }[];
      expect(listed.map((i) => i.id)).toContain(created.id);
    });
    it("rejects a malformed JSON body on create with 400", async () => {
      const res = await request(app, "/api/checklist", { method: "POST", headers: { "content-type": "application/json" }, body: "{ not json" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    });
    it("rejects a checklist item for a trip that does not exist with 404", async () => {
      expect((await postJson("/api/checklist", { tripId: "does-not-exist", label: "Pack passports" })).status).toBe(404);
    });
    it("rejects a viewer creating a checklist item with 403", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      const res = await request(viewerApp, "/api/checklist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tripId: trip.id, label: "Pack passports" }) });
      expect(res.status).toBe(403);
    });
    it("rejects an invalid create payload with 400", async () => {
      expect((await postJson("/api/checklist", { tripId: "t1" })).status).toBe(400);
    });
    it("wires setDone through to the item", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const created = (await (await postJson("/api/checklist", { tripId: trip.id, label: "Pack passports" })).json()) as { id: string };
      const res = await request(app, `/api/checklist/${created.id}/done`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
      expect(res.status).toBe(204);
      const listed = (await (await request(app, "/api/checklist")).json()) as { id: string; doneAt: string | null }[];
      expect(listed.find((i) => i.id === created.id)?.doneAt).not.toBeNull();
    });
    it("rejects a malformed JSON body on setDone with 400", async () => {
      const res = await request(app, "/api/checklist/whatever/done", { method: "PUT", headers: { "content-type": "application/json" }, body: "{ not json" });
      expect(res.status).toBe(400);
    });
    it("rejects a setDone body that is not { done: boolean } with 400", async () => {
      const res = await request(app, "/api/checklist/whatever/done", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: "yes" }) });
      expect(res.status).toBe(400);
    });
    it("404s setDone for an item that does not exist", async () => {
      const res = await request(app, "/api/checklist/does-not-exist/done", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
      expect(res.status).toBe(404);
    });
    it("rejects a viewer toggling a checklist item with 403", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const created = (await (await postJson("/api/checklist", { tripId: trip.id, label: "Pack passports" })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      const res = await request(viewerApp, `/api/checklist/${created.id}/done`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
      expect(res.status).toBe(403);
    });
  });

  it("lists a trip's travelers with documents still masked", async () => {
    const person = (await (await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).json()) as { id: string };
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as { id: string };
    expect((await request(app, `/api/trips/${trip.id}/people/${person.id}`, { method: "PUT" })).status).toBe(204);
    const res = await request(app, `/api/trips/${trip.id}/travelers`);
    const body = (await res.json()) as { id: string; displayName: string }[];
    expect(body.map((p) => p.displayName)).toEqual(["Ava"]);
    expect(JSON.stringify(body)).not.toContain("C03X72119");
  });
});
```

- [ ] **Step 9: Rewrite `tests/server/routes/booking-status.test.ts`**

Replace the file entirely. 7 `it` blocks.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({ verify: (async () => who) as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}
let app: ReturnType<typeof createApp>;
function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function jsonRequest(path: string, method: string, body: unknown) {
  return request(app, path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function makeBooking(status: string): Promise<{ tripId: string; bookingId: string }> {
  const trip = (await (await jsonRequest("/api/trips", "POST", { title: "Guerneville" })).json()) as { id: string };
  const booking = (await (await jsonRequest(`/api/trips/${trip.id}/bookings`, "POST", { kind: "lodging", title: "Dawn Ranch Lodge", status, details: { propertyName: "Dawn Ranch Lodge" } })).json()) as { id: string };
  return { tripId: trip.id, bookingId: booking.id };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", new Date().toISOString()).run();
  app = appAs(owner);
});

describe("PUT /api/bookings/:bookingId/status", () => {
  it("promotes a planned booking to booked", async () => {
    const { tripId, bookingId } = await makeBooking("planned");
    expect((await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", { status: "booked" })).status).toBe(204);
    const list = (await (await request(app, `/api/trips/${tripId}/bookings`)).json()) as { id: string; status: string }[];
    expect(list.find((b) => b.id === bookingId)?.status).toBe("booked");
  });
  it("promotes a draft booking out of draft", async () => {
    const { tripId, bookingId } = await makeBooking("draft");
    expect((await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", { status: "planned" })).status).toBe(204);
    const list = (await (await request(app, `/api/trips/${tripId}/bookings`)).json()) as { status: string }[];
    expect(list[0]?.status).toBe("planned");
  });
  it("answers 404 for an unknown booking", async () => {
    expect((await jsonRequest("/api/bookings/b-nope/status", "PUT", { status: "booked" })).status).toBe(404);
  });
  it("answers 404 for another household's booking", async () => {
    const { bookingId } = await makeBooking("planned");
    const otherApp = appAs({ ...owner, householdId: "hh-b" });
    const res = await request(otherApp, `/api/bookings/${bookingId}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "booked" }) });
    expect(res.status).toBe(404);
  });
  it("answers 400 for a status outside the enum", async () => {
    const { bookingId } = await makeBooking("planned");
    expect((await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", { status: "confirmed" })).status).toBe(400);
  });
  it("answers 400 for malformed JSON", async () => {
    const { bookingId } = await makeBooking("planned");
    const res = await request(app, `/api/bookings/${bookingId}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
  });
  it("answers 403 for a viewer", async () => {
    const { bookingId } = await makeBooking("planned");
    const viewerApp = appAs({ ...owner, role: "viewer" });
    const res = await request(viewerApp, `/api/bookings/${bookingId}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "booked" }) });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 10: Rewrite `tests/server/routes/people-update.test.ts`**

Replace the file entirely. 8 `it` blocks.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({ verify: (async () => who) as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}
let app: ReturnType<typeof createApp>;
function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function jsonRequest(path: string, method: string, body: unknown) {
  return request(app, path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function createAva(): Promise<string> {
  const res = await jsonRequest("/api/people", "POST", { displayName: "Ava", passportNumber: "C03X72119" });
  return ((await res.json()) as { id: string }).id;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", new Date().toISOString()).run();
  app = appAs(owner);
});

describe("PUT /api/people/:id", () => {
  it("updates a name and returns the masked person", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "Ava Wright" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; passportNumberMasked: string };
    expect(body.displayName).toBe("Ava Wright");
    expect(body.passportNumberMasked).toBe("••••2119");
  });
  it("does not disturb the passport when the field is omitted", async () => {
    const id = await createAva();
    await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "Ava Wright" });
    const revealed = (await (await request(app, `/api/people/${id}/reveal/passport_number`)).json()) as { value: string };
    expect(revealed.value).toBe("C03X72119");
  });
  it("answers 400 for a masked passport value and leaves the stored one intact", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { passportNumber: "••••2119" });
    expect(res.status).toBe(400);
    const revealed = (await (await request(app, `/api/people/${id}/reveal/passport_number`)).json()) as { value: string };
    expect(revealed.value).toBe("C03X72119");
  });
  it("clears a document field on an explicit null", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { passportNumber: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { passportNumberMasked: string | null }).passportNumberMasked).toBe(null);
  });
  it("answers 404 for an unknown person", async () => {
    expect((await jsonRequest("/api/people/p-nope", "PUT", { displayName: "X" })).status).toBe(404);
  });
  it("answers 400 for malformed JSON", async () => {
    const id = await createAva();
    const res = await request(app, `/api/people/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });
  it("answers 400 for an empty display name", async () => {
    const id = await createAva();
    expect((await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "" })).status).toBe(400);
  });
  it("answers 403 for a viewer", async () => {
    const id = await createAva();
    const viewerApp = appAs({ ...owner, role: "viewer" });
    const res = await request(viewerApp, `/api/people/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Nope" }) });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 11: Keep the architecture test running under a node config**

The architecture test uses `node:fs` to scan `src/server` for raw `.prepare(`/`.exec(` outside the allowlist — it cannot run in workerd. Exclude it from the pool and run it under a small node config.

Add the exclude to `vitest.config.ts` `test` block:

```ts
  test: {
    include: ["tests/server/**/*.test.ts"],
    exclude: ["tests/server/architecture.test.ts", "node_modules/**"],
    setupFiles: ["./tests/server/apply-migrations.ts"],
  },
```

Create `vitest.arch.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/server/architecture.test.ts"],
    environment: "node",
  },
});
```

`tests/server/architecture.test.ts` is otherwise unchanged: its allowlist (`repos/`, `db/`, `auth.ts`) still holds — `index.ts`, `routes/*`, and `worker.ts` contain no `.prepare(`/`.exec(`. Note: `db/` will be empty after the deletions below, which is fine (the allowlist prefix simply matches nothing).

- [ ] **Step 12: Delete the old `node:sqlite` server, ingest, and their tests**

```bash
git rm src/server/db/connection.ts src/server/db/migrate.ts
git rm -r src/server/db/migrations
git rm src/server/serve.ts
git rm src/server/repos/inbound-email.ts src/server/routes/inbound-email.ts
git rm -r src/server/ingest
git rm tests/server/db/migrate.test.ts tests/server/serve.test.ts
git rm tests/server/repos/inbound-email.test.ts tests/server/routes/inbound-email.test.ts
git rm -r tests/server/ingest
```

(If any of the ingest test paths differ, adjust — the goal is: no test or source file imports `node:sqlite`, `@hono/node-server`, `@anthropic-ai/sdk`, or the ingest modules.)

- [ ] **Step 13: Remove obsolete `package.json` dependencies and finalize the server tsconfig**

In `package.json` remove from `dependencies`: `@anthropic-ai/sdk`, `@hono/node-server`. Remove from `devDependencies`: `tsx`. Then:

```bash
nix develop -c npm install
```

In `tsconfig.server.json`, drop `node` from `types` now that no server source imports `node:*` (leaving `["@cloudflare/workers-types"]`).

- [ ] **Step 14: Run the whole suite, both configs, and typecheck**

```bash
nix develop -c npm test
nix develop -c npx vitest run -c vitest.arch.config.ts
nix develop -c npm run test:client
nix develop -c npm run typecheck
```

Expected: the pool suite is green (smoke 2, schema 2, envelope 18, base 22, base-adversarial 18, person 10, trip 6, booking 7, itinerary 4, checklist 6, rollup 4, auth 8, errors 8, api 36, booking-status 7, people-update 8); the arch test is green (1); the client suite is unchanged and green; typecheck is clean. Update `package.json` `test:all` to include the arch config:

```json
    "test:all": "npm test && npx vitest run -c vitest.arch.config.ts && npm run test:client",
```

- [ ] **Step 15: Manual check — `wrangler dev` serves `/api/me` (documented)**

This is a manual verification (needs a local D1 and a dev identity), not an automated test:

```bash
# Apply migrations to the local dev D1, set a dev key, and run:
nix develop -c npx wrangler d1 migrations apply travel-hq-dev --local
TRAVEL_HQ_ENV=development TRAVEL_HQ_DEV_EMAIL=you@example.com \
  ENCRYPTION_KEY="dev-v1 $(head -c32 /dev/urandom | base64)" \
  nix develop -c npx wrangler dev
# In another shell (after seeding a household_member row for you@example.com):
curl -s http://127.0.0.1:8787/api/me
```

Expected: a JSON `Identity` for the dev email once a matching `household_member` row exists, or a 401 `{"error":"Unauthorized"}` if not. `/healthz` returns `ok`.

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "feat(cf): port routes + Worker entry to async D1, delete node:sqlite server"
```

---

## Self-Review (against the spec)

**Spec coverage** — every non-deferred section maps to a task:

- *Tenancy binding on D1 (security-critical)* → Task 4 (`{scope}` → `household_id = ?1`, `?1` reserved, `bind(householdId, ...callerParams)`, all shape guards + two new `?1` guards, ported 18-attack adversarial suite, CONTROLLER GATE).
- *Database — D1 + wrangler migrations* → Tasks 1–2 (`migrations/0001_initial.sql`, `ON DELETE CASCADE` kept, no `PRAGMA foreign_keys`, wrangler-tracked migrations).
- *Repositories synchronous → async* → Tasks 4–6 (every method `async`, `await`s D1 via `.all()`/`.first()`/`.run()`).
- *Crypto — WebCrypto envelope* → Task 3 (`crypto.subtle`, `v1.<key_id>.<iv>.<ct+tag>`, key from secret, `mask`/`assertNotMasked` unchanged, key-id rotation kept).
- *Auth — Access on Workers, machine path dissolves* → Task 7 (`jose` unchanged in behaviour, async D1 membership; `createServiceTokenVerifier`/`householdExists`/machine role dropped; `resolveVerifier(env)` dev bypass).
- *Entry — Worker `fetch`* → Task 8 (`worker.ts` exports `{ fetch: app.fetch }`; `email` handler explicitly deferred to Plan C).
- *Tests — `vitest-pool-workers` + local D1* → Task 1 (`cloudflareTest` + `readD1Migrations`/`applyD1Migrations`); the raw-SQL architecture test re-run under a node config (Task 8).

**Deferred, correctly absent:** `inbound_email` table/repo/routes, `/import` UI, `machine` role, `requireIngestWrite`, `insert()` guard parameter, service-token verifier, Workers AI extractor, `email()` handler, `household_settings`, static hosting (Plan B), CI/CD + email forwarding (Plan C). The client is not modified in Plan A.

**Placeholder scan:** every code step contains complete, ported code — no "similar to Task N", no "add error handling", no TODO.

**Type/signature consistency (checked across tasks):**
- `Keyring(activeKeyId: string, keys: Record<string, Uint8Array>)`, async `encrypt`/`decrypt` — consistent in Tasks 3, 5, 6, 8.
- `TenantRepo(db: D1Database, ctx)`; async `all`/`get`/`run`/`insert`/`unscoped`/`unscopedRun` — consistent in Tasks 4–6.
- `createApp(overrides?: { verify?: (req, env) => Promise<Identity>; ring?: Keyring })` returning `Hono<AppEnv>`; `AppBindings`/`AppEnv` exported from `index.ts` — consistent in Task 8 tests.
- `resolveVerifier(env: WorkerAuthEnv)` in `auth.ts`, consumed by `index.ts` `verifierFor` — consistent (Tasks 7, 8).
- `toBooking`/`openConfirmation` async; `BookingRepo`/`ItineraryRepo` methods async — consistent (Task 6).
- Scoped queries use explicit `?2`, `?3` throughout; `unscoped()` join-table queries keep anonymous `?` (no `{scope}`, no `?1` reservation) — consistent.

**Test counts (sum of `it` blocks written):** smoke 2, schema 2, envelope 18, base 22, base-adversarial 18, person 10, trip 6, booking 7, itinerary 4, checklist 6, rollup 4, auth 8, errors 8 (unchanged), api 36, booking-status 7, people-update 8, architecture 1.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-cloudflare-plan-a-server-replatform.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Note the **CONTROLLER GATE after Task 4**: an independent adversarial review of the tenancy re-bind must clear before Tasks 5–8 begin.

**2. Inline Execution** — execute tasks in this session with checkpoints.
