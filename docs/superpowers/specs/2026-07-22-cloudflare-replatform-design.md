# Cloudflare re-platform — D1, Workers, Workers AI

**Date:** 2026-07-22
**Status:** Approved design, ready for implementation plans.

## The pivot, and the custody decision it reverses

Travel HQ moves to run **100% on Cloudflare**: a Worker app on D1, no
self-hosted origin and no tunnel. This **reverses** the project's most
deliberated decision. The design record rejected full Cloudflare (D1 + Workers)
specifically because it moves passport numbers, DOBs, and KTNs onto third-party
infrastructure, and chose a self-hosted origin behind a Cloudflare Tunnel to get
the same reachability without that custody change.

The owner has reversed it knowingly. The accepted trade, recorded here so it is
not re-litigated by accident:

- The whole database, including the encrypted document numbers, lives on **D1**.
- The AES-256-GCM key moves from an agenix file on the host into a **Workers
  secret** — also Cloudflare. App-level encryption still protects against a
  D1-only exposure, but no longer against Cloudflare-the-platform.
- **Encryption is kept** (owner's choice): defense in depth against a D1-only
  exposure is worth the small cost.

## Verified Cloudflare facts that shape this design

Checked against current Cloudflare docs, not memory, because each changes the
plan:

1. **D1 prepared statements are positional-only** — ordered `?NNN` and anonymous
   `?`, **no named parameters** (`:name`). The current `TenantRepo` binds its
   tenancy predicate as a *named* parameter (`:__scope_household`) — a fix an
   adversarial review forced, after the original `?`-counting approach proved
   exploitable. **That fix does not port.** The tenancy binding is re-solved on
   D1's explicit indexed parameters (below), and gets the same adversarial
   review. This is the single largest risk in the port.
2. **D1 supports `ON DELETE CASCADE`** and foreign keys (with
   `PRAGMA defer_foreign_keys = on` inside migration transactions). The
   tenancy cascade deletes and the trip-delete feature port unchanged. D1
   enforces foreign keys by default, so the `PRAGMA foreign_keys = ON` from the
   old connection module is dropped.
3. **Workers AI has JSON Mode** — `response_format: { type: "json_schema",
   json_schema: {...} }` on models such as `@cf/meta/llama-3.1-8b-instruct` and
   `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. It is the *same* schema shape the
   current extractor already builds, so `EXTRACTED_JSON_SCHEMA`, its
   strict-legality work, and the Zod validation carry straight over.

## Target architecture — one Worker

A single Cloudflare Worker (Hono) that:

- serves the **API** (`/api/*`) and the **static React client** (Workers static
  assets) from one deployment;
- reads and writes **D1** (`env.DB`);
- encrypts document numbers with **WebCrypto** AES-256-GCM, key from a **Workers
  secret**;
- authenticates humans with **Cloudflare Access** (the `jose` JWT logic is
  unchanged);
- extracts bookings with **Workers AI** (`env.AI`);
- ingests email through **Email Routing → the same Worker's `email()` handler**.

`wrangler dev` replaces `dev:all`; `wrangler deploy` replaces the NixOS module,
systemd, tsx, `serve.ts`, and `cloudflared`. All of those are deleted.

## The anchor: preserve the HTTP contract and the frontend

The derisking strategy. The **HTTP API contract** — routes, request/response
shapes, the error taxonomy, the masked-value discipline — and the **entire React
client** stay identical. The Zod schemas, the Access JWT logic, the SQL text
(mostly), and the extraction JSON-schema approach all port. So the frontend and
the *behavioural* expectations of the tests carry over even as the server
substrate is rewritten underneath. A route that returned 404 for a foreign id
still does; a viewer still gets 403; a masked value is still never returned as
plaintext.

## Component changes

### Tenancy binding on D1 (security-critical — adversarial review required)

The `{scope}` token mechanism stays, re-implemented for D1's explicit indexed
parameters. `{scope}` expands to `household_id = ?1`; the base **reserves index
`?1`** for the household id and binds it as the first value, and repository
queries write their own parameters starting at **`?2`**. Binding is
`stmt.bind(ctx.householdId, ...callerParams)`.

Why this is safe where the old `?`-counting was not: nothing counts anonymous
`?` to decide a splice position. The household id owns a fixed, explicit index
the caller never writes, so a `?` inside a comment or string literal cannot shift
it. The existing shape guards port unchanged — a query without exactly one
`{scope}` token throws; a query with `OR` adjacent to the token, or `UNION` /
`EXCEPT` / `INTERSECT` after it, or the token hidden in a comment or string
literal, is rejected. Two additions the review must pin: a caller must not write
`?1` itself (reserved), and the base rejects any query where `?1` appears outside
the `{scope}` expansion.

`base-adversarial.test.ts`'s sixteen attacks are re-run against the D1
implementation; the module is not considered done until an independent
adversarial pass (a fresh agent trying to make it leak across households) clears
it, exactly as the original earned.

Considered and rejected: a query builder (Kysely-d1, Drizzle). It would remove
hand-binding, but the project's principle is hand-written SQL with the tenancy
guarantee in one small auditable place; a builder moves that guarantee into a
dependency.

### Database — D1 + wrangler migrations

- The schema is unchanged (it is already SQLite). It becomes
  `migrations/0001_initial.sql` etc. under `wrangler d1 migrations`.
- `defer_foreign_keys = on` wraps any migration that needs it; `ON DELETE
  CASCADE` is retained.
- The `node:sqlite` connection module and the file-reading migration runner are
  deleted; D1 is reached through the `env.DB` binding.

### Repositories — synchronous to async

Every repository method becomes `async` and `await`s D1
(`await stmt.bind(...).all()` / `.first()` / `.run()`). This ripples through the
`TenantRepo` base, all six repositories, and every route that calls them. The
SQL and the tenancy/masking logic are otherwise preserved. This is the deepest
mechanical change and the reason the port is a coordinated effort, not a lift.

### Crypto — WebCrypto envelope

The AES-256-GCM envelope is rewritten against `crypto.subtle` (Workers have no
`node:crypto`). The self-describing envelope format is redefined for WebCrypto —
`v1.<key_id>.<iv_b64url>.<ct+tag_b64url>` (WebCrypto returns the GCM tag appended
to the ciphertext) — which is a clean break, acceptable because the database is
fresh. The key is a 32-byte value from a Workers secret, imported with
`crypto.subtle.importKey`. `mask()` and `assertNotMasked` are unchanged. The
key-id-in-envelope property (incremental key rotation) is kept.

### Auth — Access on Workers, and the machine path dissolves

- Human auth is unchanged in logic: `jose` verifies the Access JWT; `jwtVerify`,
  the JWKS fetch, the household-membership resolution all port.
- **The service-token machinery is not ported.** It authenticated a
  cross-origin POST from the old separate ingest Worker; native ingest will run
  *in-process* in the same Worker, so there is nothing to authenticate. Gone:
  `createServiceTokenVerifier`, the `POST /api/inbound-email` endpoint, the
  `CF-Access-Client-*` headers, the separate Access application, the
  AUD/allowlist env vars, `resolveIngestVerifier`.
- **The `machine` role and `requireIngestWrite` are deferred with the ingest
  subsystem.** The initial port carries only the three human roles
  (`owner`/`adult`/`viewer`); the machine path — a role whose default is deny,
  with a single per-`insert()` guard override used only by
  `InboundEmailRepo.create` — is re-introduced when ingest is built, so the
  initial `TenantRepo` port carries no unused security surface.

### Entry — Worker `fetch` and `email`

`src/worker/index.ts` exports `{ fetch, email }`. `fetch` is the Hono app
(`app.fetch`) with the D1/AI/secret bindings injected per request via `env`;
`email` is the ingest handler. `wrangler.toml` declares the bindings: `DB` (D1),
`AI` (Workers AI), the static-assets binding, and the secrets.

### Static hosting

The Vite build (`dist/`) is served by the same Worker via Workers static assets,
so the SPA and its `/api` live behind one origin and one Access application. No
Pages project, no second deployment.

### Ingest and extraction — DEFERRED; `email()` stubbed for now

The full ingest pipeline is **deferred**. Its eventual shape is recorded below
as the target, but the initial rollout does **not** build it. Instead:

- The Worker exports an `email()` handler that is a **stub** — correct signature,
  bound in `wrangler.toml`, but it does not parse, extract, or write to D1. It
  simply forwards the message to the fallback mailbox (or is left unbound and
  Email Routing forwards directly).
- **Cloudflare Email Routing forwards `trips@badgerops.foo` to the owner's real
  mailbox**, configured in the dashboard, so the owner can see real confirmation
  emails and decide how to build ingest for real. Nothing is parsed or stored
  until then.
- Because ingest is deferred, so are the **Workers AI extractor**, the
  auto-populated **review queue**, and the **Settings / agent-configuration**
  area that existed to serve it — there is no live extraction agent to configure
  yet. A future plan builds them together once the owner has tested forwarding.
- The whole ingest subsystem — the `inbound_email` table and repo, the
  `/api/inbound-email` routes, and the `/import` review UI — is therefore **not
  ported initially**. The "preserve the HTTP contract" anchor covers the
  non-ingest routes (people, trips, bookings, checklist, itinerary, me, rollup,
  travelers); the `/import` nav entry is a stub until the subsystem lands.

**Target (future, not this rollout):** Email Routing → the Worker's `email()`
handler resolves the target household by matching the recipient (`To:`) against
`household_settings.forward_address`; verifies the sender (allowlist **and**
DMARC/SPF); parses `.ics`-first then **Workers AI**
(`env.AI.run(model, { messages, response_format: { type: "json_schema",
json_schema: EXTRACTED_JSON_SCHEMA } })`, model from settings, defaulting to
`@cf/meta/llama-3.1-8b-instruct`); and writes a draft through
`InboundEmailRepo.create` with the machine context, fail-soft on any error.
`ClaudeExtractor`, `LocalLlmExtractor`, and the Anthropic dependency are deleted;
extraction, when built, is `.ics` + Workers AI only. Tests inject a fake `AI`
binding and never call the real model.

### Settings — the agent-configuration area (DEFERRED with ingest)

Built together with the ingest pipeline, not in the initial rollout — there is
no live extraction agent to configure until then. The eventual shape:
a household-scoped `household_settings` table in D1 (one row per household):
the Workers AI **model**, the **forward address**, and the **sender allowlist**.
Read at request/ingest time. Routes to read and update it (owner/adult only), and
a **Settings** page in the client to configure them — this is the
"configure an agent" feature. The forward address and allowlist move out of env
vars into this table; the Import page reads the address from settings, and the
`email()` handler reads the allowlist from settings.

### Tests

`@cloudflare/vitest-pool-workers` runs the server suite against workerd with a
**local D1**; the client suite stays on jsdom. Repository tests run real SQL
against local D1 rather than in-memory `node:sqlite`. The `AI` binding is faked
in tests. The adversarial tenancy suite and the architecture test (raw-SQL
confinement) are re-run against the Worker layout.

## Source of truth and CI/CD

The repository moves to a **public GitHub repo**. Two Cloudflare environments,
each with its **own D1 database and Workers secrets**, declared as `wrangler.toml`
environments:

- **testing** — a staging Worker (its own D1). PR preview target.
- **production** — the live Worker (its own D1), deployed from `master`.

GitHub Actions:

- **On every PR** — run the full suite (unit + integration + regression: the
  server suite on `vitest-pool-workers`/local D1, the client suite on jsdom,
  typecheck, build). This is the gate.
- **On a PR from a branch in this repo** (not a fork) whose tests passed —
  deploy to the **testing** Worker (`wrangler deploy --env testing`), so the
  owner can try the change on a live Worker.
- **On a PR from a fork** — run tests only. The deploy job is skipped and the
  Cloudflare token is **never exposed to fork code**. This is deliberate: a
  public repo must not hand deploy secrets to an arbitrary contributor's PR. A
  fork preview can be deployed by hand after review.
- **On merge to `master`** — re-run the full suite, then deploy to
  **production** (`wrangler deploy --env production`). Tests gate the production
  deploy; a red suite blocks it.

Secrets: the `CLOUDFLARE_API_TOKEN` (scoped to Workers + D1 edit) lives as a
**GitHub Actions secret**, and the app's runtime secrets (the encryption key)
are set per environment with `wrangler secret put --env <env>`. Nothing secret
is committed — the repo is public.

Owner-provided setup (documented, not automatable from here): create the GitHub
repo, add the `CLOUDFLARE_API_TOKEN` GitHub secret, and configure Cloudflare
Email Routing to forward `trips@badgerops.foo` to a real mailbox.

## Migration and rollout

Fresh D1 — the app was never deployed, so there is no data to migrate. The port
is a coordinated effort on a branch that preserves the HTTP contract, verified
against the ported test suite before any deploy. Secrets are set with
`wrangler secret put`; each environment's D1 database and the Workers AI binding
are created and bound in `wrangler.toml`.

## Decomposition into plans

One architecture spec (this), then sequenced implementation plans:

- **Plan A — platform foundation.** wrangler project + `wrangler.toml` bindings
  and the testing/production environments; D1 databases + migrations; the
  WebCrypto envelope; the **re-solved async `TenantRepo`** and its adversarial
  review; the async repositories; the Worker `fetch` entry with a minimal health
  route; the `jose` auth on Workers; the `vitest-pool-workers` + local-D1
  harness. The largest and riskiest plan.
- **Plan B — routes + static hosting.** Port every route to the async repos;
  serve the client via Workers static assets; `wrangler dev`.
- **Plan C — GitHub, CI/CD, and email forwarding.** The public GitHub repo; the
  GitHub Actions workflows (PR test gate → testing-Worker deploy for same-repo
  PRs, fork PRs test-only; merge-to-`master` test gate → production deploy);
  the two Cloudflare environments and their D1s/secrets; the **stubbed
  `email()`** handler; and Cloudflare Email Routing forwarding
  `trips@badgerops.foo` to a mailbox.

**Deferred to a later plan** (after the owner has tested forwarding and decided):
native email ingest, the Workers AI extractor and review-queue feed, and the
Settings / agent-configuration area — they form one subsystem and are built
together.

The **trip-management** feature (`2026-07-22-trip-management-design.md`) is built
on the new async stack, sequenced after Plan B.

## Non-goals

- No data migration (nothing deployed).
- No ORM or query builder — hand-written SQL, tenancy guarantee in one place.
- No Claude / external LLM — extraction is `.ics` + Workers AI only.
- No change to the HTTP API contract or the React client's behaviour.
- Paste/upload import methods stay deferred (as before).

## Risks

- **The tenancy re-binding** is security-critical and does not port verbatim;
  it is the gating item of Plan A and must clear an independent adversarial pass.
- **The async ripple** touches every repository and route — mechanical but broad;
  the preserved HTTP contract keeps it verifiable.
- **Workers AI extraction quality** on messy confirmations is unproven versus the
  previous local-model plan; the review queue is the backstop, and the model is
  configurable in settings.
