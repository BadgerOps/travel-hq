# Travel HQ Frontend Shell and Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-file card-optimizer UI with a routed, trips-first shell and a working Home/Today page rendering real data from the phase-1 API.

**Architecture:** The existing `src/main.tsx` splits into a router, a shell with top nav, and page components. The Nocturne token sheet replaces the current palette. Data comes from a typed API client that imports its types directly from the server code — no duplicated interfaces, no codegen. Home/Today switches between an active-trip hero and an idle hero based on whether a trip covers today.

**Tech Stack:** React 19, TypeScript 5.7, Vite 6, `wouter` (router), `@phosphor-icons/react`, Vitest + Testing Library + jsdom.

## Prerequisites

**This plan depends on `2026-07-20-backend-foundation.md` being complete.** It consumes `/api/people`, `/api/trips`, `/api/trips/:id/bookings`, and `/api/trips/:id/itinerary`, and it imports types from `src/server/repos/`. Do not start until that plan's Task 11 is committed and `npm test` is green.

**Task 0 adds the only two endpoints this plan needs that the backend does not already have** — `GET /api/me` and `GET /api/trips/:tripId/travelers` — and, more importantly, makes the app reachable at all: nothing in the repository currently starts a server, proxies `/api` in dev, or creates the first household. Do Task 0 first; every later task is unverifiable in a browser without it.

## Global Constraints

- **`docs/design/` is the source of truth for visual values.** Read `docs/design/README.md` before Task 1. When this plan and the design bundle disagree on a number, the bundle wins; when they disagree on *architecture*, `docs/superpowers/specs/2026-07-20-travel-hq-family-redesign-design.md` wins.
- **When the design bundle disagrees with itself, `README.md` wins.** It does so exactly once, and it is settled — do not re-litigate this: `nocturne-tokens.css` gives `.nav` `padding: var(--space-3) var(--space-4)` and `border-bottom: none`, while `README.md` specifies "14px 28px padding, bottom divider". The README is the written intent and the prototype renders the divider, so Task 1's `.top-nav` uses `14px 28px` with a `--color-divider` bottom border. The token sheet's `.nav` rule is left untouched for anything else that uses it.
- **The design bundle predates the Cloudflare pivot.** Ignore its references to `user`/`session` tables and to `trips@hq.badger.lan`. The forward address is `trips@badgerops.foo`.
- **Primary buttons are accent-OUTLINED, never filled.** The only saturated fill in the system is the hero panel gradient.
- **Headings are weight 500, never bolder.**
- **Horizontal rules fade to transparent at both ends** (48px ramp). Use `.hr`; do not write `border-top`.
- **No trip cover photos.** Upload is deferred with the attachments work; do not build a dead upload affordance. Trip cards render without the photo header.
- **Confirmation numbers render masked** (`••••X4T2`) with tap-to-reveal, and reveals hit the logging endpoint.
- **Fluid layouts only** — `auto-fit`/`minmax()` and `flex-wrap`. No breakpoint-specific layouts. Verify at 390px.
- **No remote asset requests.** Phase 1 includes offline caching; Inter is self-hosted, not imported from Google Fonts.
- Tests use Vitest + Testing Library. Every task ends with a commit.

---

## File Structure

```
src/client/
  main.tsx              ← root render + router mount only
  styles.css            ← Nocturne tokens + component classes
  fonts/                ← self-hosted Inter woff2
  api/
    client.ts           ← fetch wrapper, typed against server types
    types.ts            ← re-exports server types for client use
    identity.tsx        ← GET /api/me once, shared by context
  lib/
    dates.ts            ← countdown, local-date, dual-timezone formatting
    errors.ts           ← status → a sentence a person can act on
  components/
    Shell.tsx           ← top nav + page outlet
    PersonChip.tsx      ← 22px avatar chip, colour derived from person id
    MaskedValue.tsx     ← ••••1234 with tap-to-reveal + logged reveal
  pages/
    Home.tsx            ← greeting, hero row, trips grid
    Trips.tsx           ← stub in this plan
    Checklist.tsx       ← stub in this plan
    People.tsx          ← stub in this plan
    Import.tsx          ← placeholder so the nav's Import button resolves
  home/
    ActiveTripHero.tsx
    IdleTripHero.tsx
    NextBestActions.tsx
    TripCard.tsx
tests/client/…          ← mirrors src/client
```

Rationale: `home/` holds components used only by Home, so they stay out of the shared `components/` namespace until something else needs them. `api/` is the only place that knows about HTTP.

Task 0 additionally touches the server:

```
src/server/
  serve.ts              ← the real process entrypoint (deps + listen)
scripts/
  seed.ts               ← creates the first household/user/member/person
```

---

### Task 0: Make the app reachable

**Why this task exists:** `createApp()` in `src/server/index.ts` is only ever called from tests. There is no process that listens, `vite.config.ts` has no `server.proxy`, and nothing ever inserts a `household`/`user`/`household_member` row. `auth.ts` correctly refuses to invent a household, so against a fresh database every `/api/*` request is a 401 — which means every screen Tasks 1–6 build, and every screen plan 3 builds, renders nothing but an error. Without this task the rest of the plan is unverifiable by a human.

**Files:**
- Create: `src/server/serve.ts`
- Create: `scripts/seed.ts`
- Modify: `src/server/index.ts` (adds `GET /api/me`)
- Modify: `src/server/routes/trips.ts` (adds `GET /api/trips/:tripId/travelers`)
- Modify: `vite.config.ts`, `package.json`, `.gitignore`
- Test: `tests/server/routes/api.test.ts` (two new cases)

**Interfaces:**
- Produces: `npm run dev:server`, `npm run seed`, a `/api` dev proxy, `GET /api/me` → `Identity`, `GET /api/trips/:tripId/travelers` → `Person[]`
- Consumes: `openDatabase`, `migrate`, `loadKeyring`, `createAccessVerifier` — all already implemented on `main`

**Scope discipline:** exactly two new endpoints. `GET /api/trips/:id` and `GET /api/trips/:tripId/checklist` were considered and rejected — the client already gets the full trip from `GET /api/trips`, and the checklist route is plan 3's to add alongside its repository. Do not add either here.

- [ ] **Step 1: Install the server runtime and pick a TypeScript runner**

```bash
npm install @hono/node-server
npm install -D tsx
```

**Runner decision: `tsx`, not a `tsc`-to-`dist` build step.**

There is deliberately no `dev:server` script today, and `node src/server/index.ts` cannot be reintroduced: Node's strip-only TypeScript execution does not rewrite `.js` import specifiers to the `.ts` files on disk (this codebase writes `./routes/trips.js` throughout) and rejects constructor parameter properties (`private readonly ring: Keyring` in `PersonRepo`, `BookingRepo`, `Keyring`). Both appear in nearly every server file, so the strip-only path is closed.

Of the two real options:

- **`tsx`** — one dev dependency, esbuild-backed, resolves `.js` specifiers to their `.ts` sources and compiles parameter properties. No build artefact, no second tsconfig, no rebuild between edits, and `--watch` gives restart-on-save for free.
- **`tsc` → `dist/`** — needs a third tsconfig, because `tsconfig.server.json` is `noEmit: true` with `verbatimModuleSyntax` and `moduleResolution: bundler`; emitting would mean duplicating and diverging that config, adding a build step ahead of every run, and keeping `dist/` out of git.

`tsx` wins on cost for a single-household home server: the only thing the build step buys is not shipping a compiler to production, which is not a constraint here. `serve.ts` is written as a plain module with no tsx-specific API, so a `tsc` build can be added later without touching it.

Note that `node:sqlite` still needs its flag: every script that opens the database passes `NODE_OPTIONS=--experimental-sqlite`, exactly as the existing `test` script does.

- [ ] **Step 2: Write the failing route tests**

Append to `tests/server/routes/api.test.ts` inside the existing `describe("API", ...)` block:

```ts
  it("returns the caller's identity from /api/me", async () => {
    const body = (await (await app.request("/api/me")).json()) as typeof identity;
    expect(body).toEqual({
      userId: "u1",
      email: "badger@example.com",
      householdId: "hh-a",
      role: "owner",
    });
  });

  it("lists a trip's travelers with documents still masked", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })
    ).json()) as { id: string };
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as {
      id: string;
    };

    expect(
      (await app.request(`/api/trips/${trip.id}/people/${person.id}`, { method: "PUT" }))
        .status,
    ).toBe(204);

    const res = await app.request(`/api/trips/${trip.id}/travelers`);
    const body = (await res.json()) as { id: string; displayName: string }[];
    expect(body.map((p) => p.displayName)).toEqual(["Ava"]);
    expect(JSON.stringify(body)).not.toContain("C03X72119");
  });
```

Run: `npm test`
Expected: FAIL, both new cases — neither route is registered, so Hono returns 404 and the JSON body is not the expected shape.

- [ ] **Step 3: Add `GET /api/me`**

The client needs its own identity for three things the design requires and this plan cannot otherwise build: the nav user-avatar chip, the "Good morning, {user}" greeting, and — most importantly — knowing whether the caller is a `viewer`, since the reveal endpoints return **403** for that role and the client currently has no way to find out before clicking.

In `src/server/index.ts`, inside `createApp`, add immediately above the `app.route(...)` calls:

```ts
  // The identity middleware above has already resolved this from the Access
  // token and a confirmed household membership, so this route invents
  // nothing -- it only hands back what the server already decided. It sits
  // under /api/* deliberately, so an unauthenticated caller gets the same
  // 401 here as anywhere else rather than a probe point.
  app.get("/api/me", (c) => c.json(c.get("identity")));
```

- [ ] **Step 4: Add `GET /api/trips/:tripId/travelers`**

`TripRepo.travelers()` exists and is tested but was never routed. Plan 3's travelers rail needs it, and Home needs person records to render chips without loading every booking.

In `src/server/routes/trips.ts`, add `PersonRepo` to the imports:

```ts
import { PersonRepo } from "../repos/person.js";
```

and add the route:

```ts
trips.get("/:tripId/travelers", (c) => {
  const identity = c.get("identity");
  const db = c.get("db");
  // Both calls are household-scoped by TenantRepo, so a cross-household
  // tripId simply yields no person ids -- it cannot leak a foreign roster.
  const ids = new Set(new TripRepo(db, identity).travelers(c.req.param("tripId")));
  const people = new PersonRepo(db, identity, c.get("ring")).list();
  return c.json(people.filter((p) => ids.has(p.id)));
});
```

Documents stay masked: this returns `PersonRepo.list()`'s already-masked `Person`, never plaintext. Note that `travelers()` returns `[]` rather than throwing for an unknown trip id — deliberate here, since an empty roster and a nonexistent trip are the same non-answer, and distinguishing them would be a trip-existence oracle.

- [ ] **Step 5: Run the route tests**

Run: `npm test`
Expected: PASS — `routes/api.test.ts` grows from 21 cases to 23.

- [ ] **Step 6: Write the server entrypoint**

Create `src/server/serve.ts`:

```ts
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "./index.js";
import { openDatabase } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { loadKeyring } from "./crypto/envelope.js";
import { createAccessVerifier, AuthError } from "./auth.js";
import type { Identity } from "./auth.js";
import type { Keyring } from "./crypto/envelope.js";
import type { Role } from "./repos/base.js";

/**
 * Development must be opted INTO explicitly. Do not write this as
 * `NODE_ENV === "production"` -- that fails open: systemd units do not set
 * NODE_ENV by default, so an unset variable would silently mean "development"
 * on the deployed host, where the two branches guarded by this flag are the
 * auth bypass and the keyring generator. An operator who forgets one
 * environment variable would get a server willing to accept TRAVEL_HQ_DEV_EMAIL
 * and willing to mint a fresh encryption key over an existing database,
 * orphaning every passport number already stored.
 *
 * Unset therefore means production, and a laptop must say so on purpose.
 */
const isDevelopment = process.env.TRAVEL_HQ_ENV === "development";
const isProduction = !isDevelopment;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/**
 * `loadKeyring()` has existed since the backend plan and until now was never
 * called from anywhere -- this is where it gets wired up.
 *
 * In production the agenix-managed key file must exist. Generating one on the
 * fly there would be silently catastrophic: every passport number and
 * confirmation number already in the database is sealed under the old key and
 * would become permanently undecryptable, with no error at startup and a
 * throw only on the next read. So production fails loudly instead.
 *
 * In development there is no agenix, so a missing key file is generated once
 * and persisted at a gitignored path. Persisting rather than generating
 * per-run matters: a fresh key each boot would orphan every value the
 * previous run wrote.
 */
function resolveKeyring(): Keyring {
  const path = process.env.TRAVEL_HQ_KEY_FILE ?? ".dev-secrets/keyring.key";

  if (!existsSync(path)) {
    if (isProduction) {
      throw new Error(
        `Key file ${path} is missing. Refusing to generate one in production: ` +
          `a new key cannot decrypt anything already stored. Provision the ` +
          `agenix secret and set TRAVEL_HQ_KEY_FILE.`,
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `dev-v1 ${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    console.warn(`[dev] generated a development keyring at ${path} -- not for production`);
  }

  return loadKeyring(path);
}

/**
 * Local development has no Cloudflare tunnel in front of it, so no request
 * carries a Cf-Access-Jwt-Assertion header and the real verifier 401s every
 * one of them -- which would make the whole UI unusable on a laptop.
 *
 * This resolves an identity the same way `createAccessVerifier` does once the
 * JWT checks out: by looking up a confirmed household membership for an
 * email. It never invents a household, and it refuses to exist in production.
 */
function createDevVerifier(db: DatabaseSync, email: string) {
  if (isProduction) {
    throw new Error("TRAVEL_HQ_DEV_EMAIL must never be set in production");
  }
  console.warn(`[dev] AUTH BYPASS ACTIVE -- every request acts as ${email}`);

  return async function verify(): Promise<Identity> {
    const row = db
      .prepare(
        `SELECT u.id AS user_id, u.email, hm.household_id, hm.role
           FROM user u
           JOIN household_member hm ON hm.user_id = u.id
          WHERE u.email = ?
          ORDER BY hm.household_id`,
      )
      .get(email) as
      | { user_id: string; email: string; household_id: string; role: Role }
      | undefined;

    if (!row) {
      throw new AuthError(`No household membership for ${email}. Run \`npm run seed\`.`);
    }
    return {
      userId: row.user_id,
      email: row.email,
      householdId: row.household_id,
      role: row.role,
    };
  };
}

const db = openDatabase(process.env.TRAVEL_HQ_DB ?? "travel-hq.db");
migrate(db);

const devEmail = process.env.TRAVEL_HQ_DEV_EMAIL;
const verify = devEmail
  ? createDevVerifier(db, devEmail)
  : createAccessVerifier({
      teamDomain: required("CF_ACCESS_TEAM_DOMAIN"),
      audience: required("CF_ACCESS_AUD"),
      db,
    });

const app = createApp({ db, ring: resolveKeyring(), verify });
const port = Number(process.env.PORT ?? 8787);

// 127.0.0.1, never 0.0.0.0. The app is reached through the Cloudflare Tunnel,
// which is the only thing that authenticates a caller; `cloudflared` connects
// from this same host, so loopback is all it needs. Binding 0.0.0.0 would
// publish an unauthenticated copy of the entire API to the LAN, letting any
// device on the network read every passport number without ever passing
// through Access. This is the single most consequential line in the file.
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`travel-hq listening on http://127.0.0.1:${info.port}`);
});
```

**The bypass must be covered by a test, and that constrains this file's shape.**

An auth bypass whose fencing is never exercised is one careless refactor away from
being unfenced, and nothing would fail. But `serve.ts` as written opens a database
and starts listening at import time, so a test cannot import it without launching a
server.

So do not leave the decision inline. Export a pure, side-effect-free function from
`serve.ts`:

```ts
export function resolveVerifier(
  env: NodeJS.ProcessEnv,
  db: DatabaseSync,
): (req: Request) => Promise<Identity>
```

It takes the environment rather than reading `process.env` directly, contains the
`isDevelopment` decision and the production throw, and is called by the top-level
wiring. Keep the module's top-level code to construction and `serve()` only.

Then test it, with `tests/server/serve.test.ts`:

- `TRAVEL_HQ_ENV` unset **and** `TRAVEL_HQ_DEV_EMAIL` set → **throws**. This is the
  systemd case and the single most important assertion in the file.
- `TRAVEL_HQ_ENV=production` with `TRAVEL_HQ_DEV_EMAIL` set → throws.
- `TRAVEL_HQ_ENV=development` with `TRAVEL_HQ_DEV_EMAIL` set → returns a verifier
  that resolves a seeded member, and **still rejects an email with no membership**
  (the bypass skips the JWT, never the membership check).
- No `TRAVEL_HQ_DEV_EMAIL` → returns the real Access verifier, and it rejects a
  request carrying no `Cf-Access-Jwt-Assertion` header.

- [ ] **Step 7: Write the seed script**

**Seed decision: a script, not a bootstrap endpoint.** An unauthenticated `POST /api/bootstrap` would have to be reachable precisely when no identity exists to authorize it — a permanently open, household-creating endpoint sitting behind nothing, which is a worse hazard than the inconvenience it removes. A script runs on the host, where filesystem access to the sqlite file is already the trust boundary. It is also idempotent, so re-running it is safe.

Create `scripts/seed.ts`:

```ts
import { openDatabase } from "../src/server/db/connection.js";
import { migrate } from "../src/server/db/migrate.js";
import { newId } from "../src/server/ids.js";

// Parameterised by email so the seeded user matches whatever identity
// Cloudflare Access will forward -- verify() looks up membership by the
// token's email claim, so a mismatch here is an unfixable 401 later.
const email = process.env.SEED_EMAIL ?? process.argv[2];
if (!email) {
  console.error("Usage: SEED_EMAIL=you@example.com npm run seed");
  process.exit(1);
}
const householdName = process.env.SEED_HOUSEHOLD ?? "Home";
const personName = process.env.SEED_PERSON ?? email.split("@")[0]!;
const role = process.env.SEED_ROLE ?? "owner";

const db = openDatabase(process.env.TRAVEL_HQ_DB ?? "travel-hq.db");
migrate(db);

const existing = db.prepare("SELECT id FROM user WHERE email = ?").get(email) as
  | { id: string }
  | undefined;

if (existing) {
  console.log(`${email} already exists; nothing to do.`);
  process.exit(0);
}

const now = new Date().toISOString();
const householdId = newId();
const userId = newId();

db.prepare("BEGIN").run();
try {
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
    householdId,
    householdName,
    now,
  );
  db.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)").run(
    userId,
    email,
    now,
  );
  db.prepare(
    "INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, ?)",
  ).run(householdId, userId, role);
  // At least one person: the traveler chips, the People page, and every
  // booking assignment are dead ends without one.
  db.prepare(
    `INSERT INTO person (id, household_id, user_id, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId(), householdId, userId, personName, now);
  db.prepare("COMMIT").run();
} catch (err) {
  db.prepare("ROLLBACK").run();
  throw err;
}

console.log(`Seeded household ${householdId} with ${email} as ${role}.`);
```

- [ ] **Step 8: Add the scripts and gitignore the dev secrets**

Add to `package.json` scripts:

```json
    "dev:server": "NODE_OPTIONS=--experimental-sqlite tsx watch src/server/serve.ts",
    "start": "NODE_OPTIONS=--experimental-sqlite tsx src/server/serve.ts",
    "seed": "NODE_OPTIONS=--experimental-sqlite tsx scripts/seed.ts"
```

Append to `.gitignore` (create it if absent):

```
.dev-secrets/
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 9: Add the dev proxy**

Without this, `fetch("/api/trips")` in dev hits Vite's dev server, which knows nothing about `/api` and returns its index.html or a 404 — so the client fails at JSON parsing rather than at anything diagnosable.

Replace `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
```

- [ ] **Step 10: Verify by hand against a real HTTP response**

This is the step that proves the app is reachable. Run each of these and check the stated output — "the tests pass" is not sufficient evidence here.

```bash
SEED_EMAIL=you@example.com npm run seed
# → "Seeded household <uuid> with you@example.com as owner."

TRAVEL_HQ_ENV=development TRAVEL_HQ_DEV_EMAIL=you@example.com npm run dev:server &
# → "travel-hq listening on http://127.0.0.1:8787"

curl -s http://127.0.0.1:8787/healthz
# → ok

curl -s http://127.0.0.1:8787/api/me
# → {"userId":"...","email":"you@example.com","householdId":"...","role":"owner"}

curl -s http://127.0.0.1:8787/api/people
# → a one-element array whose displayName is the seeded person

curl -s http://127.0.0.1:8787/api/trips
# → []
```

Then confirm the bind is loopback-only, using the host's own LAN address:

```bash
curl -s --max-time 3 http://$(hostname -I | awk '{print $1}'):8787/healthz
# → must FAIL to connect. A reply here means the API is exposed to the
#   network without Access in front of it -- stop and fix the hostname.
```

Finally, with `npm run dev` also running, load `http://localhost:5173/` and confirm the browser's network tab shows `/api/trips` returning 200 through the proxy rather than HTML.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: add server entrypoint, seed script, dev proxy, and /api/me + travelers routes"
```

---

### Task 1: Nocturne tokens, self-hosted Inter, and the icon swap

**Files:**
- Modify: `src/client/styles.css`
- Create: `src/client/fonts/` (woff2 files)
- Modify: `package.json`
- Modify: `src/client/main.tsx`

**Interfaces:**
- Produces: every token in `docs/design/nocturne-tokens.css` available as a CSS custom property, plus the `.btn`, `.card`, `.tag`, `.input`, `.seg`, `.hr` component classes the later tasks use by name.

- [ ] **Step 1: Swap the icon library**

```bash
npm uninstall lucide-react
npm install @phosphor-icons/react
```

- [ ] **Step 2: Self-host Inter**

The token sheet's first line is `@import url('https://fonts.googleapis.com/css2?...')`. That is a remote request, and phase 1 caches the active trip for offline use — a remote font means the cached page renders in a fallback face exactly when the tunnel is down.

```bash
mkdir -p src/client/fonts
npm install -D @fontsource/inter
cp node_modules/@fontsource/inter/files/inter-latin-{400,500,600,700}-normal.woff2 src/client/fonts/
```

- [ ] **Step 3: Replace styles.css with the token sheet**

Copy `docs/design/nocturne-tokens.css` over `src/client/styles.css` wholesale — it replaces the old `--bg`/`--panel`/`--accent` palette rather than extending it.

Then delete its first line (the Google Fonts `@import`) and put this at the top in its place:

> **Do not re-merge the raw token sheet later.** `docs/design/nocturne-tokens.css` line 1 is a `@import url('https://fonts.googleapis.com/...')`, which violates both the spec's offline requirement and this plan's "no remote asset requests" constraint. Any future refresh of the tokens from the design bundle must drop that line again and keep the `@font-face` block below. Task 1 Step 6 is the guard.

```css
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("./fonts/inter-latin-400-normal.woff2") format("woff2");
}
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("./fonts/inter-latin-500-normal.woff2") format("woff2");
}
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("./fonts/inter-latin-600-normal.woff2") format("woff2");
}
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("./fonts/inter-latin-700-normal.woff2") format("woff2");
}
```

- [ ] **Step 4: Add the app-specific classes the token sheet does not carry**

Append to `src/client/styles.css`:

```css
/* ── App-specific, built on the Nocturne tokens ─────────────────────────── */

/* The one saturated fill in the system. Active-trip hero only. */
.hero-active {
  background: linear-gradient(135deg, #262a60 0%, #1a1c33 55%, var(--color-bg) 100%);
  border: 1px solid var(--color-accent-800);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
}
.hero-idle {
  background: linear-gradient(135deg, #1a1c33 0%, var(--color-bg) 100%);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
}

/* Person avatar chip — 22px circle, 10px/600 initial. */
.person-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
.person-chips { display: inline-flex; align-items: center; gap: 4px; }

/* Masked value with tap-to-reveal. Dotted underline signals the affordance. */
.masked {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  border-bottom: 1px dotted color-mix(in srgb, var(--color-text) 45%, transparent);
}
.masked:hover { color: var(--color-accent); }

/* Time gutter used by the hero's "rest of today" list. */
.time-gutter {
  width: 58px;
  flex: none;
  text-align: right;
  font-size: 12.5px;
  color: color-mix(in srgb, var(--color-text) 55%, transparent);
}

.warning { color: #d9b98a; }

/* Top nav. 14px 28px + bottom divider per docs/design/README.md, which wins
   over the token sheet's own `.nav` rule (space-3/space-4, no divider) — see
   the Global Constraints note. `.top-nav` is bespoke rather than `.nav`
   because of that divergence, which is exactly why the active-link styling
   below has to be restated here: the token sheet scopes its
   `[aria-current='page']` rule to `.nav a`, so a `.top-nav` link would carry
   the attribute for screen readers and look identical to every other link. */
.top-nav {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 14px 28px;
  border-bottom: 1px solid var(--color-divider);
  flex-wrap: wrap;
}
.top-nav a {
  color: inherit;
  text-decoration: none;
  font-size: 13.5px;
  padding-bottom: 2px;
  /* Transparent by default so gaining the accent underline does not shift
     the row by 2px. */
  border-bottom: 2px solid transparent;
}
.top-nav a:hover { color: var(--color-accent); }
.top-nav a[aria-current="page"] {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}
/* The brand and the Import button are links too, but neither is a nav item;
   they opt out of the underline treatment. */
.top-nav a.nav-brand,
.top-nav a.btn { border-bottom: none; padding-bottom: 0; }

/* User avatar chip in the nav (design README: "· user avatar chip"). Reuses
   the person-chip geometry at nav scale. */
.nav-user {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  user-select: none;
  background: var(--color-accent-800);
  color: var(--color-accent-100);
}

.page { padding: var(--space-8) 28px; max-width: 1240px; margin: 0 auto; }
```

`#d9b98a` is the only non-token colour in the system, reserved for expiry and unbooked warnings.

Because `.top-nav a` now carries the colour, font size, and underline, Task 2's `Shell` must **not** set `color`/`textDecoration`/`fontSize` inline on nav links: an inline `color: inherit` beats a stylesheet rule on specificity and would silently erase the active state again.

- [ ] **Step 5: Verify the build still succeeds**

Run: `npm run build`
Expected: exits 0. `src/client/main.tsx` still imports `./styles.css`, so the new tokens apply; the old component markup will look wrong until Task 2 replaces it, which is expected.

- [ ] **Step 6: Verify no remote requests remain**

Run: `grep -n "fonts.googleapis\|https://" src/client/styles.css`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/client/styles.css src/client/fonts
git commit -m "feat: adopt Nocturne tokens, self-host Inter, swap to phosphor icons"
```

---

### Task 2: Router, shell, and page stubs

**Files:**
- Modify: `src/client/main.tsx`
- Create: `src/client/components/Shell.tsx`
- Create: `src/client/pages/Home.tsx`
- Create: `src/client/pages/Trips.tsx`
- Create: `src/client/pages/Checklist.tsx`
- Create: `src/client/pages/People.tsx`
- Create: `src/client/pages/Import.tsx`
- Create: `vitest.client.config.ts`
- Create: `tsconfig.test.json`
- Modify: `vitest.config.ts`, `tsconfig.server.json`, `package.json`
- Test: `tests/client/Shell.test.tsx`

**Interfaces:**
- Produces: `Shell` (renders nav + children, takes an optional `identity`), routes `/`, `/trips`, `/checklist`, `/people`, `/import`. Later tasks fill `Home`; the rest stay stubs.

- [ ] **Step 1: Install the router and client test tooling**

```bash
npm install wouter
npm install -D "@testing-library/react@^16" @testing-library/jest-dom @testing-library/user-event jsdom
```

`@testing-library/react` is **pinned to `^16` deliberately**: React 19 support landed in v16, and v14/v15 declare a `react@^18` peer and fail with `ERESOLVE` against this project's React 19. A bare `npm install @testing-library/react` happens to resolve to 16 today; the range makes that guaranteed rather than lucky.

`@testing-library/user-event` is installed here, not later, because Task 4's `MaskedValue.test.tsx` imports it at Step 6 and must fail on a *missing component*, not a missing module.

`wouter` over `react-router`: this app has a handful of flat routes and no data loaders, and wouter is ~2kB against react-router's ~20kB. Nothing here needs the larger API.

- [ ] **Step 2: Split the two test configs so every test runs exactly once, in the right environment**

Both configs must change together. As written today, `vitest.client.config.ts` collects only `.tsx`, so `tests/client/api/client.test.ts` (Task 3) and `tests/client/lib/dates.test.ts` (Task 4) are collected by **zero** client runs — while the root `vitest.config.ts` (`include: ["tests/**/*.test.ts"]`, `environment: "node"`) silently *does* collect them and runs them in the server suite's node environment, with no jsdom and no jest-dom setup.

Create `vitest.client.config.ts`:

```ts
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
```

Modify `vitest.config.ts` so the server run stops claiming the client's `.ts` tests:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // tests/client belongs to vitest.client.config.ts. Without this exclude
    // the client's plain-.ts tests run twice: once correctly under jsdom and
    // once here under node, where `document` does not exist.
    exclude: ["tests/client/**", "node_modules/**"],
    environment: "node",
    pool: "forks",
  },
});
```

Create `tests/client/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Put the client tests under a tsconfig**

Right now `npm run typecheck` never looks at them: `tsconfig.app.json` includes only `src/client`, and `tsconfig.server.json` includes `tests/**/*.ts` — which covers `tests/client/api/client.test.ts` with node types and no DOM, and covers nothing at all under `tests/client/**/*.tsx`. jest-dom's matchers (`toBeInTheDocument`, `toHaveAttribute`) are in no `types` array either, so a broken test file typechecks clean.

Narrow `tsconfig.server.json`'s include so it stops reaching into the client tests:

```json
  "include": ["src/server/**/*.ts", "tests/server/**/*.ts"]
```

Create `tsconfig.test.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["tests/client/**/*.ts", "tests/client/**/*.tsx", "vitest.client.config.ts"]
}
```

It is a standalone project, deliberately not added to `tsconfig.json`'s `references` array: `tsc -b` requires every referenced project to set `composite: true`, and turning that on here would mean emitting declaration output for test files. Extending the `typecheck` script is simpler and checks the same code.

Add to `package.json` scripts, replacing the existing `typecheck`:

```json
    "test:client": "vitest run -c vitest.client.config.ts",
    "test:all": "npm test && npm run test:client",
    "typecheck": "tsc -b && tsc -p tsconfig.server.json && tsc -p tsconfig.test.json"
```

- [ ] **Step 4: Write the failing test**

Create `tests/client/Shell.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Shell } from "../../src/client/components/Shell.js";

function renderAt(path: string, identity?: { email: string; role: string }) {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <Shell identity={identity as never}>
        <p>page content</p>
      </Shell>
    </Router>,
  );
}

describe("Shell", () => {
  it("renders the brand and the primary nav links", () => {
    renderAt("/");
    expect(screen.getByText("Travel HQ")).toBeInTheDocument();
    for (const label of ["Today", "Trips", "Checklist", "People"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the current route as the active page", () => {
    renderAt("/trips");
    expect(screen.getByRole("link", { name: "Trips" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders the cards stub as non-interactive", () => {
    renderAt("/");
    const cards = screen.getByText(/Cards/);
    expect(cards.tagName).not.toBe("A");
  });

  it("renders its children", () => {
    renderAt("/");
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("shows a user avatar chip once the identity is known, and nothing before", () => {
    const { unmount } = renderAt("/");
    expect(screen.queryByTitle(/badger@example.com/)).not.toBeInTheDocument();
    unmount();

    renderAt("/", { email: "badger@example.com", role: "owner" });
    expect(screen.getByTitle("badger@example.com")).toHaveTextContent("B");
  });
});
```

The third test encodes a design decision: "Cards · soon" is a muted stub, not a link — phase 2 builds it. The fifth covers the design README's "· user avatar chip": it renders only once `GET /api/me` has resolved, so the nav must not reserve or flash a placeholder.

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm run test:client`
Expected: FAIL — cannot resolve `src/client/components/Shell.js`.

- [ ] **Step 6: Write the Shell**

Create `src/client/components/Shell.tsx`:

```tsx
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { PaperPlaneTilt, TrayArrowDown } from "@phosphor-icons/react";

const NAV = [
  { href: "/", label: "Today" },
  { href: "/trips", label: "Trips" },
  { href: "/checklist", label: "Checklist" },
  { href: "/people", label: "People" },
];

export function Shell({
  children,
  identity,
}: {
  children: ReactNode;
  /**
   * From `GET /api/me`; null/undefined until it resolves. Typed structurally
   * rather than importing `Identity`, so this task does not depend on Task 3's
   * `api/types.ts` existing yet — the real `Identity` satisfies this shape.
   */
  identity?: { email: string; role: string } | null;
}) {
  const [location] = useLocation();

  return (
    <>
      <nav className="top-nav">
        <Link
          href="/"
          className="nav-brand"
          style={{ display: "flex", alignItems: "center", gap: 8, marginRight: "auto" }}
        >
          <PaperPlaneTilt size={20} color="var(--color-accent)" weight="regular" />
          <span style={{ fontSize: 16, fontWeight: 500 }}>Travel HQ</span>
        </Link>

        {/* No inline color/textDecoration/fontSize here: `.top-nav a` in
            styles.css owns them, and an inline `color` would outrank the
            `[aria-current='page']` accent rule, leaving the active page
            announced to screen readers but invisible to everyone else. */}
        {NAV.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={location === href ? "page" : undefined}
          >
            {label}
          </Link>
        ))}

        {/* Phase 2. Deliberately not a link. */}
        <span className="text-muted" style={{ fontSize: 13.5 }}>
          Cards · soon
        </span>

        <Link
          href="/import"
          className="btn btn-secondary"
          aria-current={location === "/import" ? "page" : undefined}
        >
          <TrayArrowDown size={16} />
          Import
        </Link>

        {identity && (
          <span className="nav-user" title={identity.email}>
            {identity.email.slice(0, 1).toUpperCase()}
          </span>
        )}
      </nav>

      <main className="page">{children}</main>
    </>
  );
}
```

Note the `Import` link now also gets `aria-current`, so the design README's "accent border when on the import page" comes from the same rule as every other nav item.

- [ ] **Step 7: Write the page stubs, including `/import`**

Create `src/client/pages/Trips.tsx`, `src/client/pages/Checklist.tsx`, `src/client/pages/People.tsx`, and `src/client/pages/Import.tsx`. Each is the same shape — here is `Trips.tsx`; write the others identically with their own heading and copy:

```tsx
export function Trips() {
  return (
    <>
      <h3>Trips</h3>
      <p className="text-muted">Not built yet — see plan 3.</p>
    </>
  );
}
```

`Checklist.tsx` exports `Checklist` with heading "Checklist". `People.tsx` exports `People` with heading "People".

**`Import.tsx` is not optional.** `Shell` renders `<Link href="/import">Import</Link>` as the nav's most prominent control, and Import is deferred out of both this plan and plan 3 — so without a route the single most visible button in the app lands on "Not found". Resolved by adding an honest placeholder, exactly as `/people` is handled, rather than by hiding the button: the design puts Import in the nav, and removing it would misrepresent the shape of the app to the family testing it.

```tsx
export function Import() {
  return (
    <>
      <h3>Import</h3>
      <p className="text-muted">
        Not built yet — paste, forward, and upload land in plan 4. Bookings can be
        created through the API until then.
      </p>
    </>
  );
}
```

Create `src/client/pages/Home.tsx` as a placeholder Task 5 replaces:

```tsx
export function Home() {
  return <h3>Today</h3>;
}
```

- [ ] **Step 8: Rewrite main.tsx as a router mount**

Replace the entire contents of `src/client/main.tsx` — all ~430 lines of the old card-optimizer UI, including the `cards`, `trips`, `categories`, and `recommendations` arrays — with:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Shell } from "./components/Shell.js";
import { Home } from "./pages/Home.js";
import { Trips } from "./pages/Trips.js";
import { Checklist } from "./pages/Checklist.js";
import { People } from "./pages/People.js";
import { Import } from "./pages/Import.js";
import "./styles.css";

function App() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/trips" component={Trips} />
        <Route path="/checklist" component={Checklist} />
        <Route path="/people" component={People} />
        <Route path="/import" component={Import} />
        <Route>
          <h3>Not found</h3>
        </Route>
      </Switch>
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

This deletes the card optimizer outright. The design has been repositioned trips-first; the optimizer returns in phase 2 driven by a rules engine, not the hardcoded map.

`App` does not pass `identity` to `Shell` yet — Task 3 Step 6 adds the `GET /api/me` fetch that supplies it.

- [ ] **Step 9: Run the tests**

Run: `npm run test:client`
Expected: PASS, 5 tests.

- [ ] **Step 10: Verify the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: add router, shell nav, and page stubs; remove card optimizer UI"
```

---

### Task 3: Typed API client

**Files:**
- Create: `src/client/api/types.ts`
- Create: `src/client/api/client.ts`
- Create: `src/client/api/identity.tsx`
- Modify: `src/client/main.tsx`
- Test: `tests/client/api/client.test.ts`

**Interfaces:**
- Consumes: `Person`, `Trip`, `Booking`, `ItineraryDay` from `src/server/repos/` and `Identity` from `src/server/auth.ts` (type-only imports, erased at build); `GET /api/me` from Task 0
- Produces: `api.me()`, `api.people.list()`, `api.people.reveal(id, field)`, `api.trips.list()`, `api.trips.bookings(tripId)`, `api.trips.itinerary(tripId, personId?)`, `ApiError`, and `IdentityProvider`/`useIdentity`/`useCanReveal`

- [ ] **Step 1: Write the failing test**

Create `tests/client/api/client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createApi, ApiError } from "../../../src/client/api/client.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("lists trips", async () => {
    const fetchMock = mockFetch(200, [{ id: "t1", title: "Guerneville" }]);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.list()).toEqual([{ id: "t1", title: "Guerneville" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/trips", expect.anything());
  });

  it("passes personId through to the itinerary endpoint", async () => {
    const fetchMock = mockFetch(200, []);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.itinerary("t1", "p-ava");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/itinerary?personId=p-ava",
      expect.anything(),
    );
  });

  it("omits the query string when no person is given", async () => {
    const fetchMock = mockFetch(200, []);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.itinerary("t1");
    expect(fetchMock).toHaveBeenCalledWith("/api/trips/t1/itinerary", expect.anything());
  });

  it("throws ApiError carrying the status on a failure", async () => {
    const api = createApi({ fetch: mockFetch(401, { error: "Unauthorized" }), baseUrl: "" });
    await expect(api.trips.list()).rejects.toThrow(ApiError);
    await expect(api.trips.list()).rejects.toMatchObject({ status: 401 });
  });

  it("reveals a booking confirmation", async () => {
    const fetchMock = mockFetch(200, { value: "ABCDX4T2" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.revealConfirmation("t1", "b1")).toEqual({ value: "ABCDX4T2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/bookings/b1/reveal",
      expect.anything(),
    );
  });

  it("fetches the caller's identity", async () => {
    const fetchMock = mockFetch(200, {
      userId: "u1",
      email: "badger@example.com",
      householdId: "hh-a",
      role: "owner",
    });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect((await api.me()).role).toBe("owner");
    expect(fetchMock).toHaveBeenCalledWith("/api/me", expect.anything());
  });

  it("url-encodes path parameters", async () => {
    const fetchMock = mockFetch(200, []);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.bookings("a/../b");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/a%2F..%2Fb/bookings",
      expect.anything(),
    );
  });
});
```

The last test matters: trip ids reach the client from user-controlled data, and an unencoded `/` would let a crafted id reshape the request path.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- api/client`
Expected: FAIL — cannot resolve `src/client/api/client.js`.

- [ ] **Step 3: Re-export the server types**

Create `src/client/api/types.ts`:

```ts
/**
 * The client shares the server's domain types directly. These are type-only
 * imports, erased at build, so no server code reaches the browser bundle — and
 * a schema change breaks the client at typecheck rather than at runtime.
 */
export type { Person, DocumentField } from "../../server/repos/person.js";
export type { Trip, TripStatus } from "../../server/repos/trip.js";
export type { Booking, BookingStatus } from "../../server/repos/booking.js";
export type { ItineraryDay } from "../../server/repos/itinerary.js";
export type { Role } from "../../server/repos/base.js";
export type { Identity } from "../../server/auth.js";
```

`Identity` is what `GET /api/me` returns, so re-exporting it keeps the same guarantee as every other type here: if the server ever adds a field to `Identity` or renames a `Role`, the client fails at typecheck rather than silently mis-branching on `role`.

- [ ] **Step 4: Write the client**

Create `src/client/api/client.ts`:

```ts
import type {
  Booking,
  DocumentField,
  Identity,
  ItineraryDay,
  Person,
  Trip,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type ApiConfig = {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
};

export function createApi(config: ApiConfig = {}) {
  const doFetch = config.fetch ?? globalThis.fetch;
  const baseUrl = config.baseUrl ?? "";

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      credentials: "same-origin",
      ...init,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // Non-JSON error body; the status line is all we have.
      }
      throw new ApiError(`${path} failed: ${detail}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const seg = (s: string) => encodeURIComponent(s);

  return {
    me: () => request<Identity>("/api/me"),
    people: {
      list: () => request<Person[]>("/api/people"),
      reveal: (id: string, field: DocumentField) =>
        request<{ value: string | null }>(`/api/people/${seg(id)}/reveal/${seg(field)}`),
    },
    trips: {
      list: () => request<Trip[]>("/api/trips"),
      bookings: (tripId: string) =>
        request<Booking[]>(`/api/trips/${seg(tripId)}/bookings`),
      revealConfirmation: (tripId: string, bookingId: string) =>
        request<{ value: string | null }>(
          `/api/trips/${seg(tripId)}/bookings/${seg(bookingId)}/reveal`,
        ),
      itinerary: (tripId: string, personId?: string) =>
        request<ItineraryDay[]>(
          `/api/trips/${seg(tripId)}/itinerary${
            personId ? `?personId=${encodeURIComponent(personId)}` : ""
          }`,
        ),
    },
  };
}

export const api = createApi();
```

- [ ] **Step 5: Add the identity context**

One `GET /api/me` per page load, shared by everything that needs it: the nav avatar, Home's greeting, and — the reason this is a context rather than a prop — `MaskedValue`, which is rendered several components deep from three different parents and must not offer a reveal affordance to a `viewer`.

Create `src/client/api/identity.tsx`:

```tsx
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api as defaultApi } from "./client.js";
import type { Identity } from "./types.js";

const IdentityContext = createContext<Identity | null>(null);

export function useIdentity(): Identity | null {
  return useContext(IdentityContext);
}

/**
 * Whether to offer a reveal affordance at all. The reveal endpoints return
 * 403 for `viewer`, so showing one to a viewer is an affordance that can only
 * ever fail.
 *
 * Unknown identity (still loading, or /api/me itself failed) fails OPEN, and
 * deliberately: this governs presentation only, and the server is the thing
 * that actually enforces the rule. Failing closed would hide a working button
 * from an owner for as long as the request is in flight.
 */
export function useCanReveal(): boolean {
  return useIdentity()?.role !== "viewer";
}

export function IdentityProvider({
  api = defaultApi,
  children,
}: {
  api?: Pick<typeof defaultApi, "me">;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.me().then(
      (me) => {
        if (!cancelled) setIdentity(me);
      },
      () => {
        // Swallowed on purpose. A failing /api/me means the session is gone,
        // which every data-fetching page reports for itself with a much more
        // useful message than a nav chip could -- see Home's error panel.
        // Duplicating it here would show two errors for one cause.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>;
}
```

- [ ] **Step 6: Wire it into main.tsx**

In `src/client/main.tsx`, add the imports:

```tsx
import { IdentityProvider, useIdentity } from "./api/identity.js";
```

and replace `App` with:

```tsx
function ShellWithIdentity({ children }: { children: React.ReactNode }) {
  return <Shell identity={useIdentity()}>{children}</Shell>;
}

function App() {
  return (
    <IdentityProvider>
      <ShellWithIdentity>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/trips" component={Trips} />
          <Route path="/checklist" component={Checklist} />
          <Route path="/people" component={People} />
          <Route path="/import" component={Import} />
          <Route>
            <h3>Not found</h3>
          </Route>
        </Switch>
      </ShellWithIdentity>
    </IdentityProvider>
  );
}
```

`ShellWithIdentity` exists because `useIdentity()` has to be called *inside* the provider, and `App` itself renders it.

- [ ] **Step 7: Run the tests**

Run: `npm run test:client -- api/client`
Expected: PASS, 7 tests.

- [ ] **Step 8: Commit**

```bash
git add src/client/api src/client/main.tsx tests/client/api
git commit -m "feat: add typed API client and identity context sharing server types"
```

---

### Task 4: Date helpers and shared components

**Files:**
- Create: `src/client/lib/dates.ts`
- Create: `src/client/components/PersonChip.tsx`
- Create: `src/client/components/MaskedValue.tsx`
- Test: `tests/client/lib/dates.test.ts`
- Test: `tests/client/components/MaskedValue.test.tsx`

**Interfaces:**
- Produces:
  - `daysUntil(isoDate, today): number`, `countdownLabel(startsOn, endsOn, today): string`, `isActiveOn(trip, today): boolean`, `formatTimeInZone(utcInstant, tz): string`, `formatDualZone(startUtc, startTz, endUtc, endTz): string`
  - `PersonChip({ person })`, `personColor(personId)`
  - `MaskedValue({ masked, onReveal })`

- [ ] **Step 1: Write the failing date test**

Create `tests/client/lib/dates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  countdownLabel,
  daysUntil,
  formatDualZone,
  formatTimeInZone,
  isActiveOn,
} from "../../../src/client/lib/dates.js";

describe("dates", () => {
  it("counts whole days until a future date", () => {
    expect(daysUntil("2026-10-09", "2026-07-20")).toBe(81);
  });

  it("returns zero on the day itself", () => {
    expect(daysUntil("2026-07-20", "2026-07-20")).toBe(0);
  });

  it("returns a negative count for past dates", () => {
    expect(daysUntil("2026-07-19", "2026-07-20")).toBe(-1);
  });

  it("labels a trip happening today", () => {
    expect(countdownLabel("2026-10-09", "2026-10-11", "2026-10-10")).toBe("Today");
  });

  it("labels a future trip in days", () => {
    expect(countdownLabel("2026-10-09", "2026-10-11", "2026-07-20")).toBe("In 81 days");
  });

  it("labels a past trip", () => {
    expect(countdownLabel("2026-10-09", "2026-10-11", "2026-12-01")).toBe("Past");
  });

  it("treats the first and last day as active", () => {
    const trip = { startsOn: "2026-10-09", endsOn: "2026-10-11" };
    expect(isActiveOn(trip, "2026-10-09")).toBe(true);
    expect(isActiveOn(trip, "2026-10-11")).toBe(true);
    expect(isActiveOn(trip, "2026-10-12")).toBe(false);
  });

  it("treats a trip with no dates as never active", () => {
    expect(isActiveOn({ startsOn: null, endsOn: null }, "2026-10-09")).toBe(false);
  });

  it("treats a start with no end as a single active day", () => {
    const trip = { startsOn: "2026-10-09", endsOn: null };
    expect(isActiveOn(trip, "2026-10-08")).toBe(false);
    expect(isActiveOn(trip, "2026-10-09")).toBe(true);
    expect(isActiveOn(trip, "2026-10-10")).toBe(false);
  });

  it("formats a UTC instant in its own zone", () => {
    expect(formatTimeInZone("2026-10-10T04:00:00Z", "America/Boise")).toBe("10:00 PM");
  });

  it("shows both zones when they differ", () => {
    expect(
      formatDualZone(
        "2026-10-10T05:30:00Z",
        "America/Boise",
        "2026-10-10T11:00:00Z",
        "America/New_York",
      ),
    ).toBe("11:30 PM MDT → 7:00 AM EDT");
  });

  it("shows one zone when both endpoints share it", () => {
    expect(
      formatDualZone(
        "2026-10-10T01:00:00Z",
        "America/Boise",
        "2026-10-10T03:00:00Z",
        "America/Boise",
      ),
    ).toBe("7:00 PM → 9:00 PM MDT");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- lib/dates`
Expected: FAIL — cannot resolve `src/client/lib/dates.js`.

- [ ] **Step 3: Write the date helpers**

Create `src/client/lib/dates.ts`:

```ts
const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `today` to `isoDate`, both plain YYYY-MM-DD calendar dates.
 * Parsed as UTC midnight deliberately: these are calendar dates with no time or
 * zone, and parsing them as local time makes the count off by one either side
 * of midnight depending on the viewer's offset.
 */
export function daysUntil(isoDate: string, today: string): number {
  const target = Date.parse(`${isoDate}T00:00:00Z`);
  const from = Date.parse(`${today}T00:00:00Z`);
  return Math.round((target - from) / MS_PER_DAY);
}

/**
 * A trip is active on `today` if today falls inside [startsOn, endsOn].
 *
 * `endsOn` is optional in the schema and often absent for single-day trips and
 * for anything still being planned. Requiring both dates would mean such a
 * trip is never active on any day — so Home would show the idle hero on the
 * very morning the family is travelling. A missing `endsOn` therefore means a
 * one-day trip, not an unbounded one: an open-ended end date would make an
 * old trip active forever.
 */
export function isActiveOn(
  trip: { startsOn: string | null; endsOn: string | null },
  today: string,
): boolean {
  if (!trip.startsOn) return false;
  return today >= trip.startsOn && today <= (trip.endsOn ?? trip.startsOn);
}

export function countdownLabel(
  startsOn: string | null,
  endsOn: string | null,
  today: string,
): string {
  if (!startsOn) return "Unscheduled";
  // No `endsOn &&` guard: isActiveOn now handles a missing end date itself,
  // and gating on it here would relabel a mid-trip day as "Past".
  if (isActiveOn({ startsOn, endsOn }, today)) return "Today";
  const days = daysUntil(startsOn, today);
  if (days < 0) return "Past";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export function formatTimeInZone(utcInstant: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(utcInstant));
}

function zoneAbbrev(utcInstant: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(new Date(utcInstant));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/**
 * A flight departing 6pm Boise and arriving 11pm Atlanta is not a five-hour
 * flight. Both endpoints render in their own zone, with the abbreviation shown
 * once when they match and on both sides when they do not.
 */
export function formatDualZone(
  startUtc: string,
  startTz: string,
  endUtc: string,
  endTz: string,
): string {
  const start = formatTimeInZone(startUtc, startTz);
  const end = formatTimeInZone(endUtc, endTz);
  const startAbbr = zoneAbbrev(startUtc, startTz);
  const endAbbr = zoneAbbrev(endUtc, endTz);

  return startAbbr === endAbbr
    ? `${start} → ${end} ${endAbbr}`
    : `${start} ${startAbbr} → ${end} ${endAbbr}`;
}
```

- [ ] **Step 4: Run the date tests**

Run: `npm run test:client -- lib/dates`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write PersonChip**

Create `src/client/components/PersonChip.tsx`:

```tsx
import type { Person } from "../api/types.js";

/**
 * Per-person colours come from a fixed palette indexed by a hash of the person
 * id, so a given person keeps the same colour across every screen without
 * storing a colour on the row.
 */
const PALETTE = [
  { bg: "var(--color-accent-700)", fg: "var(--color-accent-100)" },
  { bg: "var(--color-accent-2-800)", fg: "var(--color-accent-2-200)" },
  { bg: "var(--color-neutral-700)", fg: "var(--color-neutral-100)" },
  { bg: "#4c5397", fg: "var(--color-accent-200)" },
];

export function personColor(personId: string): { bg: string; fg: string } {
  let hash = 0;
  for (const ch of personId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

export function PersonChip({ person }: { person: Pick<Person, "id" | "displayName"> }) {
  const { bg, fg } = personColor(person.id);
  return (
    <span
      className="person-chip"
      style={{ background: bg, color: fg }}
      title={person.displayName}
    >
      {person.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PersonChips({
  people,
}: {
  people: Pick<Person, "id" | "displayName">[];
}) {
  return (
    <span className="person-chips">
      {people.map((p) => (
        <PersonChip key={p.id} person={p} />
      ))}
    </span>
  );
}
```

- [ ] **Step 6: Write the failing MaskedValue test**

Create `tests/client/components/MaskedValue.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MaskedValue } from "../../../src/client/components/MaskedValue.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity } from "../../../src/client/api/types.js";

function asRole(role: Identity["role"], ui: ReactNode) {
  const me = async () => ({
    userId: "u1",
    email: "badger@example.com",
    householdId: "hh-a",
    role,
  });
  return render(<IdentityProvider api={{ me } as never}>{ui}</IdentityProvider>);
}

describe("MaskedValue", () => {
  it("renders the masked form initially", () => {
    render(<MaskedValue masked="••••X4T2" onReveal={async () => "ABCDX4T2"} />);
    expect(screen.getByRole("button")).toHaveTextContent("••••X4T2");
  });

  it("reveals the plaintext on click", async () => {
    render(<MaskedValue masked="••••X4T2" onReveal={async () => "ABCDX4T2"} />);
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("ABCDX4T2")).toBeInTheDocument();
  });

  it("calls onReveal exactly once across repeated clicks", async () => {
    const onReveal = vi.fn(async () => "ABCDX4T2");
    render(<MaskedValue masked="••••X4T2" onReveal={onReveal} />);
    const button = screen.getByRole("button");
    await userEvent.click(button);
    await userEvent.click(button);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when there is no value", () => {
    const { container } = render(<MaskedValue masked={null} onReveal={async () => null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers no reveal affordance to a viewer", async () => {
    const onReveal = vi.fn(async () => "ABCDX4T2");
    asRole("viewer", <MaskedValue masked="••••X4T2" onReveal={onReveal} />);
    expect(await screen.findByText("••••X4T2")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("reports a rejected reveal instead of throwing", async () => {
    render(
      <MaskedValue
        masked="••••X4T2"
        onReveal={async () => {
          throw new Error("403");
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText(/not allowed to see this/i)).toBeInTheDocument();
  });
});
```

The third test matters because every reveal is logged server-side — re-fetching on each click would spam the audit log with duplicates.

The last two exist because the reveal endpoints return **403** for the `viewer` role. Without them a viewer clicking the affordance gets an unhandled promise rejection and no feedback at all: the button silently re-enables and nothing on screen changes. The fifth test asserts the affordance is not offered in the first place; the sixth asserts that a rejection from any cause — a 403 the identity check missed, a 500, a dropped tunnel — still renders something honest.

- [ ] **Step 7: Run it to verify it fails**

Run: `npm run test:client -- MaskedValue`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 8: Write MaskedValue**

Create `src/client/components/MaskedValue.tsx`:

```tsx
import { useState } from "react";
import { useCanReveal } from "../api/identity.js";

export function MaskedValue({
  masked,
  onReveal,
}: {
  masked: string | null;
  onReveal: () => Promise<string | null>;
}) {
  const canReveal = useCanReveal();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (masked === null) return null;
  if (revealed !== null) return <span>{revealed}</span>;

  // A viewer's reveal is a guaranteed 403 (the repos throw ForbiddenError for
  // that role), so rendering a button would be an affordance that can only
  // fail. Plain text, no dotted underline, no hover: nothing to click.
  if (!canReveal) {
    return (
      <span title="Only owners and adults can reveal stored numbers">{masked}</span>
    );
  }

  if (failed) {
    return (
      <span className="warning" title="The server refused this reveal">
        {masked} · not allowed to see this
      </span>
    );
  }

  return (
    <button
      type="button"
      className="masked"
      disabled={busy}
      title="Click to reveal — access is logged"
      onClick={async () => {
        setBusy(true);
        try {
          setRevealed(await onReveal());
        } catch {
          // The reveal endpoints return a deliberately generic body (403
          // "Forbidden", 500 "Internal error"), so there is no detail worth
          // surfacing -- only the fact that it did not happen. Swallowing
          // this without setting state is what left a viewer with a button
          // that visibly did nothing.
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {masked}
    </button>
  );
}
```

`useCanReveal()` returns `true` outside any `IdentityProvider` (the default context is `null`), so the four tests that render `MaskedValue` bare still get a button.

- [ ] **Step 9: Run the tests**

`@testing-library/user-event` was already installed in Task 2 Step 1.

Run: `npm run test:client`
Expected: PASS — 5 Shell, 7 api, 12 dates, 6 MaskedValue.

- [ ] **Step 10: Commit**

```bash
git add src/client/lib src/client/components tests/client/lib tests/client/components
git commit -m "feat: add date helpers, person chips, and masked-value reveal"
```

---

### Task 5: Home — greeting and hero row

**Files:**
- Modify: `src/client/pages/Home.tsx`
- Create: `src/client/home/ActiveTripHero.tsx`
- Create: `src/client/home/IdleTripHero.tsx`
- Create: `src/client/lib/errors.ts`
- Test: `tests/client/lib/errors.test.ts`
- Test: `tests/client/pages/Home.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 3), `useIdentity` (Task 3), `isActiveOn`/`countdownLabel`/`formatTimeInZone` (Task 4), `PersonChips` (Task 4)
- Produces: `Home` fetching trips and rendering either hero; `ActiveTripHero({ trip, day, people, now, onReveal })`, `IdleTripHero({ trip, today })`, `errorMessage(err)`

**The hero is sourced from the itinerary endpoint, not from the raw bookings list.** The design asks for "NEXT UP · IN 40 MIN" plus a list of what remains *today*. Sorting every booking on the trip and taking the first gives day 1's already-departed flight on day 2, labelled "NOW". Filtering client-side would mean reimplementing day boundaries in each booking's own timezone — which `ItineraryRepo.group()` already does correctly on the server, skipping unformattable rows as it goes. So Home asks for `api.trips.itinerary(tripId)` and takes the `ItineraryDay` whose `date` matches today; the only client-side filter left is "starts at or after now", which needs no timezone reasoning because both sides are instants.

- [ ] **Step 1: Write the failing test**

Create `tests/client/pages/Home.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Home } from "../../../src/client/pages/Home.js";

const TRIP_ACTIVE = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "active" as const,
  notes: null,
};

const TRIP_FUTURE = { ...TRIP_ACTIVE, startsOn: "2027-01-01", endsOn: "2027-01-05" };

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    tripId: "t1",
    kind: "flight",
    title: "DL1422 BOI → ATL",
    location: null,
    startsAt: "2026-10-09T15:00:00Z",
    startsAtTz: "America/Boise",
    endsAt: "2026-10-09T21:15:00Z",
    endsAtTz: "America/New_York",
    confirmationNumberMasked: "••••X4T2",
    costCents: 42000,
    pointsUsed: null,
    pointsProgram: null,
    status: "booked" as const,
    details: {},
    personIds: ["p-badger"],
    ...over,
  };
}

const BOOKING = booking();
const PEOPLE = [{ id: "p-badger", displayName: "Badger" }];

/**
 * `days` is what GET /api/trips/:id/itinerary returns: bookings already
 * grouped into calendar days in each booking's own timezone, by the server.
 */
function renderHome(
  trips: unknown[],
  days: unknown[],
  today: string,
  now = new Date(`${today}T12:00:00Z`),
  overrides: Record<string, unknown> = {},
) {
  const api = {
    me: vi.fn(async () => {
      throw new Error("not used");
    }),
    trips: {
      list: vi.fn(async () => trips),
      bookings: vi.fn(async () => days.flatMap((d) => (d as { bookings: unknown[] }).bookings)),
      itinerary: vi.fn(async () => days),
      revealConfirmation: vi.fn(async () => ({ value: "ABCDX4T2" })),
    },
    people: { list: vi.fn(async () => PEOPLE), reveal: vi.fn() },
    ...overrides,
  };
  const { hook } = memoryLocation({ path: "/" });
  return render(
    <Router hook={hook}>
      <Home api={api as never} today={today} now={now} />
    </Router>,
  );
}

describe("Home", () => {
  it("shows the active hero when a trip covers today", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    expect(await screen.findByText(/NEXT UP · IN 40 MIN/i)).toBeInTheDocument();
    expect(screen.getByText("DL1422 BOI → ATL")).toBeInTheDocument();
  });

  it("never shows a departed booking as next up", async () => {
    // Mid-trip: one booking this morning that has already happened, one
    // tonight that has not. Sorting the whole trip and taking [0] picks the
    // wrong one and labels it "NOW".
    const past = booking({ id: "b-past", title: "Breakfast at the inn", startsAt: "2026-10-10T14:00:00Z" });
    const next = booking({ id: "b-next", title: "Rehearsal dinner", startsAt: "2026-10-10T23:00:00Z" });
    renderHome(
      [TRIP_ACTIVE],
      [{ date: "2026-10-10", bookings: [past, next] }],
      "2026-10-10",
      new Date("2026-10-10T18:00:00Z"),
    );

    expect(await screen.findByText("Rehearsal dinner")).toBeInTheDocument();
    expect(screen.queryByText("Breakfast at the inn")).not.toBeInTheDocument();
    expect(screen.queryByText(/NOW/)).not.toBeInTheDocument();
  });

  it("shows the idle hero when no trip covers today", async () => {
    renderHome([TRIP_FUTURE], [], "2026-07-20");
    expect(await screen.findByText(/Next trip/i)).toBeInTheDocument();
    expect(screen.queryByText(/NEXT UP/i)).not.toBeInTheDocument();
  });

  it("masks the confirmation number in the hero", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    expect(await screen.findByText("••••X4T2")).toBeInTheDocument();
  });

  it("renders an empty state when there are no trips", async () => {
    renderHome([], [], "2026-07-20");
    expect(await screen.findByText(/No trips yet/i)).toBeInTheDocument();
  });

  it("greets the user", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09");
    expect(await screen.findByText(/Good (morning|afternoon|evening)/)).toBeInTheDocument();
  });

  it("reports an expired session rather than a raw error string", async () => {
    renderHome([], [], "2026-07-20", undefined, {
      trips: {
        list: vi.fn(async () => {
          throw new ApiError("/api/trips failed: Unauthorized", 401);
        }),
        bookings: vi.fn(),
        itinerary: vi.fn(),
        revealConfirmation: vi.fn(),
      },
    });
    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/ApiError/)).not.toBeInTheDocument();
  });
});
```

Add `ApiError` to the imports at the top of the file:

```tsx
import { ApiError } from "../../../src/client/api/client.js";
```

`Home` takes `api`, `today`, and `now` as props so tests can inject all three. The real mount passes the module singleton and the actual clock. `now` is separate from `today` because the hero needs an instant ("is this booking still ahead of us?") while the trip grid needs a calendar date.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- pages/Home`
Expected: FAIL — `Home` does not accept those props and renders only a heading.

- [ ] **Step 3: Write ActiveTripHero**

Create `src/client/home/ActiveTripHero.tsx`:

```tsx
import { AirplaneTakeoff, Bed, Car, ForkKnife, Confetti } from "@phosphor-icons/react";
import type { Booking, ItineraryDay, Person, Trip } from "../api/types.js";
import { formatTimeInZone } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";
import { MaskedValue } from "../components/MaskedValue.js";

const KIND_ICON = {
  flight: AirplaneTakeoff,
  lodging: Bed,
  car: Car,
  activity: Confetti,
  other: ForkKnife,
} as const;

function iconFor(kind: string) {
  return KIND_ICON[kind as keyof typeof KIND_ICON] ?? ForkKnife;
}

function minutesUntil(startsAt: string, now: Date): number {
  return Math.round((Date.parse(startsAt) - now.getTime()) / 60_000);
}

/**
 * `minutes` can no longer be negative — everything past has been filtered out
 * before this is called — so "NOW" is reserved for the event that is starting
 * this minute rather than being pinned on anything already over. That
 * mislabelling was the bug: on day 2 of a trip the hero announced day 1's
 * departed flight as happening NOW.
 */
function untilLabel(minutes: number): string {
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `IN ${minutes} MIN`;
  return `IN ${Math.round(minutes / 60)} HR`;
}

export function ActiveTripHero({
  trip,
  day,
  people,
  now,
  onReveal,
}: {
  trip: Trip;
  /**
   * Today's `ItineraryDay` from GET /api/trips/:id/itinerary, or undefined if
   * today has no entries. The server has already grouped bookings into
   * calendar days in each booking's own timezone and sorted them ascending —
   * do not regroup or re-sort here.
   */
  day: ItineraryDay | undefined;
  people: Pick<Person, "id" | "displayName">[];
  now: Date;
  onReveal: (bookingId: string) => Promise<string | null>;
}) {
  // The only client-side filter, and it needs no timezone reasoning: both
  // sides are absolute instants. Everything still ahead of us today, in
  // order; the server's ORDER BY starts_at is preserved.
  const upcoming = (day?.bookings ?? []).filter(
    (b) => b.startsAt !== null && Date.parse(b.startsAt) >= now.getTime(),
  );

  const [next, ...rest] = upcoming;
  if (!next) {
    return (
      <div className="hero-active" style={{ flex: "1.5 1 480px" }}>
        <h6 style={{ color: "var(--color-accent-300)" }}>{trip.title}</h6>
        <p className="text-muted">
          {day && day.bookings.length > 0
            ? "Nothing else scheduled today."
            : "Nothing scheduled today."}
        </p>
      </div>
    );
  }

  const NextIcon = iconFor(next.kind);
  const peopleOn = (b: Booking) => people.filter((p) => b.personIds.includes(p.id));

  return (
    <div className="hero-active" style={{ flex: "1.5 1 480px" }}>
      <h6 style={{ color: "var(--color-accent-300)" }}>
        NEXT UP · {untilLabel(minutesUntil(next.startsAt!, now))}
      </h6>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
        <NextIcon size={30} color="var(--color-accent)" />
        <div>
          <div style={{ fontSize: 18, fontWeight: 500 }}>{next.title}</div>
          <div style={{ fontSize: 12.5 }} className="text-muted">
            {formatTimeInZone(next.startsAt!, next.startsAtTz ?? "UTC")}
            {next.confirmationNumberMasked && (
              <>
                {" · conf "}
                <MaskedValue
                  masked={next.confirmationNumberMasked}
                  onReveal={() => onReveal(next.id)}
                />
              </>
            )}
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <PersonChips people={peopleOn(next)} />
        </div>
      </div>

      <hr className="hr" />

      {/* The rest of TODAY, not the rest of the trip: `rest` is what remains
          of `upcoming`, which was already scoped to today's ItineraryDay. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rest.slice(0, 3).map((b) => {
          const Icon = iconFor(b.kind);
          return (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="time-gutter">
                {formatTimeInZone(b.startsAt!, b.startsAtTz ?? "UTC")}
              </span>
              <Icon size={16} />
              <span style={{ fontSize: 13 }}>{b.title}</span>
              <span style={{ marginLeft: "auto" }}>
                <PersonChips people={peopleOn(b)} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write IdleTripHero**

Create `src/client/home/IdleTripHero.tsx`:

```tsx
import { Link } from "wouter";
import type { Trip } from "../api/types.js";
import { daysUntil } from "../lib/dates.js";

export function IdleTripHero({ trip, today }: { trip: Trip; today: string }) {
  const days = trip.startsOn ? daysUntil(trip.startsOn, today) : null;

  return (
    <div className="hero-idle" style={{ flex: "1.5 1 480px" }}>
      <h6 className="text-muted">
        {days === null ? "Next trip" : `Next trip · in ${days} days`}
      </h6>
      <div style={{ fontSize: 18, fontWeight: 500, marginTop: 8 }}>{trip.title}</div>
      {trip.destination && <p className="text-muted">{trip.destination}</p>}
      <Link href={`/trips/${trip.id}`} className="btn btn-primary">
        Trip details
      </Link>
    </div>
  );
}
```

- [ ] **Step 5: Write the error-presentation helper**

`Could not load your trips: {String(err)}` renders `ApiError: /api/trips failed: Internal error` — an internal class name and a path, in front of a family member, saying nothing they can act on. It also mis-frames the most common failure: a 401 here is an expired Cloudflare Access session, which is fixed by reloading, not by anything the message implies.

The backend's 403 and 500 bodies are **deliberately generic** (`"Forbidden"`, `"Internal error"` — see `routes/errors.ts`, which withholds detail on purpose so a scope bug cannot disclose table or query shape). So the client must map status to a sentence itself rather than expecting detail that will never arrive.

Create `src/client/lib/errors.ts`:

```ts
import { ApiError } from "../api/client.js";

/**
 * Status → a sentence a family member can act on. Never interpolates the
 * server's message: 403 and 500 bodies are intentionally contentless, and a
 * 400's message is written for an API caller, not for this screen.
 */
export function errorMessage(err: unknown): string {
  const status = err instanceof ApiError ? err.status : 0;
  switch (status) {
    case 401:
      return "Your session has expired. Reload the page to sign in again.";
    case 403:
      return "You do not have permission to see this.";
    case 404:
      return "This is no longer here — it may have been deleted.";
    case 400:
      return "The app sent something the server could not accept. This is a bug.";
    default:
      return "Something went wrong reaching Travel HQ. Try again in a moment.";
  }
}
```

Create `tests/client/lib/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ApiError } from "../../../src/client/api/client.js";
import { errorMessage } from "../../../src/client/lib/errors.js";

describe("errorMessage", () => {
  it("frames a 401 as an expired session", () => {
    expect(errorMessage(new ApiError("/api/trips failed: Unauthorized", 401))).toMatch(
      /session has expired/i,
    );
  });

  it("never leaks the underlying message or class name", () => {
    const message = errorMessage(new ApiError("/api/trips failed: Internal error", 500));
    expect(message).not.toMatch(/ApiError|\/api\/trips|Internal error/);
  });

  it("falls back to a generic sentence for a non-ApiError", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/Try again/i);
  });
});
```

Run: `npm run test:client -- lib/errors`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write Home**

Replace `src/client/pages/Home.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api as defaultApi } from "../api/client.js";
import { useIdentity } from "../api/identity.js";
import type { Booking, ItineraryDay, Person, Trip } from "../api/types.js";
import { countdownLabel, isActiveOn } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { ActiveTripHero } from "../home/ActiveTripHero.js";
import { IdleTripHero } from "../home/IdleTripHero.js";

type Api = typeof defaultApi;

function greeting(now: Date, name: string | null): string {
  const h = now.getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

/**
 * `Identity` carries an email, not a display name — there is no name column on
 * `user`. The local part is the closest honest thing to hand, and matching the
 * email against `person.display_name` would be a guess (people rows are family
 * members, not accounts). Before /api/me resolves this is null and the
 * greeting simply omits the name rather than flashing a placeholder.
 */
function displayNameFor(email: string | undefined): string | null {
  if (!email) return null;
  const local = email.split("@")[0] ?? "";
  if (!local) return null;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

export function Home({
  api = defaultApi,
  today = todayIso(),
  now = new Date(),
}: {
  api?: Api;
  today?: string;
  /** Separate from `today`: the hero compares instants, the grid compares dates. */
  now?: Date;
}) {
  const identity = useIdentity();
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [days, setDays] = useState<ItineraryDay[]>([]);
  const [error, setError] = useState<string | null>(null);

  const active = trips?.find((t) => isActiveOn(t, today)) ?? null;
  const upcoming =
    trips?.filter((t) => t.startsOn && t.startsOn > today).sort((a, b) =>
      a.startsOn!.localeCompare(b.startsOn!),
    ) ?? [];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, p] = await Promise.all([api.trips.list(), api.people.list()]);
        if (cancelled) return;
        setTrips(t);
        setPeople(p);
        const current = t.find((trip) => isActiveOn(trip, today));
        if (current) {
          // Two calls, two purposes: the itinerary is day-grouped in each
          // booking's own timezone and drives the hero; the flat list drives
          // the active card's "n booked · m to go" count, which is a whole-trip
          // number and must not be scoped to today.
          const [b, d] = await Promise.all([
            api.trips.bookings(current.id),
            api.trips.itinerary(current.id),
          ]);
          if (!cancelled) {
            setBookings(b);
            setDays(d);
          }
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, today]);

  const name = displayNameFor(identity?.email);

  if (error) return <p className="warning">{error}</p>;
  if (trips === null) return <p className="text-muted">Loading…</p>;

  if (trips.length === 0) {
    return (
      <>
        <h3>{greeting(now, name)}</h3>
        <p className="text-muted">
          No trips yet. Add the family under People, then create your first trip.
        </p>
      </>
    );
  }

  const heroTrip = active ?? upcoming[0] ?? trips[0]!;
  const todayDay = days.find((d) => d.date === today);

  return (
    <>
      <header
        style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 24 }}
      >
        <div>
          <h3 style={{ marginBottom: 4 }}>{greeting(now, name)}</h3>
          <p className="text-muted" style={{ margin: 0 }}>
            {active
              ? `${active.title} · travel day`
              : `Next up: ${heroTrip.title}`}
          </p>
        </div>
        <span className="tag tag-accent" style={{ marginLeft: "auto" }}>
          {heroTrip.title} · {countdownLabel(heroTrip.startsOn, heroTrip.endsOn, today)}
        </span>
      </header>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {active ? (
          <ActiveTripHero
            trip={active}
            day={todayDay}
            people={people}
            now={now}
            onReveal={async (bookingId) =>
              (await api.trips.revealConfirmation(active.id, bookingId)).value
            }
          />
        ) : (
          <IdleTripHero trip={heroTrip} today={today} />
        )}
      </div>
    </>
  );
}
```

`onReveal` calls the reveal endpoint the backend already provides. The confirmation arrives already masked from the API, and the plaintext is fetched only on click — which the server logs, and which `MaskedValue` suppresses entirely for a `viewer`.

- [ ] **Step 7: Run the tests**

Run: `npm run test:client -- pages/Home`
Expected: PASS, 7 tests.

- [ ] **Step 8: Commit**

```bash
git add src/client/pages/Home.tsx src/client/home src/client/lib/errors.ts tests/client/pages tests/client/lib
git commit -m "feat: add Home greeting and active/idle trip heroes"
```

---

### Task 6: Home — trips grid

**Files:**
- Create: `src/client/home/TripCard.tsx`
- Modify: `src/client/pages/Home.tsx`
- Test: `tests/client/home/TripCard.test.tsx`

**Interfaces:**
- Consumes: `countdownLabel` (Task 4), `PersonChips` (Task 4), `Trip`/`Booking` types
- Produces: `TripCard({ trip, bookings, people, today })`

- [ ] **Step 1: Write the failing test**

Create `tests/client/home/TripCard.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TripCard } from "../../../src/client/home/TripCard.js";

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
};

const PEOPLE = [
  { id: "p-badger", displayName: "Badger" },
  { id: "p-ava", displayName: "Ava" },
];

function booking(id: string, status: "planned" | "booked") {
  return {
    id,
    tripId: "t1",
    kind: "flight",
    title: `Booking ${id}`,
    location: null,
    startsAt: "2026-10-09T15:00:00Z",
    startsAtTz: "America/Boise",
    endsAt: null,
    endsAtTz: null,
    confirmationNumberMasked: null,
    costCents: null,
    pointsUsed: null,
    pointsProgram: null,
    status,
    details: {},
    personIds: ["p-badger"],
  };
}

function renderCard(bookings: unknown[]) {
  const { hook } = memoryLocation({ path: "/" });
  return render(
    <Router hook={hook}>
      <TripCard
        trip={TRIP}
        bookings={bookings as never}
        people={PEOPLE}
        today="2026-07-20"
      />
    </Router>,
  );
}

describe("TripCard", () => {
  it("renders the title, destination, and countdown", () => {
    renderCard([]);
    expect(screen.getByText("Mary & Winter Wedding")).toBeInTheDocument();
    expect(screen.getByText("Guerneville, CA")).toBeInTheDocument();
    expect(screen.getByText("In 81 days")).toBeInTheDocument();
  });

  it("counts booked versus remaining", () => {
    renderCard([booking("b1", "booked"), booking("b2", "planned")]);
    expect(screen.getByText(/1 booked · 1 to go/)).toBeInTheDocument();
  });

  it("renders no photo header", () => {
    const { container } = renderCard([]);
    expect(container.querySelector("img")).toBeNull();
  });

  it("links to the trip detail route", () => {
    renderCard([]);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/trips/t1");
  });
});
```

The third test is a guard: the design shows a photo header, and phase 1 deliberately omits it rather than shipping a dead upload slot.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- TripCard`
Expected: FAIL — cannot resolve `src/client/home/TripCard.js`.

- [ ] **Step 3: Write TripCard**

Create `src/client/home/TripCard.tsx`:

```tsx
import { Link } from "wouter";
import { MapPin } from "@phosphor-icons/react";
import type { Booking, Person, Trip } from "../api/types.js";
import { countdownLabel } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";

export function TripCard({
  trip,
  bookings,
  people,
  today,
}: {
  trip: Trip;
  bookings: Booking[];
  people: Pick<Person, "id" | "displayName">[];
  today: string;
}) {
  const booked = bookings.filter((b) => b.status === "booked").length;
  const remaining = bookings.length - booked;
  const countdown = countdownLabel(trip.startsOn, trip.endsOn, today);
  const travelerIds = new Set(bookings.flatMap((b) => b.personIds));
  const travelers = people.filter((p) => travelerIds.has(p.id));

  return (
    <Link
      href={`/trips/${trip.id}`}
      className="card elev-sm"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="card-title">{trip.title}</span>
        <span
          className={countdown === "Today" ? "tag tag-accent" : "tag tag-neutral"}
          style={{ marginLeft: "auto" }}
        >
          {countdown}
        </span>
      </div>

      {trip.startsOn && (
        <div className="card-meta">
          {trip.startsOn}
          {trip.endsOn && trip.endsOn !== trip.startsOn ? ` – ${trip.endsOn}` : ""}
        </div>
      )}

      <div className="card-meta">
        {trip.destination && (
          <>
            <MapPin size={12} />
            <span>{trip.destination}</span>
          </>
        )}
        <PersonChips people={travelers} />
        <span style={{ marginLeft: "auto" }}>
          {booked} booked{remaining > 0 ? ` · ${remaining} to go` : ""}
        </span>
      </div>
    </Link>
  );
}
```

- [ ] **Step 4: Render the grid in Home**

In `src/client/pages/Home.tsx`, add the import:

```tsx
import { TripCard } from "../home/TripCard.js";
```

`TripRepo.list()` orders `starts_on` **ascending**, so the raw array puts last year's trips first and buries the one happening next week below them — every card above the fold tagged "Past". The design leads with what is coming. Order it in the client, immediately above the `return`:

```tsx
  // Active first, then soonest upcoming, then undated, then past
  // most-recent-first. Server order is starts_on ASC, which is exactly
  // backwards for this screen; sorting here rather than adding a query
  // parameter keeps the endpoint's contract (and plan 3's use of it) alone.
  const rank = (t: Trip) =>
    isActiveOn(t, today) ? 0 : !t.startsOn ? 2 : t.startsOn > today ? 1 : 3;

  const ordered = [...trips].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const as = a.startsOn ?? "";
    const bs = b.startsOn ?? "";
    // Past trips read most-recent-first; everything else soonest-first.
    return rank(a) === 3 ? bs.localeCompare(as) : as.localeCompare(bs);
  });
```

Then append below the hero row's closing `</div>`, inside the returned fragment:

```tsx
      <hr className="hr" />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: 14,
        }}
      >
        {ordered.map((t) => (
          <TripCard
            key={t.id}
            trip={t}
            bookings={t.id === active?.id ? bookings : []}
            people={people}
            today={today}
          />
        ))}
      </div>
```

Only the active trip's bookings are loaded on Home, so other cards show `0 booked`. Loading every trip's bookings would be N+1 requests for a summary line; a per-trip counts endpoint belongs in plan 3.

- [ ] **Step 5: Run the whole client suite**

Run: `npm run test:client`
Expected: PASS, 44 total — 5 Shell, 7 api, 12 dates, 3 errors, 6 MaskedValue, 7 Home, 4 TripCard.

Also run the server suite, which Task 0 extended: `npm test` → `routes/api.test.ts` at 23 cases.

- [ ] **Step 6: Verify the build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 7: Verify at phone width against real data**

Task 0 is what makes this step possible. Start both halves — `TRAVEL_HQ_ENV=development TRAVEL_HQ_DEV_EMAIL=you@example.com npm run dev:server` and `npm run dev` — open the app at 390px wide, and confirm: the nav wraps without horizontal scroll, the active nav item is visibly accented (not merely `aria-current`), the hero row stacks, and the trips grid becomes one column. Fix with the existing fluid rules if not — do not add breakpoints.

If the household has no trips yet, create one through the API so this is not a test of the empty state:

```bash
curl -s -X POST http://127.0.0.1:8787/api/trips \
  -H 'content-type: application/json' \
  -d '{"title":"Guerneville","destination":"Guerneville, CA","startsOn":"2026-10-09","endsOn":"2026-10-11"}'
```

- [ ] **Step 8: Commit**

```bash
git add src/client/home/TripCard.tsx src/client/pages/Home.tsx tests/client/home
git commit -m "feat: add trips grid to Home"
```

---

## Not in this plan

Deferred to plan 3, in suggested order:

1. **Trip detail** (exploration 1b) — bookings grouped by kind, travelers rail, checklist rail, and the **cost rollup** (in phase 1 scope per the spec; `cost_cents` and `points_used` already exist).
2. **DayView** — both 1c and 1d behind one component boundary, since the family has not chosen. Includes the person filter and the phone layout (1e).
3. **Per-trip booking counts** — so trip cards other than the active one show real numbers without N+1 requests.
4. **Next best actions card** — the ranked checklist panel on Home. It needs `checklist_item` repositories and routes, which the backend plan deliberately left out.
5. **Offline caching** of the active trip.

Deferred to plan 4:

6. **Import screen** (`/import`) — paste/forward/upload tabs, the draft review card, and the manual-entry path. The backend already accepts `status: 'draft'`, so no schema work is needed. **Plan 4, not plan 3** — an earlier draft of this section said plan 3 while plan 3's own list said plan 4, and between them the nav's most prominent button pointed at nothing on either side. Task 2 Step 7 ships a placeholder `/import` page so the route resolves honestly in the meantime.

## Self-review notes

- **Reachability first.** Task 0 exists because `createApp` was only ever called from tests: no listener, no `/api` dev proxy, and no first household. Every screen in this plan and plan 3 rendered `Unauthorized` until it landed.
- **Design coverage:** Home/Today is covered except the "Next best actions" card (needs checklist repos, deferred above) and the trip-card day-by-day teaser (needs per-trip bookings, deferred above). The Import screen is plan 4.
- **Deliberate omission:** trip cover photos. The design shows a 150px photo header; phase 1 renders without it per the spec, and `TripCard.test.tsx` guards against one being added back.
- **No inert paths.** Confirmation reveal is wired to the real endpoint. Every nav control resolves to a route — `/import` to an honest placeholder rather than to "Not found".
- **Role-aware, without trusting the client.** `MaskedValue` hides the reveal affordance from a `viewer` and handles a rejected reveal anyway; the server's 403 remains the enforcement.
- **Errors say nothing the backend did not intend to say.** `errorMessage()` maps status to a sentence and never interpolates a body, because 403/500 bodies are deliberately generic.
- **Type consistency:** `Trip`, `Booking`, `Person`, `ItineraryDay`, and `Identity` all come from `src/client/api/types.ts`, which re-exports the server definitions, so client and server cannot drift.
