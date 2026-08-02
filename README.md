# Travel HQ

A trips-first travel dashboard for a family, running entirely on Cloudflare.
Enter your family once, build trips with flights, lodging, cars, and activities
— each with confirmation numbers and correct timezones — and see a per-day,
per-person itinerary. Booking confirmation emails can be forwarded in and turned
into draft bookings for review.

Passport, known-traveler, and redress numbers are encrypted at rest and shown
masked; revealing one is logged. Cloudflare Access authenticates at the edge and
the Worker validates the forwarded JWT — there are no local passwords.

## Architecture

The whole application is **one Cloudflare Worker**. `src/server/worker.ts` is the
entry point: its `fetch` handler is the Hono app (`src/server/index.ts`, mounted
under `/api`) and its `email` handler is inbound-mail ingest
(`src/server/ingest.ts`). The built React SPA is served by that same Worker as
static assets from `dist/` (`[assets]` in `wrangler.toml`), with `/api/*` and
`/healthz` pinned to the Worker code via `run_worker_first`. There is no second
process and no origin server.

- **Runtime:** Cloudflare Workers (`workerd`), TypeScript, Hono, no ORM.
  Tenant-scoped repositories under `src/server/repos/` own every raw SQL
  statement — `tests/server/architecture.test.ts` enforces that.
- **Frontend:** React 19 + `wouter`, routed pages on the Nocturne design tokens
  (`src/client/styles.css`), built by Vite into `dist/`.
- **Encryption:** AES-256-GCM envelope encryption (`src/server/crypto/envelope.ts`)
  under the `ENCRYPTION_KEY` secret, covering person document numbers, booking
  confirmation numbers, and a stored Anthropic API key.

### What lives in Cloudflare

Every binding below is declared in `wrangler.toml`; check there for the exact
per-environment wiring.

| Service | Binding | What it holds or does |
|---|---|---|
| **D1** | `DB` | All application data: households, users and memberships, people, trips and trip members, bookings, checklists, cards and perks, household settings, draft bookings, and the **raw forwarded email** (`inbound_email`). Schema in `migrations/`. |
| **Workers AI** | `AI` | Runs booking extraction in JSON mode (`src/server/ingest/providers.ts`); the selectable model list is pulled from `env.AI.models()` (`src/server/ingest/model-catalog.ts`). |
| **R2** | `TRIP_PHOTOS` | Trip cover photo uploads (`GET`/`POST /api/trips/:tripId/photo`). Declared in the `testing` and `production` environments only. |
| **Cloudflare Access** | — | Human authentication. The Worker verifies the `Cf-Access-Jwt-Assertion` JWT against the team JWKS (`src/server/auth.ts`) using the `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` vars, then resolves a household membership from D1. |
| **Email Routing** | — | Delivers mail sent to a household's forward address into the Worker's `email()` handler. |

Local development runs the same Worker under `wrangler dev` against a **local**
D1 (Miniflare state under `.wrangler/`), with a dev-only auth bypass instead of
Access. Two differences worth knowing: Workers AI has no local emulation, so
`wrangler dev` proxies the `AI` binding to Cloudflare; and the default (local)
configuration declares no R2 bucket, so trip photo upload only works on a
deployed environment.

### Email import — where the mail actually goes

This path is privacy-relevant, so it is stated plainly:

1. Email Routing hands the message to the Worker. The sender must be on the
   household's allowlist **and** authenticated (a Cloudflare DMARC/SPF verdict,
   or a deliberately narrow independent DKIM check). Anything else is stored as
   a metadata-only `rejected` row and forwarded to the fallback address.
2. The **raw message is stored in D1** as an `inbound_email` row (truncated at
   ~1 MB) before anything is parsed. That row is the durable record the review
   queue reads.
3. If the mail carries a `text/calendar` part, it is parsed inside the Worker
   (`src/server/ingest/ics.ts`) and **no model is involved**.
4. Otherwise the readable text goes to the household's configured extraction
   provider (`src/server/ingest/providers.ts`): **Workers AI** by default, or
   the **Anthropic API** when configured. Provider, model, token budget, and
   extra extraction instructions are set per household under **Settings**, and
   an Anthropic key is stored encrypted in D1. Both options are third-party
   model services — email content leaves the Worker when either one runs. This
   codebase has no local/on-premises model path.
5. Validated results become `draft_booking` rows for human review at `/import`.
   Nothing is written straight into a trip.

The complete ingest contract — the DKIM fallback rules, the fail-soft
guarantees, and the Email Routing setup — is in
[`docs/cloudflare-github-setup.md`](docs/cloudflare-github-setup.md) § 5.

## Run locally

```bash
nix develop                 # node 22 + wrangler pinned (optional; any Node 22+ works)
npm install
npm run build               # build the SPA into dist/ (the Worker serves it)
```

Local dev needs a `.dev.vars` file (gitignored) with the encryption key and the
development auth bypass — there is no Cloudflare Access in front of a laptop, so
the bypass skips the JWT while still requiring a real household membership.
`ENCRYPTION_KEY` must be `<key_id> <base64-of-32-bytes>`; a bare base64 string
with no key id fails to load:

```bash
cat > .dev.vars <<EOF
ENCRYPTION_KEY="server-v1 $(openssl rand -base64 32)"
TRAVEL_HQ_ENV=development
TRAVEL_HQ_DEV_EMAIL=you@example.com
EOF
```

Apply migrations to the local D1 and seed the first household so auth resolves —
the seeded email must match `TRAVEL_HQ_DEV_EMAIL`, or `/api` returns 401. You
need one row each in `household`, `user`, and `household_member` (see the schema
in `migrations/0001_initial.sql`):

```bash
npx wrangler d1 migrations apply travel-hq-dev --local
npx wrangler d1 execute travel-hq-dev --local --command \
  "INSERT INTO household (id,name,created_at) VALUES ('h1','Home',datetime());
   INSERT INTO user (id,email,created_at) VALUES ('u1','you@example.com',datetime());
   INSERT INTO household_member (household_id,user_id,role) VALUES ('h1','u1','owner');"

npm run dev                 # wrangler dev — http://localhost:8787 (API + SPA)
```

- **Rebuilds can look like no-ops:** the production build registers a service
  worker (`public/sw.js`), so after `npm run build` the browser keeps the old
  bundle until you unregister the SW / clear Cache Storage (or hard-reload with
  devtools open).
- **`TRAVEL_HQ_ENV=development` is required** for the dev bypass. Unset means
  production, and the Worker refuses to serve `/api` at all when
  `TRAVEL_HQ_DEV_EMAIL` is set outside development — deliberate, so a deployed
  Worker can never run the bypass.
- **Hand-seeded booking rows** must use UTC instants (a `Z` suffix) in
  `starts_at`/`ends_at` and leave `confirmation_number` NULL: the column holds
  an encrypted envelope, and a row whose confirmation cannot be decrypted is
  skipped, which looks like missing data in the UI.
- **Deploying to Cloudflare** — the two environments, D1 databases, secrets,
  Cloudflare Access, Email Routing, and the GitHub Actions CI/CD — is covered in
  [`docs/cloudflare-github-setup.md`](docs/cloudflare-github-setup.md).

`nix develop` is optional — any Node 22+ toolchain works — but it pins the same
Node the Worker runtime targets and supplies `wrangler`.

## Test and typecheck

```bash
npm test                # server suite: @cloudflare/vitest-pool-workers (real
                        # workerd + local D1, migrations applied), tests/server/**
npx vitest run -c vitest.arch.config.ts
                        # architecture test: raw SQL confined to src/server/repos/
                        # and src/server/auth.ts
npm run test:client     # client suite (Vitest, jsdom), tests/client/**
npm run test:all        # all three, in that order
npm run typecheck       # client (tsc -b) + tsconfig.server.json + tsconfig.test.json
```

The architecture test reads source files from disk and needs a plain Node
environment, so it is excluded from `vitest.config.ts` and run through
`vitest.arch.config.ts`. `npm test` loads `wrangler.test.toml` — a test-only
Worker config containing only the locally emulated D1 — so the suite never opens
an authenticated Workers AI proxy or calls a billable model.
`.github/workflows/ci.yml` runs the same four suites individually (not through
`test:all`), plus `npm run build`.

## Build and deploy

```bash
npm run build              # tsc -b && vite build -> dist/
npm run deploy:testing     # builds, then wrangler deploy --env testing
npm run deploy:production  # builds, then wrangler deploy --env production
```

`dist/` is the static frontend, served by the Worker alongside the API from a
single deployment. Two environments are declared in `wrangler.toml`: `testing`
(PR previews) and `production` (deployed from `master`), each with its own D1
database, R2 bucket, and secrets. `.github/workflows/deploy.yml` applies
migrations with `wrangler d1 migrations apply --remote` before each deploy.

After changing dependencies, refresh the vendored-dependency hash:

```bash
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```

and paste the result into `npmDepsHash` in `flake.nix`.

## Layout

```
src/server/     worker.ts (fetch + email entry), index.ts (Hono app), routes/,
                repos/ (tenancy and all raw SQL), ingest.ts + ingest/, crypto/,
                auth.ts, schemas/
src/client/     React SPA: pages/, components/, trip/, dayview/, home/, cards/,
                imports/, api/, lib/
src/shared/     types shared by client and server (the Workers AI model list)
migrations/     D1 migrations, applied by wrangler
tests/server/   Workers-pool suite plus architecture.test.ts
tests/client/   jsdom suite
tests/fixtures/ shared fixtures
public/         assets copied into dist/ (manifest, icons, sw.js)
docs/           design system, specs and plans, the Cloudflare/GitHub runbook
```

## Status

The Worker deploys to `production` from `master` via GitHub Actions, backed by
the `travel-hq-production` D1 database and R2 bucket and fronted by a Cloudflare
Access application. Email ingest is implemented end to end in the Worker;
switching the Email Routing rule to it is an owner action, described in
[`docs/cloudflare-github-setup.md`](docs/cloudflare-github-setup.md) § 5.

Two known gaps, both noted in `wrangler.toml`: the `testing` environment has no
Cloudflare Access application yet, so its `/api` fails closed; and the local-dev
configuration has no R2 binding, so trip photos work only on a deployed
environment. Further deferred work is in `docs/BACKLOG.md`, and what has
actually shipped is in `CHANGELOG.md`.

`docs/HANDOFF.md` is a **historical** snapshot of the pre-Cloudflare build and
describes an architecture this repository no longer has; read it for that
history only, not as instructions.
