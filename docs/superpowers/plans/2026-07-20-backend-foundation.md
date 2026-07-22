# Travel HQ Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tenant-scoped data layer, encryption, and HTTP API that the Travel HQ family redesign runs on, with no UI changes beyond deleting business-spend content.

**Architecture:** A Node 22 + Hono server backed by SQLite. All domain data access goes through a repository layer constructed with a household context, which injects the tenancy filter so it cannot be forgotten. Sensitive document numbers are encrypted with AES-256-GCM into a self-describing envelope that carries its own key id, so key strategy can change incrementally later. Cloudflare Access authenticates at the edge; the server validates the JWT it forwards.

**Tech Stack:** Node 22, TypeScript 5.7, Hono, `node:sqlite`, Zod, `jose`, `uuid`, Vitest.

## Global Constraints

- **Node 22+ required.** `node:sqlite` is experimental in Node 22 and the server must be run with `--experimental-sqlite`. If this proves troublesome under systemd, the documented fallback is `better-sqlite3` (mature, but a native module, which means extra Nix packaging work). Do not silently switch — raise it.
- **No ORM.** Hand-written SQL through `node:sqlite` prepared statements.
- **Every table holding tenant-owned entity rows carries `household_id`.** No exception. Pure join tables that only associate two already-scoped entities (`trip_person`, `booking_person`) carry no `household_id` of their own — they are scoped through their parent entity's join instead (see `TripRepo.travelers` and `ItineraryRepo`). `user` is a global table, not a tenant-owned one, and is intentionally not scoped by household.
- **No exported function may run a raw query against a domain table.** Domain access goes through a repository bound to a household. Exception: `createAccessVerifier`'s returned `verify()` (Task 10) raw-queries `user` and `household_member` directly — this is a documented bootstrap exception, since a request cannot be scoped to a household until authentication has resolved which household it belongs to.
- **IDs are UUIDv7**, never autoincrement integers.
- **Timestamps are stored as UTC ISO-8601 strings, always paired with an IANA timezone column** (`starts_at` / `starts_at_tz`). Never store a naive local time.
- **Encrypted values are never returned in plaintext from list endpoints.** Masked by default; reveal is a separate single-record call and is logged.
- **Business-spend and business-card content is permanently out of scope.**
- Tests use Vitest. Every task ends with a commit.

---

## File Structure

Current state: `src/main.tsx` is the entire app (~430 lines, all data hardcoded). This plan introduces a server alongside it and does not restructure the client beyond deleting business content.

```
src/
  client/                     ← existing frontend moves here (Task 2)
    main.tsx
    styles.css
  server/
    index.ts                  ← Hono app entry, binds 127.0.0.1
    auth.ts                   ← THE auth boundary: request → identity
    db/
      connection.ts           ← opens SQLite, applies pragmas
      migrate.ts              ← migration runner
      migrations/
        001_initial.sql
    crypto/
      envelope.ts             ← AES-256-GCM encrypt/decrypt + key registry
    ids.ts                    ← UUIDv7 generation
    repos/
      base.ts                 ← tenant-scoped repository base
      confirmation.ts         ← shared confirmation unsealer
      person.ts
      trip.ts
      booking.ts
      itinerary.ts            ← per-person day view query
    schemas/
      booking-kinds.ts        ← Zod schema per booking kind
    routes/
      people.ts
      trips.ts
      itinerary.ts
tests/
  server/…                    ← mirrors src/server
```

Rationale for the split: `repos/` holds the tenancy guarantee and is the security-critical surface, so it stays small and separately testable. `crypto/envelope.ts` is isolated because its format is a migration contract. `auth.ts` is deliberately one file — the spec requires swapping Access for OAuth later to touch nothing else.

---

### Task 1: Remove business-spend content

Satisfies success criterion 7. Independent of everything else; do it first to clear the deck.

**Files:**
- Modify: `src/main.tsx`
- Modify: `README.md`

- [ ] **Step 1: Delete the business category**

In `src/main.tsx`, the `categories` array currently ends:

```tsx
  { id: "dining", label: "Dining", icon: CircleDollarSign },
  { id: "business", label: "Business spend", icon: Building2 },
  { id: "general", label: "General purchase", icon: CreditCard }
```

Remove the `business` line so it reads:

```tsx
  { id: "dining", label: "Dining", icon: CircleDollarSign },
  { id: "general", label: "General purchase", icon: CreditCard }
```

- [ ] **Step 2: Delete the business recommendation**

Remove this entire entry from the `recommendations` object:

```tsx
  business: {
    card: "Ink Business Preferred",
    why: "Future add: separate company expenses and capture software, cloud, telecom, shipping, and advertising spend.",
    earn: "Business Ultimate Rewards"
  },
```

- [ ] **Step 3: Delete the business action-queue row**

In the action queue JSX, remove:

```tsx
                  ["Add business card later", "After recurring spend is established", "Low"],
```

- [ ] **Step 4: Remove the now-unused import**

`Building2` is imported from `lucide-react` at the top of the file and is no longer referenced. Delete that line from the import block.

- [ ] **Step 5: Update README**

Remove the bullet `- Personal and future business-card strategy` from the feature list, and the line `- Business cards are modeled as a future expansion` from "Current design assumptions".

- [ ] **Step 6: Verify no references remain**

Run: `grep -rn -i "business\|Building2" src/ README.md`
Expected: no output.

- [ ] **Step 7: Verify the app still builds**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/main.tsx README.md
git commit -m "refactor: remove business-spend and business-card content"
```

---

### Task 2: Restructure into client/server and add the test runner

**Files:**
- Move: `src/main.tsx` → `src/client/main.tsx`
- Move: `src/styles.css` → `src/client/styles.css`
- Modify: `index.html`
- Modify: `package.json`
- Modify: `tsconfig.app.json`
- Create: `tsconfig.server.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: an `npm test` command that runs Vitest against `tests/`. Later tasks assume it exists. Actually running the server is deferred to the deployment plan: Node's strip-only TypeScript execution cannot rewrite `.js` import specifiers to `.ts` or handle constructor parameter properties, so a bare `node src/server/index.ts` does not work on this codebase, and no `dev:server`-style script is produced here.

- [ ] **Step 1: Move the client files**

```bash
mkdir -p src/client src/server tests/server
git mv src/main.tsx src/client/main.tsx
git mv src/styles.css src/client/styles.css
```

- [ ] **Step 2: Fix the entry point in index.html**

Change the script tag's `src` from `/src/main.tsx` to `/src/client/main.tsx`.

- [ ] **Step 3: Install server dependencies**

```bash
npm install hono zod jose uuid
npm install -D vitest @types/node@22
```

- [ ] **Step 4: Create the server TypeScript config**

Create `tsconfig.server.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/server/**/*.ts", "tests/**/*.ts"]
}
```

`noUncheckedIndexedAccess` is deliberate — SQLite row access is index-based and this catches a whole class of undefined bugs.

- [ ] **Step 5: Restrict the client TypeScript config to client sources**

`tsconfig.app.json` currently has `"include": ["src"]`. Once `src/server/` exists, the client build would typecheck server code under the client config — DOM lib, no `noUncheckedIndexedAccess`, no `verbatimModuleSyntax` — so `npm run build` would start failing on server type errors, and the client build would start depending on `@types/node`.

In `tsconfig.app.json`, change:

```json
  "include": ["src"]
```

to:

```json
  "include": ["src/client"]
```

- [ ] **Step 6: Create the Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
  },
});
```

`pool: "forks"` because `node:sqlite` needs the `--experimental-sqlite` flag applied per-process.

- [ ] **Step 7: Add scripts to package.json**

Add to the `scripts` block:

```json
    "test": "NODE_OPTIONS=--experimental-sqlite vitest run",
    "test:watch": "NODE_OPTIONS=--experimental-sqlite vitest",
    "typecheck": "tsc -b && tsc -p tsconfig.server.json"
```

- [ ] **Step 8: Write a smoke test proving the harness works**

Create `tests/server/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

describe("test harness", () => {
  it("can open an in-memory SQLite database", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO t (id) VALUES (?)").run("abc");
    const row = db.prepare("SELECT id FROM t").get() as { id: string };
    expect(row.id).toBe("abc");
    db.close();
  });
});
```

- [ ] **Step 9: Run the smoke test**

Run: `npm test`
Expected: PASS, 1 test. If it fails with `Cannot find module 'node:sqlite'`, the Node version predates `node:sqlite` (added in 22.5.0) — stop and resolve that before continuing. On a current Node 22.x, `node:sqlite` loads even without `--experimental-sqlite` (it just emits a warning); the flag is kept here for forward compatibility, not because it's required.

- [ ] **Step 10: Verify the client still builds after the move**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: split client/server, add vitest harness"
```

---

### Task 3: Migration runner and initial schema

**Files:**
- Create: `src/server/db/connection.ts`
- Create: `src/server/db/migrate.ts`
- Create: `src/server/db/migrations/001_initial.sql`
- Test: `tests/server/db/migrate.test.ts`

**Interfaces:**
- Produces:
  - `openDatabase(path: string): DatabaseSync` — opens with WAL and foreign keys on
  - `migrate(db: DatabaseSync): void` — applies pending migrations idempotently
  - `createTestDatabase(): DatabaseSync` — in-memory, migrated, for tests. Every later test uses this.

- [ ] **Step 1: Write the failing test**

Create `tests/server/db/migrate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestDatabase, migrate } from "../../../src/server/db/migrate.js";

describe("migrate", () => {
  it("creates all domain tables", () => {
    const db = createTestDatabase();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);

    for (const table of [
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
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDatabase();
    const before = db.prepare("SELECT COUNT(*) AS n FROM schema_migration").get() as { n: number };
    expect(before.n).toBeGreaterThan(0);

    expect(() => migrate(db)).not.toThrow();

    const after = db.prepare("SELECT COUNT(*) AS n FROM schema_migration").get() as { n: number };
    expect(after.n).toBe(before.n);
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = createTestDatabase();
    expect(() =>
      db
        .prepare("INSERT INTO person (id, household_id, display_name) VALUES (?, ?, ?)")
        .run("p1", "nonexistent-household", "Ghost"),
    ).toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- migrate`
Expected: FAIL — cannot resolve `src/server/db/migrate.js`.

- [ ] **Step 3: Write the schema**

Create `src/server/db/migrations/001_initial.sql`:

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

Note: `person_id` on `checklist_item` is nullable — NULL means a family-wide task.

- [ ] **Step 4: Write the connection module**

Create `src/server/db/connection.ts`:

```ts
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
```

`foreign_keys = ON` is required — SQLite ignores foreign keys by default, which would silently defeat the cascade deletes the tenancy model relies on.

- [ ] **Step 5: Write the migration runner**

Create `src/server/db/migrate.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./connection.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migration").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${String(err)}`);
    }
  }
}

export function createTestDatabase(): DatabaseSync {
  // Note: PRAGMA journal_mode = WAL silently no-ops on a :memory: database
  // (journal_mode stays "memory"). Tests built on this never exercise the
  // production WAL pragma — don't assume they cover WAL behavior.
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- migrate`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/db tests/server/db
git commit -m "feat: add migration runner and initial schema"
```

---

### Task 4: ID generation and the encryption envelope

**Files:**
- Create: `src/server/ids.ts`
- Create: `src/server/crypto/envelope.ts`
- Test: `tests/server/crypto/envelope.test.ts`

**Interfaces:**
- Produces:
  - `newId(): string` — UUIDv7
  - `class Keyring` with `encrypt(plaintext): string` and `decrypt(envelope): string`
  - `mask(plaintext: string | null): string | null`
  - `loadKeyring(keyFilePath: string): Keyring`

**Design note — deviation from the spec, deliberate:** the spec called for a `key_id` *column* beside every encrypted value. That would mean three extra columns on `person` alone. Instead the key id is packed into the ciphertext string itself: `v1.<key_id>.<iv_b64>.<tag_b64>.<ct_b64>`. This is self-describing, adds no columns, and preserves the property that actually mattered — rows encrypted under different keys can coexist, so a key migration is incremental rather than all-or-nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/server/crypto/envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Keyring, mask } from "../../../src/server/crypto/envelope.js";

const key = randomBytes(32);
const ring = new Keyring("server-v1", { "server-v1": key });

describe("envelope", () => {
  it("round-trips a value", () => {
    const env = ring.encrypt("C03X72119");
    expect(ring.decrypt(env)).toBe("C03X72119");
  });

  it("produces different ciphertext for the same plaintext", () => {
    expect(ring.encrypt("same")).not.toBe(ring.encrypt("same"));
  });

  it("tags the envelope with the key id", () => {
    expect(ring.encrypt("x").startsWith("v1.server-v1.")).toBe(true);
  });

  it("can decrypt under an older key after rotation", () => {
    const oldEnv = ring.encrypt("legacy");
    const rotated = new Keyring("server-v2", {
      "server-v1": key,
      "server-v2": randomBytes(32),
    });
    expect(rotated.decrypt(oldEnv)).toBe("legacy");
    expect(rotated.encrypt("new").startsWith("v1.server-v2.")).toBe(true);
  });

  it("rejects a tampered envelope", () => {
    const env = ring.encrypt("secret");
    const parts = env.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => ring.decrypt(parts.join("."))).toThrow();
  });

  it("throws on an unknown key id", () => {
    expect(() => ring.decrypt("v1.nope.AAAA.BBBB.CCCC")).toThrow(/unknown key/i);
  });

  it("masks to the last four characters", () => {
    expect(mask("1234")).toBe("••••1234");
    expect(mask(null)).toBe(null);
    expect(mask("ab")).toBe("••••ab");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- envelope`
Expected: FAIL — cannot resolve `src/server/crypto/envelope.js`.

- [ ] **Step 3: Write the ID module**

Create `src/server/ids.ts`:

```ts
import { v7 as uuidv7 } from "uuid";

export function newId(): string {
  return uuidv7();
}
```

UUIDv7 rather than autoincrement: still time-sortable so index locality is preserved, but not enumerable, so `/api/trips/1` → `/api/trips/2` is not an attack.

- [ ] **Step 4: Write the envelope module**

Create `src/server/crypto/envelope.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const FORMAT = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export class Keyring {
  constructor(
    private readonly activeKeyId: string,
    private readonly keys: Record<string, Buffer>,
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

  encrypt(plaintext: string): string {
    const key = this.keys[this.activeKeyId]!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT,
      this.activeKeyId,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ct.toString("base64url"),
    ].join(".");
  }

  decrypt(envelope: string): string {
    const parts = envelope.split(".");
    if (parts.length !== 5 || parts[0] !== FORMAT) {
      throw new Error("Malformed encryption envelope");
    }
    const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
    const key = this.keys[keyId];
    if (!key) {
      throw new Error(`Cannot decrypt: unknown key id "${keyId}"`);
    }
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

/** Mask a plaintext value for display. Never pass an envelope to this. */
export function mask(plaintext: string | null): string | null {
  if (plaintext === null) return null;
  return `••••${plaintext.slice(-4)}`;
}

/**
 * Load the keyring from disk. The key file is agenix-managed and contains
 * base64 keys, one per line, as `<key_id> <base64-32-bytes>`. The last line
 * listed is the active key.
 */
export function loadKeyring(keyFilePath: string): Keyring {
  const lines = readFileSync(keyFilePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) {
    throw new Error(`Key file ${keyFilePath} contains no keys`);
  }

  const keys: Record<string, Buffer> = {};
  let activeKeyId = "";
  for (const line of lines) {
    const [id, b64] = line.split(/\s+/);
    if (!id || !b64) throw new Error(`Malformed key line in ${keyFilePath}`);
    keys[id] = Buffer.from(b64, "base64");
    activeKeyId = id;
  }
  return new Keyring(activeKeyId, keys);
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- envelope`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/ids.ts src/server/crypto tests/server/crypto
git commit -m "feat: add UUIDv7 ids and AES-256-GCM encryption envelope"
```

---

### Task 5: Tenant-scoped repository base

This is the security-critical task. Everything else depends on getting it right.

> **⚠️ SUPERSEDED — do not transcribe the code below.**
>
> The implementation shown in this task was found to be **exploitable** by an
> adversarial review after it was written, and was hardened in commit
> `61e4c2a`. **`src/server/repos/base.ts` is authoritative; this task text is
> retained only as the historical record of how it was originally specified.**
>
> The code below has these defects, all demonstrated working:
>
> 1. **Critical, fails open.** `scopeQuery` picks the bind position by counting
>    `?` characters before the token. The count is wrong when a `?` appears in a
>    string literal, a `--` or `/* */` comment, a quoted identifier, or a
>    `LIKE '%?%'` — and a miscount hands the tenancy predicate itself to
>    caller-controlled input, silently. The fix binds the household id as a
>    **named** parameter (`(household_id = :__scope_household)`, object passed as
>    the first argument) so nothing is counted at all.
> 2. **Critical.** `{scope}` expands to a bare `household_id = ?`, so a caller's
>    `OR` binds looser and swallows it: `WHERE {scope} OR 1=1` returns every
>    household's rows. Parenthesizing alone does **not** fix this — the hardened
>    version adds a depth-aware scanner that rejects `OR`/`UNION`/`EXCEPT`/
>    `INTERSECT` at or above the token's paren depth, and rejects a `{scope}`
>    token hidden inside a comment or string literal.
> 3. **Important.** `requireWrite()` is defined but never called by `run()` or
>    `insert()`, so a `viewer` can write. It is now enforced in the base class.
> 4. **Important.** `this.db` is `protected`, an ungoverned bypass. It is now
>    `private`, with `unscoped(reason, …)` / `unscopedRun(reason, …)` accessors
>    that require a written justification.
> 5. **Important.** Thrown messages interpolated the full SQL, including the
>    `passport_number` / `redress_number` column names, and Task 11 returned them
>    to clients. SQL is now logged, never thrown, and the error type is split into
>    `TenantScopeError` (500) / `ForbiddenError` (403) / `NotFoundError` (404).
>
> Tasks 6-11 below were amended in `ca43697` to match the hardened class.
> `tests/server/repos/base-adversarial.test.ts` pins all of the above.

**Files:**
- Create: `src/server/repos/base.ts`
- Test: `tests/server/repos/base.test.ts`

**Interfaces:**
- Produces:
  - `type Role = "owner" | "adult" | "viewer"`
  - `type HouseholdContext = { householdId: string; userId: string; role: Role }`
  - `abstract class TenantRepo` with protected `all<T>()`, `get<T>()`, `run()`, `insert()`, `requireWrite()`
  - `class TenantScopeError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/server/repos/base.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { TenantRepo, TenantScopeError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

class TripProbe extends TenantRepo {
  listTitles(): string[] {
    return this.all<{ title: string }>("SELECT title FROM trip WHERE {scope}").map(
      (r) => r.title,
    );
  }
  listUnscoped(): unknown[] {
    return this.all("SELECT title FROM trip");
  }
  rename(id: string, title: string): void {
    this.run("UPDATE trip SET title = ? WHERE {scope} AND id = ?", title, id);
  }
}

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

let db: DatabaseSync;

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(id, id, now);
  }
  db.prepare(
    "INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)",
  ).run("t1", "hh-a", "Guerneville", now);
  db.prepare(
    "INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)",
  ).run("t2", "hh-b", "Someone Else's Trip", now);
});

describe("TenantRepo", () => {
  it("returns only the current household's rows", () => {
    expect(new TripProbe(db, ctxA).listTitles()).toEqual(["Guerneville"]);
  });

  it("isolates a different household", () => {
    expect(new TripProbe(db, ctxB).listTitles()).toEqual(["Someone Else's Trip"]);
  });

  it("refuses a query with no {scope} placeholder", () => {
    expect(() => new TripProbe(db, ctxA).listUnscoped()).toThrow(TenantScopeError);
  });

  it("rejects an empty household id at construction", () => {
    expect(() => new TripProbe(db, { ...ctxA, householdId: "" })).toThrow(TenantScopeError);
  });

  it("binds correctly when placeholders precede the scope token", () => {
    new TripProbe(db, ctxA).rename("t1", "Renamed");
    const row = db.prepare("SELECT title FROM trip WHERE id = ?").get("t1") as {
      title: string;
    };
    expect(row.title).toBe("Renamed");
  });

  it("does not update another household's row", () => {
    new TripProbe(db, ctxA).rename("t2", "Hijacked");
    const row = db.prepare("SELECT title FROM trip WHERE id = ?").get("t2") as {
      title: string;
    };
    expect(row.title).toBe("Someone Else's Trip");
  });
});
```

The third test is the important one: a developer who forgets to scope their query gets a loud failure, not a silent cross-tenant read.

The last two cover an easy mistake. An `UPDATE … SET x = ? WHERE {scope}` has a placeholder *before* the scope predicate, so binding the household id blindly as the first parameter puts every argument in the wrong slot. The implementation below splices it in at the correct position instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- repos/base`
Expected: FAIL — cannot resolve `src/server/repos/base.js`.

- [ ] **Step 3: Write the base repository**

Create `src/server/repos/base.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export type Role = "owner" | "adult" | "viewer";

export type HouseholdContext = {
  householdId: string;
  userId: string;
  role: Role;
};

export class TenantScopeError extends Error {}

const SCOPE_TOKEN = "{scope}";

/**
 * Base class for all domain repositories.
 *
 * Queries MUST contain the literal `{scope}` token exactly once, where the
 * tenancy predicate belongs. It is replaced with `household_id = ?` and the
 * household id is bound as the FIRST parameter. A query without the token
 * throws rather than executing, so forgetting to scope is a loud failure and
 * never a silent cross-tenant read.
 *
 * Exactly one occurrence is required because the household id is bound once. A
 * query spanning two scoped tables must join through one of them — see
 * TripRepo.travelers and ItineraryRepo.
 */
export abstract class TenantRepo {
  constructor(
    protected readonly db: DatabaseSync,
    protected readonly ctx: HouseholdContext,
  ) {
    if (!ctx.householdId) {
      throw new TenantScopeError("HouseholdContext.householdId must not be empty");
    }
  }

  /**
   * Replaces the scope token and splices the household id into the parameter
   * list at the position the token occupies.
   *
   * Binding it blindly as the first parameter only works when every other
   * placeholder follows the token. An `UPDATE … SET x = ? WHERE {scope}` has one
   * before it, and blind binding would shift every argument by one slot.
   */
  private scopeQuery(
    sql: string,
    params: unknown[],
  ): { sql: string; params: unknown[] } {
    const parts = sql.split(SCOPE_TOKEN);
    if (parts.length !== 2) {
      throw new TenantScopeError(
        `Query must contain exactly one ${SCOPE_TOKEN} token, found ${
          parts.length - 1
        }:\n${sql}`,
      );
    }

    // Our SQL never contains string literals, so counting "?" is exact.
    const before = (parts[0]!.match(/\?/g) ?? []).length;

    return {
      sql: `${parts[0]}household_id = ?${parts[1]}`,
      params: [...params.slice(0, before), this.ctx.householdId, ...params.slice(before)],
    };
  }

  protected all<T>(sql: string, ...params: unknown[]): T[] {
    const q = this.scopeQuery(sql, params);
    return this.db.prepare(q.sql).all(...(q.params as never[])) as T[];
  }

  protected get<T>(sql: string, ...params: unknown[]): T | undefined {
    const q = this.scopeQuery(sql, params);
    return this.db.prepare(q.sql).get(...(q.params as never[])) as T | undefined;
  }

  protected run(sql: string, ...params: unknown[]): void {
    const q = this.scopeQuery(sql, params);
    this.db.prepare(q.sql).run(...(q.params as never[]));
  }

  /**
   * Inserts are the one case with no WHERE clause to scope. The household id is
   * supplied by the context rather than the caller, so a caller cannot insert
   * into another tenant even if they try.
   */
  protected insert(table: string, values: Record<string, unknown>): void {
    const withScope: Record<string, unknown> = { ...values, household_id: this.ctx.householdId };
    const cols = Object.keys(withScope);
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
      .map(() => "?")
      .join(", ")})`;
    this.db.prepare(sql).run(...cols.map((c) => withScope[c] as never));
  }

  protected requireWrite(): void {
    if (this.ctx.role === "viewer") {
      throw new TenantScopeError("Viewers may not modify data");
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- repos/base`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/repos/base.ts tests/server/repos/base.test.ts
git commit -m "feat: add tenant-scoped repository base with fail-loud scoping"
```

---

### Task 6: Person repository with encrypted document numbers

**Files:**
- Create: `src/server/repos/person.ts`
- Test: `tests/server/repos/person.test.ts`

**Interfaces:**
- Consumes: `TenantRepo`, `HouseholdContext`, `TenantScopeError` (Task 5); `Keyring`, `mask` (Task 4); `newId` (Task 4)
- Produces:
  - `type DocumentField = "passport_number" | "known_traveler_number" | "redress_number"`
  - `type Person`, `type CreatePersonInput`
  - `class PersonRepo` with `create(input): Person`, `list(): Person[]`, `findById(id): Person | undefined`, `revealDocument(personId, field): string | null`

`base.ts` (Task 5) now hides `this.db` behind private state and exposes only `all()`/`get()`/`run()`/`insert()` plus the `unscoped()`/`unscopedRun()` escape hatch, and it splits what used to be a single `TenantScopeError` into three error classes — `TenantScopeError` (developer bug, 500), `ForbiddenError` (role denial, 403, thrown by `requireWrite()`), and `NotFoundError` (row not in this household, 404). `PersonRepo` doesn't touch `this.db` directly, so it isn't affected by the first change, but `revealDocument`'s field-allowlist check below is reclassified under the second.

- [ ] **Step 1: Write the failing test**

Create `tests/server/repos/person.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { PersonRepo, type DocumentField } from "../../../src/server/repos/person.js";
import { ForbiddenError, TenantScopeError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let db: DatabaseSync;
let repo: PersonRepo;

beforeEach(() => {
  db = createTestDatabase();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
    "hh-a",
    "Badger",
    new Date().toISOString(),
  );
  repo = new PersonRepo(db, ctx, ring);
});

describe("PersonRepo", () => {
  it("creates a person and masks the passport number", () => {
    const p = repo.create({
      displayName: "Ava",
      dob: "2018-04-02",
      passportNumber: "C03X72119",
      passportExpiry: "2029-06-01",
      passportCountry: "USA",
    });
    expect(p.displayName).toBe("Ava");
    expect(p.passportNumberMasked).toBe("••••2119");
  });

  it("never returns plaintext from list()", () => {
    repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    const serialized = JSON.stringify(repo.list());
    expect(serialized).not.toContain("C03X72119");
  });

  it("stores ciphertext, not plaintext, in the database", () => {
    const p = repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    const row = db
      .prepare("SELECT passport_number FROM person WHERE id = ?")
      .get(p.id) as { passport_number: string };
    expect(row.passport_number).not.toContain("C03X72119");
    expect(row.passport_number.startsWith("v1.server-v1.")).toBe(true);
  });

  it("reveals plaintext only on explicit request", () => {
    const p = repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    expect(repo.revealDocument(p.id, "passport_number")).toBe("C03X72119");
  });

  it("returns null when revealing an unset document", () => {
    const p = repo.create({ displayName: "Ava" });
    expect(repo.revealDocument(p.id, "passport_number")).toBe(null);
  });

  it("does not leak people from another household", () => {
    repo.create({ displayName: "Ava" });
    const other = new PersonRepo(
      db,
      { householdId: "hh-b", userId: "u2", role: "owner" },
      ring,
    );
    expect(other.list()).toEqual([]);
    expect(other.revealDocument("whatever", "passport_number")).toBe(null);
  });

  it("refuses writes from a viewer", () => {
    const viewer = new PersonRepo(db, { ...ctx, role: "viewer" }, ring);
    expect(() => viewer.create({ displayName: "Nope" })).toThrow(ForbiddenError);
  });

  it("rejects an unrecognized document field as a developer bug, not client input", () => {
    const p = repo.create({ displayName: "Ava" });
    expect(() => repo.revealDocument(p.id, "display_name" as DocumentField)).toThrow(
      TenantScopeError,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- repos/person`
Expected: FAIL — cannot resolve `src/server/repos/person.js`.

- [ ] **Step 3: Write the repository**

Create `src/server/repos/person.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { TenantRepo, TenantScopeError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask } from "../crypto/envelope.js";
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
    db: DatabaseSync,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  create(input: CreatePersonInput): Person {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    const id = newId();
    this.insert("person", {
      id,
      display_name: input.displayName,
      dob: input.dob ?? null,
      notes: input.notes ?? null,
      passport_expiry: input.passportExpiry ?? null,
      passport_country: input.passportCountry ?? null,
      passport_number: this.seal(input.passportNumber),
      known_traveler_number: this.seal(input.knownTravelerNumber),
      redress_number: this.seal(input.redressNumber),
      created_at: new Date().toISOString(),
    });
    const created = this.findById(id);
    if (!created) throw new Error("Person disappeared immediately after creation");
    return created;
  }

  list(): Person[] {
    return this.all<PersonRow>(
      "SELECT * FROM person WHERE {scope} ORDER BY display_name",
    ).map((r) => this.toPerson(r));
  }

  findById(id: string): Person | undefined {
    const row = this.get<PersonRow>("SELECT * FROM person WHERE {scope} AND id = ?", id);
    return row ? this.toPerson(row) : undefined;
  }

  /**
   * Returns the plaintext of a single document field. Callers must log the
   * access — see routes/people.ts.
   */
  revealDocument(personId: string, field: DocumentField): string | null {
    if (!DOCUMENT_FIELDS.includes(field)) {
      // Not client input at this point — the route validates `field` against
      // DOCUMENT_FIELDS before ever calling this method. An invalid value
      // reaching here means a caller inside our own code passed a bad
      // constant: a developer bug, not a 404 or a permission problem. Per
      // TenantScopeError's contract, the message names no field/column value
      // — log the offending field separately if this ever needs debugging.
      throw new TenantScopeError("revealDocument() called with a field outside DOCUMENT_FIELDS");
    }
    const row = this.get<{ value: string | null }>(
      `SELECT ${field} AS value FROM person WHERE {scope} AND id = ?`,
      personId,
    );
    const value = row?.value ?? null;
    return value === null ? null : this.ring.decrypt(value);
  }

  private seal(plaintext: string | undefined): string | null {
    return plaintext ? this.ring.encrypt(plaintext) : null;
  }

  private unsealAndMask(envelope: string | null): string | null {
    return envelope === null ? null : mask(this.ring.decrypt(envelope));
  }

  private toPerson(r: PersonRow): Person {
    return {
      id: r.id,
      displayName: r.display_name,
      dob: r.dob,
      notes: r.notes,
      passportExpiry: r.passport_expiry,
      passportCountry: r.passport_country,
      passportNumberMasked: this.unsealAndMask(r.passport_number),
      knownTravelerNumberMasked: this.unsealAndMask(r.known_traveler_number),
      redressNumberMasked: this.unsealAndMask(r.redress_number),
    };
  }
}
```

Note `revealDocument` validates `field` against a fixed list before interpolating it into SQL — the value reaches this method from a route parameter, and interpolating it unchecked would be an injection. That check failing is a `TenantScopeError` (500), not a 400: by the time it could fire, the route has already rejected an unknown field with its own 400, so tripping it means our own code called `revealDocument` with a bad constant — a bug, not bad client input.

- [ ] **Step 4: Run the tests**

Run: `npm test -- repos/person`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/repos/person.ts tests/server/repos/person.test.ts
git commit -m "feat: add person repository with encrypted document numbers"
```

---

### Task 7: Trip repository

**Files:**
- Create: `src/server/repos/trip.ts`
- Test: `tests/server/repos/trip.test.ts`

**Interfaces:**
- Consumes: `TenantRepo`, `NotFoundError` (Task 5); `newId` (Task 4)
- Produces:
  - `type TripStatus = "planning" | "active" | "complete" | "cancelled"`
  - `type Trip`, `type CreateTripInput`
  - `class TripRepo` with `create(input): Trip`, `list(): Trip[]`, `findById(id): Trip | undefined`, `addTraveler(tripId, personId): void`, `travelers(tripId): string[]`

`addTraveler` used to throw `TenantScopeError` for a missing trip or person. Under the now-three-way taxonomy in `base.ts` (`TenantScopeError` = developer bug → 500, `ForbiddenError` = role denial → 403, `NotFoundError` = row not in this household → 404), a trip or person that simply isn't in this household is a 404, not a 500 — so both throws below are `NotFoundError`. `TripRepo` also no longer reaches `this.db` directly: the join-table write in `addTraveler` goes through the new `unscopedRun()` escape hatch on `TenantRepo`, which takes a `reason` string documenting why the write is safe despite touching a table (`trip_person`) that carries no `household_id` of its own.

- [ ] **Step 1: Write the failing test**

Create `tests/server/repos/trip.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { TripRepo } from "../../../src/server/repos/trip.js";
import { NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let db: DatabaseSync;
let repo: TripRepo;

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-a", "Badger", now);
  db.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run("p-ava", "hh-a", "Ava", now);
  repo = new TripRepo(db, ctx);
});

describe("TripRepo", () => {
  it("creates and reads back a trip", () => {
    const t = repo.create({
      title: "Mary & Winter Wedding",
      destination: "Guerneville, CA",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
    });
    expect(repo.findById(t.id)?.title).toBe("Mary & Winter Wedding");
    expect(t.status).toBe("planning");
  });

  it("orders trips by start date", () => {
    repo.create({ title: "Later", startsOn: "2027-01-01" });
    repo.create({ title: "Sooner", startsOn: "2026-10-09" });
    expect(repo.list().map((t) => t.title)).toEqual(["Sooner", "Later"]);
  });

  it("attaches travelers", () => {
    const t = repo.create({ title: "Trip" });
    repo.addTraveler(t.id, "p-ava");
    expect(repo.travelers(t.id)).toEqual(["p-ava"]);
  });

  it("refuses to attach a traveler from another household", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-b", "Other", now);
    db.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("p-stranger", "hh-b", "Stranger", now);
    const t = repo.create({ title: "Trip" });
    expect(() => repo.addTraveler(t.id, "p-stranger")).toThrow(NotFoundError);
  });

  it("does not leak trips from another household", () => {
    repo.create({ title: "Mine" });
    const other = new TripRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" });
    expect(other.list()).toEqual([]);
  });
});
```

The fourth test matters: cross-tenant references are the subtle leak, and foreign keys alone will not catch it because both rows are individually valid.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- repos/trip`
Expected: FAIL — cannot resolve `src/server/repos/trip.js`.

- [ ] **Step 3: Write the repository**

Create `src/server/repos/trip.ts`:

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
  create(input: CreateTripInput): Trip {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    const id = newId();
    this.insert("trip", {
      id,
      title: input.title,
      destination: input.destination ?? null,
      starts_on: input.startsOn ?? null,
      ends_on: input.endsOn ?? null,
      status: "planning",
      notes: input.notes ?? null,
      created_at: new Date().toISOString(),
    });
    const created = this.findById(id);
    if (!created) throw new Error("Trip disappeared immediately after creation");
    return created;
  }

  list(): Trip[] {
    return this.all<TripRow>(
      "SELECT * FROM trip WHERE {scope} ORDER BY starts_on IS NULL, starts_on",
    ).map(toTrip);
  }

  findById(id: string): Trip | undefined {
    const row = this.get<TripRow>("SELECT * FROM trip WHERE {scope} AND id = ?", id);
    return row ? toTrip(row) : undefined;
  }

  addTraveler(tripId: string, personId: string): void {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    if (!this.findById(tripId)) {
      throw new NotFoundError("Trip not found in this household");
    }
    const person = this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?",
      personId,
    );
    if (!person) {
      throw new NotFoundError("Person not found in this household");
    }
    // Unscoped by design: trip_person carries no household_id of its own, but
    // both ids above were already confirmed to be in this household by the
    // scoped findById()/get() calls immediately above — that's what makes
    // this write safe despite bypassing {scope}.
    this.unscopedRun(
      "join-table write; both tripId and personId already confirmed in-household by findById/get above",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      tripId,
      personId,
    );
  }

  travelers(tripId: string): string[] {
    return this.all<{ person_id: string }>(
      `SELECT tp.person_id
         FROM trip_person tp
         JOIN trip t ON t.id = tp.trip_id
        WHERE {scope} AND tp.trip_id = ?
        ORDER BY tp.person_id`,
      tripId,
    ).map((r) => r.person_id);
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

`travelers()` joins through `trip` so the `{scope}` token resolves against `trip.household_id` — `trip_person` deliberately has no household column, since it is reachable only through a scoped parent.

- [ ] **Step 4: Run the tests**

Run: `npm test -- repos/trip`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/repos/trip.ts tests/server/repos/trip.test.ts
git commit -m "feat: add trip repository with traveler assignment"
```

---

### Task 8: Booking kind schemas and booking repository

**Files:**
- Create: `src/server/schemas/booking-kinds.ts`
- Create: `src/server/repos/confirmation.ts`
- Create: `src/server/repos/booking.ts`
- Test: `tests/server/schemas/booking-kinds.test.ts`
- Test: `tests/server/repos/booking.test.ts`

**Interfaces:**
- Consumes: `TenantRepo`, `NotFoundError` (Task 5); `newId`, `Keyring`, `mask` (Task 4)
- Produces:
  - `BOOKING_KINDS`, `parseDetails(kind: string, details: unknown): unknown`
  - `openConfirmation(ring, stored): string | null` — shared unsealer
  - `type BookingStatus = "draft" | "planned" | "booked" | "cancelled"`
  - `type Booking`, `type CreateBookingInput`
  - `class BookingRepo(db, ctx, ring)` with `create(input): Booking`, `findById(id): Booking | undefined`, `listByTrip(tripId): Booking[]`, `assignPerson(bookingId, personId): void`, `revealConfirmation(bookingId): string | null`

Like `TripRepo.addTraveler` (Task 7), `assignPerson`'s "trip/booking/person not found in this household" throws are `NotFoundError` (404) now, not `TenantScopeError` (500) — under the three-way taxonomy in `base.ts`, a row that just isn't in your household is a 404. `BookingRepo` also has two direct `this.db` sites — the `booking_person` insert in `assignPerson` and the `booking_person` select in `personIdsFor` — both of which move to `unscoped()`/`unscopedRun()`, since `booking_person` is a join table with no `household_id` of its own.

**Confirmation numbers are encrypted**, like passport numbers and for the same reason: they identify a reservation to anyone who reads the database, and the design already renders them masked. They use the same envelope, so this is consistent rather than novel. The unsealing helper lives in its own module because both `BookingRepo` and `ItineraryRepo` construct `Booking` objects — duplicating an unmasking path is how a plaintext leak gets introduced later.

- [ ] **Step 1: Write the failing schema test**

Create `tests/server/schemas/booking-kinds.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDetails, BOOKING_KINDS } from "../../../src/server/schemas/booking-kinds.js";

describe("booking kind schemas", () => {
  it("accepts valid flight details", () => {
    const d = parseDetails("flight", {
      carrier: "DL",
      flightNumber: "1422",
      originIata: "BOI",
      destinationIata: "ATL",
    });
    expect(d).toMatchObject({ carrier: "DL", originIata: "BOI" });
  });

  it("rejects a flight missing its origin", () => {
    expect(() => parseDetails("flight", { carrier: "DL", flightNumber: "1422" })).toThrow();
  });

  it("normalizes IATA codes to uppercase", () => {
    const d = parseDetails("flight", {
      carrier: "DL",
      flightNumber: "1422",
      originIata: "boi",
      destinationIata: "atl",
    }) as { originIata: string };
    expect(d.originIata).toBe("BOI");
  });

  it("accepts lodging details", () => {
    expect(parseDetails("lodging", { propertyName: "Highlands Resort" })).toMatchObject({
      propertyName: "Highlands Resort",
    });
  });

  it("accepts an unknown kind with freeform details", () => {
    expect(parseDetails("other", { anything: true })).toMatchObject({ anything: true });
  });

  it("exposes the known kinds", () => {
    expect(BOOKING_KINDS).toContain("flight");
    expect(BOOKING_KINDS).toContain("lodging");
    expect(BOOKING_KINDS).toContain("car");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- booking-kinds`
Expected: FAIL — cannot resolve `src/server/schemas/booking-kinds.js`.

- [ ] **Step 3: Write the schemas**

Create `src/server/schemas/booking-kinds.ts`:

```ts
import { z } from "zod";

const iata = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase());

export const flightDetails = z.object({
  carrier: z.string().min(1),
  flightNumber: z.string().min(1),
  originIata: iata,
  destinationIata: iata,
  cabin: z.string().optional(),
  seat: z.string().optional(),
});

export const lodgingDetails = z.object({
  propertyName: z.string().min(1),
  address: z.string().optional(),
  roomType: z.string().optional(),
  nights: z.number().int().positive().optional(),
});

export const carDetails = z.object({
  vendor: z.string().min(1),
  pickupLocation: z.string().optional(),
  dropoffLocation: z.string().optional(),
  vehicleClass: z.string().optional(),
});

export const activityDetails = z.object({
  venue: z.string().optional(),
  address: z.string().optional(),
  partySize: z.number().int().positive().optional(),
});

/** Anything not modeled yet. The escape hatch that makes the JSON column worth having. */
export const freeformDetails = z.record(z.string(), z.unknown());

const SCHEMAS = {
  flight: flightDetails,
  lodging: lodgingDetails,
  car: carDetails,
  activity: activityDetails,
} as const;

export const BOOKING_KINDS = [...Object.keys(SCHEMAS), "other"] as const;

export function parseDetails(kind: string, details: unknown): unknown {
  const schema = SCHEMAS[kind as keyof typeof SCHEMAS];
  return schema ? schema.parse(details) : freeformDetails.parse(details);
}
```

- [ ] **Step 4: Run the schema tests**

Run: `npm test -- booking-kinds`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing repository test**

Create `tests/server/repos/booking.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let db: DatabaseSync;
let repo: BookingRepo;

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-a", "Badger", now);
  db.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .run("t1", "hh-a", "Guerneville", now);
  db.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run("p-ava", "hh-a", "Ava", now);
  repo = new BookingRepo(db, ctx, ring);
});

describe("BookingRepo", () => {
  it("creates a flight with validated details", () => {
    const b = repo.create({
      tripId: "t1",
      kind: "flight",
      title: "DL1422 BOI → ATL",
      startsAt: "2026-10-09T01:00:00Z",
      startsAtTz: "America/Boise",
      endsAt: "2026-10-09T07:15:00Z",
      endsAtTz: "America/New_York",
      details: { carrier: "DL", flightNumber: "1422", originIata: "BOI", destinationIata: "ATL" },
    });
    expect(b.kind).toBe("flight");
    expect(b.details).toMatchObject({ carrier: "DL" });
    expect(b.status).toBe("planned");
  });

  it("rejects invalid details for a known kind", () => {
    expect(() =>
      repo.create({ tripId: "t1", kind: "flight", title: "Bad", details: { carrier: "DL" } }),
    ).toThrow();
  });

  it("rejects a booking whose timestamp has no timezone", () => {
    expect(() =>
      repo.create({
        tripId: "t1",
        kind: "other",
        title: "No tz",
        startsAt: "2026-10-09T01:00:00Z",
        details: {},
      }),
    ).toThrow(/timezone/i);
  });

  it("allows email-ingested bookings to be created as drafts", () => {
    const b = repo.create({
      tripId: "t1", kind: "other", title: "Parsed", details: {}, status: "draft",
    });
    expect(b.status).toBe("draft");
  });

  it("assigns a person to a booking", () => {
    const b = repo.create({ tripId: "t1", kind: "other", title: "Dinner", details: {} });
    repo.assignPerson(b.id, "p-ava");
    expect(repo.listByTrip("t1")[0]?.personIds).toEqual(["p-ava"]);
  });

  it("refuses to create a booking on another household's trip", () => {
    const other = new BookingRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" }, ring);
    expect(() =>
      other.create({ tripId: "t1", kind: "other", title: "Intrusion", details: {} }),
    ).toThrow(NotFoundError);
  });

  it("does not leak bookings from another household", () => {
    repo.create({ tripId: "t1", kind: "other", title: "Mine", details: {} });
    const other = new BookingRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" }, ring);
    expect(other.listByTrip("t1")).toEqual([]);
  });

  it("returns the confirmation number masked", () => {
    const b = repo.create({
      tripId: "t1", kind: "other", title: "Hotel",
      confirmationNumber: "ABCDX4T2", details: {},
    });
    expect(b.confirmationNumberMasked).toBe("••••X4T2");
  });

  it("stores confirmation ciphertext, not plaintext", () => {
    const b = repo.create({
      tripId: "t1", kind: "other", title: "Hotel",
      confirmationNumber: "ABCDX4T2", details: {},
    });
    const row = db
      .prepare("SELECT confirmation_number FROM booking WHERE id = ?")
      .get(b.id) as { confirmation_number: string };
    expect(row.confirmation_number).not.toContain("ABCDX4T2");
    expect(row.confirmation_number.startsWith("v1.server-v1.")).toBe(true);
  });

  it("reveals the confirmation only on explicit request", () => {
    const b = repo.create({
      tripId: "t1", kind: "other", title: "Hotel",
      confirmationNumber: "ABCDX4T2", details: {},
    });
    expect(repo.revealConfirmation(b.id)).toBe("ABCDX4T2");
  });

  it("does not reveal another household's confirmation", () => {
    const b = repo.create({
      tripId: "t1", kind: "other", title: "Hotel",
      confirmationNumber: "ABCDX4T2", details: {},
    });
    const other = new BookingRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" }, ring);
    expect(other.revealConfirmation(b.id)).toBe(null);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- repos/booking`
Expected: FAIL — cannot resolve `src/server/repos/booking.js`.

- [ ] **Step 7: Write the shared confirmation unsealer**

Create `src/server/repos/confirmation.ts`:

```ts
import type { Keyring } from "../crypto/envelope.js";

/**
 * Unseal a stored confirmation number.
 *
 * Both BookingRepo and ItineraryRepo construct Booking objects, so this lives in
 * one place — duplicating an unmasking path is how a plaintext leak gets
 * introduced later.
 */
export function openConfirmation(ring: Keyring, stored: string | null): string | null {
  return stored === null ? null : ring.decrypt(stored);
}
```

- [ ] **Step 8: Write the repository**

Create `src/server/repos/booking.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { TenantRepo, NotFoundError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask } from "../crypto/envelope.js";
import { openConfirmation } from "./confirmation.js";
import { newId } from "../ids.js";
import { parseDetails } from "../schemas/booking-kinds.js";

export type BookingStatus = "draft" | "planned" | "booked" | "cancelled";

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

type BookingRow = {
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

export class BookingRepo extends TenantRepo {
  constructor(
    db: DatabaseSync,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  create(input: CreateBookingInput): Booking {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    assertTimezonePaired(input);

    const trip = this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?",
      input.tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const details = parseDetails(input.kind, input.details);
    const id = newId();
    this.insert("booking", {
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
        ? this.ring.encrypt(input.confirmationNumber)
        : null,
      cost_cents: input.costCents ?? null,
      points_used: input.pointsUsed ?? null,
      points_program: input.pointsProgram ?? null,
      status: input.status ?? "planned",
      details: JSON.stringify(details),
      created_at: new Date().toISOString(),
    });

    const created = this.findById(id);
    if (!created) throw new Error("Booking disappeared immediately after creation");
    return created;
  }

  findById(id: string): Booking | undefined {
    const row = this.get<BookingRow>("SELECT * FROM booking WHERE {scope} AND id = ?", id);
    return row ? this.toBooking(row) : undefined;
  }

  listByTrip(tripId: string): Booking[] {
    return this.all<BookingRow>(
      `SELECT * FROM booking
        WHERE {scope} AND trip_id = ?
          AND status != 'cancelled'
        ORDER BY starts_at IS NULL, starts_at`,
      tripId,
    ).map((r) => this.toBooking(r));
  }

  assignPerson(bookingId: string, personId: string): void {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    const booking = this.get<{ id: string }>(
      "SELECT id FROM booking WHERE {scope} AND id = ?",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");

    const person = this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?",
      personId,
    );
    if (!person) throw new NotFoundError("Person not found in this household");

    // Unscoped by design: booking_person carries no household_id of its own,
    // but both ids above were already confirmed to be in this household by
    // the scoped get() calls immediately above — that's what makes this
    // write safe despite bypassing {scope}.
    this.unscopedRun(
      "join-table write; both bookingId and personId already confirmed in-household by get() above",
      "INSERT OR IGNORE INTO booking_person (booking_id, person_id) VALUES (?, ?)",
      bookingId,
      personId,
    );
  }

  revealConfirmation(bookingId: string): string | null {
    const row = this.get<{ value: string | null }>(
      "SELECT confirmation_number AS value FROM booking WHERE {scope} AND id = ?",
      bookingId,
    );
    return openConfirmation(this.ring, row?.value ?? null);
  }

  /**
   * Unscoped by design: only ever called with a bookingId already proven to be
   * in this household by the scoped query that produced it (`findById`,
   * `listByTrip`, or the scoped `get()` in `assignPerson`). Keep it private.
   */
  private personIdsFor(bookingId: string): string[] {
    return this.unscoped<{ person_id: string }>(
      "read-only join-table lookup; bookingId always sourced from a scoped query in this class",
      "SELECT person_id FROM booking_person WHERE booking_id = ? ORDER BY person_id",
      bookingId,
    ).map((r) => r.person_id);
  }

  private toBooking(r: BookingRow): Booking {
    return {
      id: r.id,
      tripId: r.trip_id,
      kind: r.kind,
      title: r.title,
      location: r.location,
      startsAt: r.starts_at,
      startsAtTz: r.starts_at_tz,
      endsAt: r.ends_at,
      endsAtTz: r.ends_at_tz,
      confirmationNumberMasked: mask(openConfirmation(this.ring, r.confirmation_number)),
      costCents: r.cost_cents,
      pointsUsed: r.points_used,
      pointsProgram: r.points_program,
      status: r.status,
      details: JSON.parse(r.details),
      personIds: this.personIdsFor(r.id),
    };
  }
}

/**
 * A timestamp without its IANA zone renders every cross-timezone itinerary
 * wrong, which is most flights. Reject the unpaired case at the boundary rather
 * than discovering it in the UI.
 */
function assertTimezonePaired(input: CreateBookingInput): void {
  if (input.startsAt && !input.startsAtTz) {
    throw new Error("startsAt requires startsAtTz (an IANA timezone)");
  }
  if (input.endsAt && !input.endsAtTz) {
    throw new Error("endsAt requires endsAtTz (an IANA timezone)");
  }
}
```

- [ ] **Step 9: Run the tests**

Run: `npm test -- repos/booking`
Expected: PASS, 11 tests.

- [ ] **Step 10: Commit**

```bash
git add src/server/schemas src/server/repos/booking.ts src/server/repos/confirmation.ts tests/server/schemas tests/server/repos/booking.test.ts
git commit -m "feat: add booking repository with Zod validation and encrypted confirmations"
```

---

### Task 9: Per-person day-by-day itinerary

The centerpiece feature. Grouping happens in each event's *own* local timezone — not UTC, and not the viewer's zone.

**Files:**
- Create: `src/server/repos/itinerary.ts`
- Test: `tests/server/repos/itinerary.test.ts`

**Interfaces:**
- Consumes: `TenantRepo` (Task 5); `type Booking`, `openConfirmation` (Task 8); `Keyring`, `mask` (Task 4)
- Produces:
  - `type ItineraryDay = { date: string; bookings: Booking[] }`
  - `class ItineraryRepo(db, ctx, ring)` with `forPerson(tripId, personId): ItineraryDay[]` and `forTrip(tripId): ItineraryDay[]`

`ItineraryRepo` has no mutating methods, so the `ForbiddenError`/`NotFoundError` split doesn't touch it — `forPerson`/`forTrip` never throw; a trip or person with nothing scheduled just yields `[]`. It does have the same `this.db` site as Task 8's `personIdsFor` (`booking_person` is a join table with no `household_id`), which moves to `unscoped()`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/repos/itinerary.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { ItineraryRepo } from "../../../src/server/repos/itinerary.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let db: DatabaseSync;
let bookings: BookingRepo;
let itinerary: ItineraryRepo;

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-a", "Badger", now);
  db.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .run("t1", "hh-a", "Guerneville", now);
  for (const [id, name] of [["p-badger", "Badger"], ["p-ava", "Ava"]] as const) {
    db.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run(id, "hh-a", name, now);
  }
  bookings = new BookingRepo(db, ctx, ring);
  itinerary = new ItineraryRepo(db, ctx, ring);
});

describe("ItineraryRepo", () => {
  it("returns only the bookings a person is on", () => {
    const flight = bookings.create({
      tripId: "t1", kind: "other", title: "Shared flight",
      startsAt: "2026-10-09T15:00:00Z", startsAtTz: "America/Boise", details: {},
    });
    const solo = bookings.create({
      tripId: "t1", kind: "other", title: "Badger's solo dinner",
      startsAt: "2026-10-09T20:00:00Z", startsAtTz: "America/Boise", details: {},
    });
    bookings.assignPerson(flight.id, "p-badger");
    bookings.assignPerson(flight.id, "p-ava");
    bookings.assignPerson(solo.id, "p-badger");

    const avaDays = itinerary.forPerson("t1", "p-ava");
    expect(avaDays.flatMap((d) => d.bookings.map((b) => b.title))).toEqual(["Shared flight"]);

    const badgerDays = itinerary.forPerson("t1", "p-badger");
    expect(badgerDays.flatMap((d) => d.bookings.map((b) => b.title))).toEqual([
      "Shared flight",
      "Badger's solo dinner",
    ]);
  });

  it("groups by the event's local date, not UTC", () => {
    // 2026-10-10T04:00:00Z is 2026-10-09 at 22:00 in America/Boise.
    const b = bookings.create({
      tripId: "t1", kind: "other", title: "Late dinner",
      startsAt: "2026-10-10T04:00:00Z", startsAtTz: "America/Boise", details: {},
    });
    bookings.assignPerson(b.id, "p-badger");
    expect(itinerary.forPerson("t1", "p-badger")[0]?.date).toBe("2026-10-09");
  });

  it("groups a departure by its origin's local date", () => {
    // Departing Boise 2026-10-09 23:30 local == 2026-10-10T05:30Z,
    // landing the next day in another zone. It is still Thursday's flight.
    const b = bookings.create({
      tripId: "t1", kind: "other", title: "Red-eye",
      startsAt: "2026-10-10T05:30:00Z", startsAtTz: "America/Boise",
      endsAt: "2026-10-10T11:00:00Z", endsAtTz: "America/New_York",
      details: {},
    });
    bookings.assignPerson(b.id, "p-badger");
    expect(itinerary.forPerson("t1", "p-badger")[0]?.date).toBe("2026-10-09");
  });

  it("returns days in chronological order", () => {
    for (const [title, at] of [
      ["Day two", "2026-10-10T18:00:00Z"],
      ["Day one", "2026-10-09T18:00:00Z"],
    ] as const) {
      const b = bookings.create({
        tripId: "t1", kind: "other", title, startsAt: at,
        startsAtTz: "America/Boise", details: {},
      });
      bookings.assignPerson(b.id, "p-badger");
    }
    expect(itinerary.forPerson("t1", "p-badger").map((d) => d.date)).toEqual([
      "2026-10-09",
      "2026-10-10",
    ]);
  });

  it("omits undated bookings from the day view", () => {
    const b = bookings.create({ tripId: "t1", kind: "other", title: "Someday", details: {} });
    bookings.assignPerson(b.id, "p-badger");
    expect(itinerary.forPerson("t1", "p-badger")).toEqual([]);
  });

  it("includes everyone's bookings in the whole-trip view", () => {
    const a = bookings.create({
      tripId: "t1", kind: "other", title: "Ava only",
      startsAt: "2026-10-09T18:00:00Z", startsAtTz: "America/Boise", details: {},
    });
    bookings.assignPerson(a.id, "p-ava");
    expect(itinerary.forTrip("t1").flatMap((d) => d.bookings.map((b) => b.title))).toEqual([
      "Ava only",
    ]);
  });

  it("does not leak another household's itinerary", () => {
    const b = bookings.create({
      tripId: "t1", kind: "other", title: "Mine",
      startsAt: "2026-10-09T18:00:00Z", startsAtTz: "America/Boise", details: {},
    });
    bookings.assignPerson(b.id, "p-badger");
    const other = new ItineraryRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" }, ring);
    expect(other.forPerson("t1", "p-badger")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- itinerary`
Expected: FAIL — cannot resolve `src/server/repos/itinerary.js`.

- [ ] **Step 3: Write the repository**

Create `src/server/repos/itinerary.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { TenantRepo } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask } from "../crypto/envelope.js";
import { openConfirmation } from "./confirmation.js";
import type { Booking, BookingStatus } from "./booking.js";

export type ItineraryDay = {
  /** Calendar date in the event's own local timezone, as YYYY-MM-DD. */
  date: string;
  bookings: Booking[];
};

type Row = {
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

export class ItineraryRepo extends TenantRepo {
  constructor(
    db: DatabaseSync,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  /** The day-by-day agenda for one family member on one trip. */
  forPerson(tripId: string, personId: string): ItineraryDay[] {
    const rows = this.all<Row>(
      `SELECT b.*
         FROM booking b
         JOIN booking_person bp ON bp.booking_id = b.id
        WHERE {scope}
          AND b.trip_id = ?
          AND bp.person_id = ?
          AND b.status != 'cancelled'
          AND b.starts_at IS NOT NULL
        ORDER BY b.starts_at`,
      tripId,
      personId,
    );
    return this.group(rows);
  }

  /** The whole trip's agenda, regardless of who is on each booking. */
  forTrip(tripId: string): ItineraryDay[] {
    const rows = this.all<Row>(
      `SELECT b.*
         FROM booking b
        WHERE {scope}
          AND b.trip_id = ?
          AND b.status != 'cancelled'
          AND b.starts_at IS NOT NULL
        ORDER BY b.starts_at`,
      tripId,
    );
    return this.group(rows);
  }

  /**
   * Unscoped by design: only ever called with a bookingId already proven to be
   * in this household by the scoped `forPerson`/`forTrip` query that produced
   * the row it came from.
   */
  private personIdsFor(bookingId: string): string[] {
    return this.unscoped<{ person_id: string }>(
      "read-only join-table lookup; bookingId always sourced from the scoped forPerson/forTrip query above",
      "SELECT person_id FROM booking_person WHERE booking_id = ? ORDER BY person_id",
      bookingId,
    ).map((r) => r.person_id);
  }

  private group(rows: Row[]): ItineraryDay[] {
    const byDate = new Map<string, Booking[]>();

    for (const r of rows) {
      // starts_at is non-null by the query; its tz is guaranteed paired with it
      // by BookingRepo.create.
      const date = localDateOf(r.starts_at!, r.starts_at_tz ?? "UTC");
      const list = byDate.get(date) ?? [];
      list.push({
        id: r.id,
        tripId: r.trip_id,
        kind: r.kind,
        title: r.title,
        location: r.location,
        startsAt: r.starts_at,
        startsAtTz: r.starts_at_tz,
        endsAt: r.ends_at,
        endsAtTz: r.ends_at_tz,
        confirmationNumberMasked: mask(openConfirmation(this.ring, r.confirmation_number)),
        costCents: r.cost_cents,
        pointsUsed: r.points_used,
        pointsProgram: r.points_program,
        status: r.status,
        details: JSON.parse(r.details),
        personIds: this.personIdsFor(r.id),
      });
      byDate.set(date, list);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bookings]) => ({ date, bookings }));
  }
}

/**
 * The calendar date an event belongs to is its date in ITS OWN timezone — not
 * UTC, and not the viewer's. A dinner at 22:00 in Boise is Thursday's dinner
 * even though it is Friday 04:00 UTC, and a red-eye departing Boise late
 * Thursday belongs to Thursday even though it lands Friday in another zone.
 *
 * `en-CA` is used because it formats natively as YYYY-MM-DD.
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

- [ ] **Step 4: Run the tests**

Run: `npm test -- itinerary`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/repos/itinerary.ts tests/server/repos/itinerary.test.ts
git commit -m "feat: add per-person day-by-day itinerary with timezone-correct grouping"
```

---

### Task 10: Cloudflare Access auth boundary

**Files:**
- Create: `src/server/auth.ts`
- Test: `tests/server/auth.test.ts`
- Test: `tests/server/architecture.test.ts`

**Interfaces:**
- Consumes: `type Role` (Task 5)
- Produces:
  - `class AuthError extends Error`
  - `type Identity = { userId: string; email: string; householdId: string; role: Role }`
  - `type AccessConfig`
  - `createAccessVerifier(config): (req: Request) => Promise<Identity>`
  - Request header `X-Travel-HQ-Household`: the household selector `verify()` reads. Routes never see it directly — they read `identity.householdId` from the resolved `Identity`.

This is the only file that knows how authentication works. Swapping Access for OAuth later changes this file and nothing else.

`verify()` **confirms membership in a requested household; it never discovers one.** A user may belong to several households. The selector travels as the `X-Travel-HQ-Household` request header rather than a path prefix (which would restructure every route in Task 11) or a subdomain (Cloudflare Access sits in front of a single hostname — there is no subdomain to route on). Because routes only ever read `identity.householdId`, migrating to subdomain- or path-based tenancy later is a change confined to this file, which is exactly this file's stated purpose.

The header needs no special trust: it only *selects among households the JWT-verified email is already a confirmed member of*. A client can set it to anything — the worst it can do is name a household the caller isn't in, which fails. Spoofing it grants nothing the caller wasn't already entitled to. That is the property that makes verification-not-discovery safe, and it must never be "simplified" into a lookup that trusts the header's household id directly.

- [ ] **Step 1: Write the failing test**

Create `tests/server/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../src/server/db/migrate.js";
import { createAccessVerifier, AuthError } from "../../src/server/auth.js";

const TEAM = "https://badgerops.cloudflareaccess.com";
const AUD = "test-aud-tag";
const HOUSEHOLD_HEADER = "X-Travel-HQ-Household";

let db: DatabaseSync;
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };

async function makeToken(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setExpirationTime("1h")
    .sign(keyPair.privateKey);
}

function verifier() {
  return createAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    db,
    fetchJwks: async () => jwks as never,
  });
}

beforeEach(async () => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-a", "Badger", now);
  db.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)")
    .run("u1", "badger@example.com", now);
  db.prepare("INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, ?)")
    .run("hh-a", "u1", "owner");

  keyPair = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "k1", alg: "RS256" }] };
});

describe("createAccessVerifier", () => {
  it("resolves a valid token to an identity", async () => {
    const token = await makeToken({ email: "badger@example.com" });
    const id = await verifier()(
      new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": token } }),
    );
    expect(id).toMatchObject({ userId: "u1", householdId: "hh-a", role: "owner" });
  });

  it("rejects a request with no token", async () => {
    await expect(verifier()(new Request("http://x/"))).rejects.toThrow(AuthError);
  });

  it("rejects a token signed by the wrong key", async () => {
    const attacker = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "badger@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime("1h")
      .sign(attacker.privateKey);
    await expect(
      verifier()(new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": token } })),
    ).rejects.toThrow(AuthError);
  });

  it("rejects a token for a different audience", async () => {
    const token = await new SignJWT({ email: "badger@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM)
      .setAudience("some-other-app")
      .setExpirationTime("1h")
      .sign(keyPair.privateKey);
    await expect(
      verifier()(new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": token } })),
    ).rejects.toThrow(AuthError);
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ email: "badger@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keyPair.privateKey);
    await expect(
      verifier()(new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": token } })),
    ).rejects.toThrow(AuthError);
  });

  it("rejects a valid token for an unknown user", async () => {
    const token = await makeToken({ email: "stranger@example.com" });
    await expect(
      verifier()(new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": token } })),
    ).rejects.toThrow(AuthError);
  });
});

describe("createAccessVerifier household selection", () => {
  // A second household the caller also belongs to, plus a third household
  // they do NOT belong to. Without both, "selects the right one" and
  // "refuses the wrong one" can't be told apart from "got lucky with LIMIT 1".
  beforeEach(() => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
      "hh-b",
      "Second Household",
      now,
    );
    db.prepare("INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, ?)").run(
      "hh-b",
      "u1",
      "adult",
    );

    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
      "hh-c",
      "Someone Else's Household",
      now,
    );
    db.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)").run(
      "u2",
      "other@example.com",
      now,
    );
    db.prepare("INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, ?)").run(
      "hh-c",
      "u2",
      "owner",
    );
  });

  it("selects the requested household", async () => {
    const token = await makeToken({ email: "badger@example.com" });
    const id = await verifier()(
      new Request("http://x/", {
        headers: { "Cf-Access-Jwt-Assertion": token, [HOUSEHOLD_HEADER]: "hh-b" },
      }),
    );
    expect(id).toMatchObject({ userId: "u1", householdId: "hh-b", role: "adult" });
  });

  it("refuses a household the user is not a member of", async () => {
    const token = await makeToken({ email: "badger@example.com" });
    await expect(
      verifier()(
        new Request("http://x/", {
          headers: { "Cf-Access-Jwt-Assertion": token, [HOUSEHOLD_HEADER]: "hh-c" },
        }),
      ),
    ).rejects.toThrow(AuthError);
  });

  it("refuses to guess when membership is ambiguous", async () => {
    const token = await makeToken({ email: "badger@example.com" });
    // No header, and u1 now belongs to both hh-a and hh-b: must reject rather
    // than resolve to either one.
    await expect(
      verifier()(new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": token } })),
    ).rejects.toThrow(AuthError);
  });

  it("does not disclose whether a household exists", async () => {
    const token = await makeToken({ email: "badger@example.com" });

    const notMember = await verifier()(
      new Request("http://x/", {
        headers: { "Cf-Access-Jwt-Assertion": token, [HOUSEHOLD_HEADER]: "hh-c" },
      }),
    ).catch((err) => err as AuthError);

    const doesNotExist = await verifier()(
      new Request("http://x/", {
        headers: { "Cf-Access-Jwt-Assertion": token, [HOUSEHOLD_HEADER]: "hh-does-not-exist" },
      }),
    ).catch((err) => err as AuthError);

    expect(notMember).toBeInstanceOf(AuthError);
    expect(doesNotExist).toBeInstanceOf(AuthError);
    // Same message either way: distinguishing "exists but not yours" from
    // "doesn't exist" would make the error message a membership oracle.
    expect((doesNotExist as AuthError).message).toBe((notMember as AuthError).message);
  });
});
```

The third test in the first block is the one that matters most there: trusting the header without verifying its signature is the classic Access misconfiguration, and it is trivially exploitable by anything that can reach the origin. In the second block, "refuses a household the user is not a member of" is the one that matters most overall — it is the cross-tenant read the `LIMIT 1` design would have permitted.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- auth`
Expected: FAIL — cannot resolve `src/server/auth.js`.

- [ ] **Step 3: Write the auth boundary**

Create `src/server/auth.ts`:

```ts
import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";
import type { DatabaseSync } from "node:sqlite";
import type { Role } from "./repos/base.js";

export class AuthError extends Error {}

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
  db: DatabaseSync;
  /** Injectable for tests; defaults to fetching the team's certs endpoint. */
  fetchJwks?: () => Promise<JSONWebKeySet>;
};

const HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Selects which of the caller's households a request acts on. This is a
 * SELECTOR, never a discovery mechanism: `verify()` only ever returns a
 * household the JWT-verified email is already a confirmed member of. See the
 * task-level note above for why a header rather than a path prefix/subdomain.
 */
const HOUSEHOLD_HEADER = "X-Travel-HQ-Household";

const JWKS_TTL_MS = 60 * 60 * 1000;

type Membership = {
  user_id: string;
  email: string;
  household_id: string;
  role: Role;
};

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
      throw new AuthError(
        `Missing ${HEADER}. Requests must arrive through Cloudflare Access.`,
      );
    }

    let email: string;
    try {
      const { payload } = await jwtVerify(token, await keys(), {
        issuer: config.teamDomain,
        audience: config.audience,
      });
      if (typeof payload.email !== "string") {
        throw new AuthError("Access token carries no email claim");
      }
      email = payload.email;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`Invalid Access token: ${String(err)}`);
    }

    // No LIMIT: resolution must confirm membership in the requested
    // household, never guess one. ORDER BY makes result order reproducible,
    // even though the only branch below that reads a specific element
    // (index 0, in the single-membership case) is unambiguous regardless of
    // order — there's only one row to read.
    const memberships = config.db
      .prepare(
        `SELECT u.id AS user_id, u.email, hm.household_id, hm.role
           FROM user u
           JOIN household_member hm ON hm.user_id = u.id
          WHERE u.email = ?
          ORDER BY hm.household_id`,
      )
      .all(email) as Membership[];

    if (memberships.length === 0) {
      throw new AuthError(`No household membership for ${email}`);
    }

    const requested = req.headers.get(HOUSEHOLD_HEADER);
    let membership: Membership;

    if (requested !== null) {
      // Header present: it must name a household the caller is a confirmed
      // member of, or this fails outright. It never falls back to picking a
      // different membership.
      const match = memberships.find((m) => m.household_id === requested);
      if (!match) {
        // Deliberately the same message whether `requested` names a
        // household the caller isn't in, or one that doesn't exist at all.
        // Distinguishing those would let a client use this error to probe
        // which household ids exist — a membership oracle.
        throw new AuthError(
          `Not a member of the requested household. Provide a valid ${HOUSEHOLD_HEADER} header.`,
        );
      }
      membership = match;
    } else if (memberships.length === 1) {
      const only = memberships[0];
      // `memberships.length === 1` guarantees this is defined; under
      // noUncheckedIndexedAccess the type is still `Membership | undefined`,
      // so narrow explicitly rather than asserting with `!`.
      if (!only) {
        throw new AuthError(`No household membership for ${email}`);
      }
      membership = only;
    } else {
      // Two or more memberships and no header: never guess. Fail closed and
      // name the header the caller needs to send.
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
```

`verify()` confirms membership in a requested household; it never discovers one:

1. Verify the Access JWT as before, yielding an email.
2. Load **all** memberships for that email — no `LIMIT`, with a deterministic `ORDER BY hm.household_id`.
3. Zero memberships → `AuthError`.
4. Header present → match against the loaded memberships. Match → that `Identity`. No match → `AuthError`, and the message is identical whether the named household exists (but the caller isn't in it) or doesn't exist at all.
5. Header absent, exactly one membership → use it.
6. Header absent, two or more memberships → `AuthError` naming the header as required. Never pick.

- [ ] **Step 4: Run the tests**

Run: `npm test -- auth`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the architectural regression test**

The `TenantRepo` doc comment states an invariant in prose: no exported function may run a raw query against a domain table; domain access goes through a repository bound to a household. Prose erodes. Pin it as a test.

Create `tests/server/architecture.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// tests/server/architecture.test.ts -> src/server
const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "server");

/**
 * An allowlist, not a denylist: a newly added directory under src/server/ is
 * banned from raw db.prepare(...) by default, not silently permitted.
 *
 * - repos/**: repositories ARE the tenancy layer. TenantRepo prepares scoped
 *   statements itself, and repo methods for join tables (e.g.
 *   TripRepo.addTraveler preparing a direct `INSERT OR IGNORE INTO
 *   trip_person`) legitimately do too, as will later repos for other join
 *   tables.
 * - auth.ts: the documented bootstrap exception. You cannot scope a query by
 *   household before you've resolved which household the request belongs to.
 * - db/**: the migration runner and connection module — below the tenancy
 *   layer entirely.
 *
 * Everything else under src/server/ — routes above all — must go through a
 * repository.
 */
const ALLOWED_DIR_PREFIXES = [`repos${sep}`, `db${sep}`];
const ALLOWED_FILES = ["auth.ts"];

function isAllowed(relPath: string): boolean {
  if (ALLOWED_FILES.includes(relPath)) return true;
  return ALLOWED_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function collectTsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("architecture", () => {
  it("bans raw db.prepare(...) outside repos/, auth.ts, and db/", () => {
    const offenders = collectTsFiles(SERVER_ROOT)
      .filter((file) => !isAllowed(relative(SERVER_ROOT, file)))
      .filter((file) => readFileSync(file, "utf8").includes(".prepare("));

    if (offenders.length > 0) {
      const names = offenders.map((file) => relative(SERVER_ROOT, file)).join(", ");
      throw new Error(
        `Raw db.prepare(...) found outside the repository layer in: ${names}. ` +
          `Domain access against a domain table must go through a repository ` +
          `bound to a household (see src/server/repos/base.ts) — it must not be ` +
          `prepared directly in a route or any other module.`,
      );
    }

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test -- architecture`
Expected: PASS, 1 test. Nothing outside `repos/`, `auth.ts`, or `db/` exists yet that calls `db.prepare(...)` directly, so this is a regression guard rather than a red-green test — it should pass immediately and start failing the moment Task 11 (or anything later) adds a route that reaches for `db.prepare` instead of a repository.

- [ ] **Step 7: Commit**

```bash
git add src/server/auth.ts tests/server/auth.test.ts tests/server/architecture.test.ts
git commit -m "feat: add Cloudflare Access JWT verification as the auth boundary"
```

---

### Task 11: HTTP API

**Files:**
- Create: `src/server/routes/errors.ts`
- Create: `src/server/routes/people.ts`
- Create: `src/server/routes/trips.ts`
- Create: `src/server/routes/itinerary.ts`
- Create: `src/server/index.ts`
- Test: `tests/server/routes/errors.test.ts`
- Test: `tests/server/routes/api.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–10, including `ForbiddenError`, `NotFoundError`, `TenantScopeError` (Task 5) and `AuthError` (Task 10)
- Produces:
  - `type AppEnv`, `type AppDeps = { db, ring, verify }`
  - `createApp(deps: AppDeps): Hono<AppEnv>` — tests call it directly via `app.request()`
  - `mapError(err: unknown): { status: 400 | 401 | 403 | 404 | 500; body: { error: string; details?: unknown } }` — the single place every route funnels a caught error through to decide its HTTP status

Every route below used to do its own `catch (err) { return c.json({ error: String(err) }, 400) }`. That's wrong twice over now: it flattens three distinct repo-layer conditions (`ForbiddenError`, `NotFoundError`, `TenantScopeError`) into one status code, and `String(err)` risks echoing a `TenantScopeError`'s detail — which, by contract, is written for logs, not clients — straight into an HTTP response. `mapError()` replaces all of that with one mapping, used everywhere: `ForbiddenError` → 403, `NotFoundError` → 404, `AuthError` → 401, a Zod validation failure → 400 (naming the invalid fields is fine — that's genuine client error), `TenantScopeError` → 500 with a generic body, and anything unrecognized → 500 generic. There is exactly one place in the codebase that decides a status code from a thrown error.

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/api.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import { AuthError } from "../../../src/server/auth.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const identity: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};

let db: DatabaseSync;
let app: ReturnType<typeof createApp>;

async function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = createTestDatabase();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
    "hh-a",
    "Badger",
    new Date().toISOString(),
  );
  app = createApp({ db, ring, verify: async () => identity });
});

describe("API", () => {
  it("creates and lists people with masked documents", async () => {
    expect((await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).status)
      .toBe(201);

    const body = (await (await app.request("/api/people")).json()) as {
      passportNumberMasked: string;
    }[];
    expect(body[0]?.passportNumberMasked).toBe("••••2119");
    expect(JSON.stringify(body)).not.toContain("C03X72119");
  });

  it("rejects an invalid person payload", async () => {
    expect((await postJson("/api/people", { dob: "2018-04-02" })).status).toBe(400);
  });

  it("returns a per-person itinerary", async () => {
    const person = (await (await postJson("/api/people", { displayName: "Ava" })).json()) as {
      id: string;
    };
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as {
      id: string;
    };
    const booking = (await (
      await postJson(`/api/trips/${trip.id}/bookings`, {
        kind: "other",
        title: "Rehearsal dinner",
        startsAt: "2026-10-10T02:00:00Z",
        startsAtTz: "America/Los_Angeles",
        details: {},
      })
    ).json()) as { id: string };

    expect(
      (await app.request(`/api/bookings/${booking.id}/people/${person.id}`, { method: "PUT" }))
        .status,
    ).toBe(204);

    const days = (await (
      await app.request(`/api/trips/${trip.id}/itinerary?personId=${person.id}`)
    ).json()) as { date: string; bookings: unknown[] }[];

    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe("2026-10-09");
  });

  it("returns 401 when authentication fails", async () => {
    const unauthed = createApp({
      db,
      ring,
      verify: async () => {
        // Real verify() implementations only ever reject with AuthError (Task
        // 10) — that's the contract mapError() relies on to give auth
        // failures their own status independent of the repo-error taxonomy.
        throw new AuthError("nope");
      },
    });
    expect((await unauthed.request("/api/people")).status).toBe(401);
  });

  it("returns 403 when a viewer attempts a write", async () => {
    const viewerApp = createApp({
      db,
      ring,
      verify: async () => ({ ...identity, role: "viewer" }),
    });
    const res = await viewerApp.request("/api/trips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for a resource outside the caller's household", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as {
      id: string;
    };
    const res = await app.request(`/api/trips/${trip.id}/people/does-not-exist`, {
      method: "PUT",
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed request body", async () => {
    const res = await postJson("/api/trips", { title: "" });
    expect(res.status).toBe(400);
  });

  it("reveals a document only on the explicit endpoint", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })
    ).json()) as { id: string };

    const res = await app.request(`/api/people/${person.id}/reveal/passport_number`);
    expect(await res.json()).toEqual({ value: "C03X72119" });
  });

  it("rejects revealing a field that is not a document", async () => {
    expect((await app.request("/api/people/whatever/reveal/display_name")).status).toBe(400);
  });

  it("rejects a booking with an unpaired timezone", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const res = await postJson(`/api/trips/${trip.id}/bookings`, {
      kind: "other",
      title: "No tz",
      startsAt: "2026-10-10T02:00:00Z",
      details: {},
    });
    expect(res.status).toBe(400);
  });

  it("masks booking confirmations in lists and reveals them on request", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const booking = (await (
      await postJson(`/api/trips/${trip.id}/bookings`, {
        kind: "other",
        title: "Hotel",
        confirmationNumber: "ABCDX4T2",
        details: {},
      })
    ).json()) as { id: string };

    const listed = await (await app.request(`/api/trips/${trip.id}/bookings`)).json();
    expect(JSON.stringify(listed)).not.toContain("ABCDX4T2");
    expect(JSON.stringify(listed)).toContain("••••X4T2");

    const revealed = await (
      await app.request(`/api/trips/${trip.id}/bookings/${booking.id}/reveal`)
    ).json();
    expect(revealed).toEqual({ value: "ABCDX4T2" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- routes/api`
Expected: FAIL — cannot resolve `src/server/index.js`.

- [ ] **Step 3: Write the failing test for the shared error-mapping helper**

Create `tests/server/routes/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { mapError } from "../../../src/server/routes/errors.js";
import { ForbiddenError, NotFoundError, TenantScopeError } from "../../../src/server/repos/base.js";
import { AuthError } from "../../../src/server/auth.js";

describe("mapError", () => {
  it("maps ForbiddenError to 403", () => {
    const mapped = mapError(new ForbiddenError("Viewers may not modify data"));
    expect(mapped.status).toBe(403);
  });

  it("maps NotFoundError to 404", () => {
    const mapped = mapError(new NotFoundError("Trip not found in this household"));
    expect(mapped.status).toBe(404);
  });

  it("maps AuthError to 401", () => {
    const mapped = mapError(new AuthError("Missing Cf-Access-Jwt-Assertion"));
    expect(mapped.status).toBe(401);
  });

  it("maps a Zod validation failure to 400 and names the invalid field", () => {
    const result = z.object({ title: z.string().min(1) }).safeParse({ title: "" });
    if (result.success) throw new Error("expected this parse to fail");
    const mapped = mapError(result.error);
    expect(mapped.status).toBe(400);
    expect(JSON.stringify(mapped.body)).toContain("title");
  });

  it("maps TenantScopeError to 500 without disclosing schema detail", () => {
    // A realistic message: base.ts's scopeBug() never puts SQL or column
    // names in a TenantScopeError's own .message, but this test guards the
    // boundary even if that ever slipped — the client-facing body must stay
    // generic regardless of what the message says.
    const mapped = mapError(
      new TenantScopeError(
        "Query must contain exactly one {scope} token outside comments and string literals",
      ),
    );
    expect(mapped.status).toBe(500);
    const serialized = JSON.stringify(mapped.body);
    expect(serialized).toBe(JSON.stringify({ error: "Internal error" }));
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("household_id");
    expect(serialized).not.toMatch(/select|insert|update|delete/i);
  });

  it("maps an unrecognized error to 500 generic", () => {
    const mapped = mapError(new Error("something unexpected"));
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({ error: "Internal error" });
  });
});
```

This is the schema-disclosure regression test: a `TenantScopeError` is exactly the case a scope bug produces, and its whole point is that the client never sees the query shape that tripped it.

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -- routes/errors`
Expected: FAIL — cannot resolve `src/server/routes/errors.js`.

- [ ] **Step 5: Write the shared error-mapping helper**

Create `src/server/routes/errors.ts`:

```ts
import { ZodError } from "zod";
import { ForbiddenError, NotFoundError, TenantScopeError } from "../repos/base.js";
import { AuthError } from "../auth.js";

export type MappedError = {
  status: 400 | 401 | 403 | 404 | 500;
  body: { error: string; details?: unknown };
};

/**
 * The one place that decides which HTTP status a thrown error becomes.
 * Every route that can throw funnels its catch block through this, so there
 * is exactly one status-mapping decision in the codebase rather than one
 * inline in each route.
 *
 * TenantScopeError intentionally gets a generic body: its `.message` is
 * written for logs/grep (see base.ts's `logScopeBug`), not for a client, and
 * surfacing it would hand back exactly the kind of internal detail — which
 * table, which query shape — a scope bug must never disclose over HTTP.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof AuthError) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (err instanceof ForbiddenError) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: "Not found" } };
  }
  if (err instanceof TenantScopeError) {
    return { status: 500, body: { error: "Internal error" } };
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { error: "Invalid request", details: err.issues } };
  }
  return { status: 500, body: { error: "Internal error" } };
}
```

- [ ] **Step 6: Run the error-mapping tests**

Run: `npm test -- routes/errors`
Expected: PASS, 6 tests.

- [ ] **Step 7: Write the people routes**

Create `src/server/routes/people.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { PersonRepo, DOCUMENT_FIELDS } from "../repos/person.js";
import type { DocumentField } from "../repos/person.js";
import type { AppEnv } from "../index.js";
import { mapError } from "./errors.js";

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

export const people = new Hono<AppEnv>();

people.get("/", (c) => {
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(repo.list());
});

people.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // A JSON.parse-level SyntaxError, not a repo error — mapError() doesn't
    // recognize it, and its generic 500 fallback would be the wrong status
    // for a client that simply sent malformed JSON. Handle it here, directly,
    // without echoing the parser's own message.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createPersonSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid person", details: parsed.error.issues }, 400);
  }
  try {
    const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
    return c.json(repo.create(parsed.data), 201);
  } catch (err) {
    // A viewer role reaching requireWrite() lands here as ForbiddenError.
    const mapped = mapError(err);
    return c.json(mapped.body, mapped.status);
  }
});

people.get("/:id/reveal/:field", (c) => {
  const field = c.req.param("field");
  if (!DOCUMENT_FIELDS.includes(field as DocumentField)) {
    // A client-supplied field outside the allowlist is genuine bad input —
    // handled here, directly, as its own 400. (revealDocument() would also
    // reject it, but as a TenantScopeError/500: a caller inside our own code
    // that skipped this check would be the bug at that point, not the client.)
    return c.json({ error: `"${field}" is not a revealable document field` }, 400);
  }

  const identity = c.get("identity");
  const repo = new PersonRepo(c.get("db"), identity, c.get("ring"));
  const value = repo.revealDocument(c.req.param("id"), field as DocumentField);

  // The spec requires document reveals to be logged.
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

- [ ] **Step 8: Write the trips and itinerary routes**

Create `src/server/routes/trips.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { TripRepo } from "../repos/trip.js";
import { BookingRepo } from "../repos/booking.js";
import type { AppEnv } from "../index.js";
import { mapError } from "./errors.js";

const createTripSchema = z.object({
  title: z.string().min(1),
  destination: z.string().optional(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  notes: z.string().optional(),
});

const createBookingSchema = z
  .object({
    kind: z.string().min(1),
    title: z.string().min(1),
    location: z.string().optional(),
    startsAt: z.string().optional(),
    startsAtTz: z.string().optional(),
    endsAt: z.string().optional(),
    endsAtTz: z.string().optional(),
    confirmationNumber: z.string().optional(),
    costCents: z.number().int().optional(),
    pointsUsed: z.number().int().optional(),
    pointsProgram: z.string().optional(),
    status: z.enum(["draft", "planned", "booked", "cancelled"]).optional(),
    details: z.unknown(),
  })
  // Mirrors BookingRepo.create()'s assertTimezonePaired() at the API boundary,
  // so a malformed request fails as a genuine 400 (Zod, via mapError) before
  // it ever reaches the repo. The repo-level check stays too — belt and
  // braces for any non-HTTP caller — so this is deliberately redundant.
  .refine((v) => !v.startsAt || v.startsAtTz, {
    message: "startsAt requires startsAtTz (an IANA timezone)",
    path: ["startsAtTz"],
  })
  .refine((v) => !v.endsAt || v.endsAtTz, {
    message: "endsAt requires endsAtTz (an IANA timezone)",
    path: ["endsAtTz"],
  });

export const trips = new Hono<AppEnv>();

trips.get("/", (c) => c.json(new TripRepo(c.get("db"), c.get("identity")).list()));

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
  try {
    return c.json(new TripRepo(c.get("db"), c.get("identity")).create(parsed.data), 201);
  } catch (err) {
    // A viewer role reaching requireWrite() lands here as ForbiddenError.
    const mapped = mapError(err);
    return c.json(mapped.body, mapped.status);
  }
});

trips.get("/:tripId/bookings", (c) =>
  c.json(
    new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).listByTrip(
      c.req.param("tripId"),
    ),
  ),
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
  try {
    return c.json(repo.create({ ...parsed.data, tripId: c.req.param("tripId") }), 201);
  } catch (err) {
    // Unknown trip (NotFoundError) and per-kind detail validation (ZodError,
    // from parseDetails) land here.
    const mapped = mapError(err);
    return c.json(mapped.body, mapped.status);
  }
});

trips.get("/:tripId/bookings/:bookingId/reveal", (c) => {
  const identity = c.get("identity");
  const repo = new BookingRepo(c.get("db"), identity, c.get("ring"));
  const value = repo.revealConfirmation(c.req.param("bookingId"));

  // The spec requires reveals to be logged.
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

trips.put("/:tripId/people/:personId", (c) => {
  try {
    new TripRepo(c.get("db"), c.get("identity")).addTraveler(
      c.req.param("tripId"),
      c.req.param("personId"),
    );
    return c.body(null, 204);
  } catch (err) {
    // Unknown trip/person in this household (NotFoundError, 404) or a viewer
    // role (ForbiddenError, 403) land here.
    const mapped = mapError(err);
    return c.json(mapped.body, mapped.status);
  }
});
```

Create `src/server/routes/itinerary.ts`:

```ts
import { Hono } from "hono";
import { ItineraryRepo } from "../repos/itinerary.js";
import { BookingRepo } from "../repos/booking.js";
import type { AppEnv } from "../index.js";
import { mapError } from "./errors.js";

export const itinerary = new Hono<AppEnv>();

itinerary.get("/trips/:tripId/itinerary", (c) => {
  const repo = new ItineraryRepo(c.get("db"), c.get("identity"), c.get("ring"));
  const tripId = c.req.param("tripId");
  const personId = c.req.query("personId");
  return c.json(personId ? repo.forPerson(tripId, personId) : repo.forTrip(tripId));
});

itinerary.put("/bookings/:bookingId/people/:personId", (c) => {
  try {
    new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).assignPerson(
      c.req.param("bookingId"),
      c.req.param("personId"),
    );
    return c.body(null, 204);
  } catch (err) {
    // Unknown booking/person in this household (NotFoundError, 404) or a
    // viewer role (ForbiddenError, 403) land here.
    const mapped = mapError(err);
    return c.json(mapped.body, mapped.status);
  }
});
```

- [ ] **Step 9: Write the app entry point**

Create `src/server/index.ts`:

```ts
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { Keyring } from "./crypto/envelope.js";
import type { Identity } from "./auth.js";
import { people } from "./routes/people.js";
import { trips } from "./routes/trips.js";
import { itinerary } from "./routes/itinerary.js";
import { mapError } from "./routes/errors.js";

export type AppEnv = {
  Variables: {
    db: DatabaseSync;
    ring: Keyring;
    identity: Identity;
  };
};

export type AppDeps = {
  db: DatabaseSync;
  ring: Keyring;
  verify: (req: Request) => Promise<Identity>;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    try {
      c.set("identity", await deps.verify(c.req.raw));
    } catch (err) {
      // deps.verify()'s contract (Task 10) is to reject only with AuthError,
      // so routing this through the same mapError() every other route uses
      // still lands on 401 — one status-mapping decision, not a special case
      // carved out for auth.
      const mapped = mapError(err);
      return c.json(mapped.body, mapped.status);
    }
    c.set("db", deps.db);
    c.set("ring", deps.ring);
    await next();
  });

  app.route("/api/people", people);
  app.route("/api/trips", trips);
  app.route("/api", itinerary);

  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
```

- [ ] **Step 10: Run the tests**

Run: `npm test -- routes/api`
Expected: PASS, 11 tests.

- [ ] **Step 11: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 12: Commit**

```bash
git add src/server/routes src/server/index.ts tests/server/routes
git commit -m "feat: add HTTP API for people, trips, bookings, and itineraries"
```

---

## Not in this plan

Deliberately deferred to follow-on plans, in suggested order:

1. **Server bootstrap and NixOS deployment** — a `serve.ts` binding `127.0.0.1` (the spec requires this; binding `0.0.0.0` lets the LAN bypass Access entirely), the systemd unit, agenix key wiring, `cloudflared` config, and the Access application and policies. This plan produces `createApp()` but nothing that listens on a socket.
2. **Frontend restructure** — blocked on the UI design decisions listed in `docs/HANDOFF.md`. Do not start until the per-person day view shape is chosen.
3. **Email ingestion** — the Worker shim, the `/api/inbound-email` route, `.ics` parsing, LLM fallback, and Access service-token auth.
4. **Offline caching** of the active trip.
5. **Household bootstrap CLI** — creating the first household, user, and membership. Until it exists these rows are inserted by hand; every test in this plan does exactly that.

## Self-review notes

- **Spec coverage:** success criteria 1, 2, 3, and 7 are covered. Criterion 4 (reachable, LAN does not bypass) is partially covered — JWT verification is built in Task 10, but the `127.0.0.1` bind belongs to the deployment plan. Criteria 5 (email drafts) and 6 (offline) are entirely in later plans. The `booking.status` enum includes `'draft'` here so email ingestion needs no migration later.
- **Intentionally uncovered:** `checklist_item` and `loyalty_account` have tables but no repositories. Checklists belong with the frontend plan that renders them; loyalty accounts belong to phase 2.
- **Known constraint:** `TenantRepo` accepts exactly one `{scope}` token per query. A query spanning two scoped tables must join through one — `TripRepo.travelers` and both `ItineraryRepo` queries do this deliberately. The household id is spliced in at the token's position rather than bound first, so placeholders may appear on either side of it.
- **Deviation from spec, documented in Task 4:** the `key_id` is packed into the ciphertext envelope rather than stored in a separate column, which preserves incremental key migration without adding three columns to `person`.
- **Scope addition, documented in Task 8:** booking confirmation numbers are encrypted and masked here rather than in a later plan. They identify a reservation to anyone reading the database, the design already renders them masked, and folding it in now avoids changing `BookingRepo`'s constructor signature after four call sites exist.
