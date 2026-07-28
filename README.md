# Travel HQ

A trips-first travel dashboard for a family, self-hosted and reached from
anywhere through a Cloudflare Tunnel. Enter your family once, build trips with
flights, lodging, and cars — each with confirmation numbers and correct
timezones — and see a per-day, per-person itinerary. Booking confirmation emails
can be forwarded in and parsed into draft bookings for review.

Passport, known-traveler, and redress numbers are encrypted at rest and shown
masked; revealing one is logged. Cloudflare Access authenticates at the edge and
the app validates the forwarded JWT — there are no local passwords.

- **Backend:** Node 22 + Hono + SQLite (`node:sqlite`), TypeScript, no ORM.
  Tenant-scoped repositories, AES-256-GCM envelope encryption.
- **Frontend:** React 19 + `wouter`, routed pages on the Nocturne design tokens.
- **Email import:** a Cloudflare Worker forwards raw mail to the app, which
  parses it `.ics`-first, then with a **local** model (Ollama, OpenAI-compatible)
  and only escalates to Claude on explicit request — confirmation emails stay on
  your own hardware by default.

## Run locally

The whole app — the `/api` and the React SPA — runs in **one Cloudflare Worker**
via `wrangler dev`, against a local D1.

```bash
nix develop                 # node 22 pinned (optional; any Node 22+ works)
npm install
npm run build               # build the SPA into dist/ (the Worker serves it)
```

Local dev needs a `.dev.vars` file (gitignored) with the encryption key and the
development auth bypass — there is no Cloudflare Access in front of a laptop, so
the bypass skips the JWT while still requiring a real household membership:

```bash
cat > .dev.vars <<'EOF'
ENCRYPTION_KEY=REPLACE_WITH_BASE64_32_BYTES   # e.g. openssl rand -base64 32
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

- **Rebuilds can look like no-ops:** the served build registers a service
  worker, so after `npm run build` the browser keeps the old bundle until you
  unregister the SW / clear Cache Storage (or hard-reload with devtools open).
- **`TRAVEL_HQ_ENV=development` is required** for the dev bypass. Unset means
  production, and the Worker refuses to start with `TRAVEL_HQ_DEV_EMAIL` set —
  deliberate, so a deployed Worker can never run the bypass.
- **Deploying to Cloudflare** — the two environments, D1 databases, secrets,
  Cloudflare Access, and the GitHub Actions CI/CD — is covered in
  [`docs/cloudflare-github-setup.md`](docs/cloudflare-github-setup.md).

`nix develop` is optional — any Node 22+ toolchain works — but it pins the same
Node the Worker runtime targets.

## Test and typecheck

```bash
npm test              # server suite (Vitest, node:sqlite)
npm run test:client   # client suite (Vitest, jsdom)
npm run typecheck     # client + server + tests
```

## Build

```bash
npm run build         # typechecks and builds the client into dist/
```

`dist/` is the static frontend only. The API server (`src/server/serve.ts`) is a
separate process — it binds loopback and is meant to sit behind the Cloudflare
Tunnel, never exposed directly. See the deployment notes in
`docs/HANDOFF.md`; the NixOS module + systemd + agenix wiring for guiltyspark is
tracked there and in `docs/BACKLOG.md`.

After changing dependencies, refresh the vendored-dependency hash:

```bash
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```

and paste the result into `npmDepsHash` in `flake.nix`.

## Layout

```
src/server/     Hono app, repositories, migrations, crypto, auth, ingest parsers
src/client/     React app: pages, components, API client, day view
workers/        the Cloudflare inbound-email Worker (see its README)
tests/          server (tests/server), client (tests/client), worker (tests/workers)
docs/           the design spec, the four implementation plans, HANDOFF, BACKLOG
```

## Status

All four implementation plans are done and merged. What remains is the
deployment of the inbound-email Cloudflare Worker, which needs Cloudflare
account setup — the code and the exact checklist are in
`workers/inbound-email/README.md`. Start with `docs/HANDOFF.md`.
