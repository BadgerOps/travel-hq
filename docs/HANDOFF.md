# Travel HQ — Handoff (HISTORICAL — 2026-07-22)

> **This document is a historical snapshot, not current instructions.** It
> describes the retired Node 22 + `node:sqlite` loopback architecture from
> before the Cloudflare replatform. Do not follow its setup, run, or deployment
> steps.
>
> **For the current system, read `README.md` and
> `cloudflare-github-setup.md`.** Travel HQ is now a single Cloudflare Worker
> (`src/server/worker.ts`) on D1, with Workers AI or the Anthropic API doing
> extraction, R2 for trip photos, and Cloudflare Access for authentication.
>
> Specifically superseded below:
>
> - **`src/server/serve.ts`, `scripts/seed.ts`, `npm run seed`, and
>   `npm run dev:server` do not exist.** There is no separate API process; the
>   Worker serves the API and the SPA. Local setup is `wrangler dev` against a
>   local D1 — see README, "Run locally".
> - **`workers/inbound-email/` and `tests/workers/` do not exist.** Ingest is
>   the Worker's own `email()` handler (`src/server/ingest.ts`), reached
>   directly from Cloudflare Email Routing — there is no second Worker and no
>   service-token-authenticated `/api/inbound-email` endpoint.
> - **The "hybrid local-first" extraction decision below (`.ics` → local Ollama
>   model → manual Claude escalation) was never carried into the Cloudflare
>   architecture, and its privacy claim is false today.** A `.ics` part is
>   still parsed in-process with no model, but everything else is extracted by
>   Workers AI (default) or the Anthropic API if the household configures it.
>   Both are third-party model services; email content leaves the Worker. There
>   is no local model.
> - **The keyring no longer auto-generates `.dev-secrets/keyring.key`.** The key
>   is the `ENCRYPTION_KEY` secret (`.dev.vars` locally), formatted
>   `<key_id> <base64-of-32-bytes>`.
> - Test counts, `docs/superpowers/plans/` completion state, and the "Task 15"
>   section are all frozen at 2026-07-22.

**Updated:** 2026-07-22
**State:** Plans 1-4 implemented and merged to `main`. The application runs and
is usable end to end. **Task 15's code (the Cloudflare Worker) is now written and
tested; what remains is the Cloudflare dashboard + deploy steps, which need
account credentials — see `workers/inbound-email/README.md`.** The zone is
decided: `travelhq.badgerops.foo`, forward address `trips@badgerops.foo`, Access
team `badgerops.cloudflareaccess.com`.

## Where things stand

All four implementation plans in `docs/superpowers/plans/` are complete except
plan 4's final task:

1. **Backend foundation** (`2026-07-20-backend-foundation.md`) - merged. Node 22
   + Hono + SQLite (`node:sqlite`), six tenant-scoped repositories, AES-256-GCM
   envelope encryption, Cloudflare Access JWT auth boundary.
2. **Frontend shell and Home** (`2026-07-20-frontend-shell-and-home.md`) -
   merged. Gained a **Task 0** (added during review) that makes the app actually
   run: `src/server/serve.ts` (binds 127.0.0.1), `scripts/seed.ts`, a Vite `/api`
   proxy, and `GET /api/me`. Nocturne tokens, routed shell, typed API client.
3. **Trip detail and day view** (`2026-07-21-trip-detail-and-day-view.md`) -
   merged. Checklist repo, cost rollup, trip detail with hash-synced tabs, and
   the day view (shape 1c).
4. **Data entry and import** (`2026-07-21-data-entry-and-import.md` +
   `...-part-b.md`) - merged **except Task 15**. Person/trip/booking entry, the
   People card grid, the add-booking dialog, a cross-trip checklist page, and
   local-first inbound-email import (service-token auth, MIME/iCal parsing,
   `.ics`->local-model->manual-Claude extraction, the draft-approval queue).

**571 tests** (338 server via `npm test`, 233 client via `npm run test:client`),
typecheck clean, build green.

## Running it

```bash
nix develop                       # node 22 pinned
npm install
SEED_EMAIL=you@example.com npm run seed
TRAVEL_HQ_ENV=development TRAVEL_HQ_DEV_EMAIL=you@example.com npm run dev:server &
npm run dev                       # http://localhost:5173, /api proxied to :8787
```

- `TRAVEL_HQ_ENV=development` opts INTO development explicitly. **Unset means
  production** - this is deliberate; a `NODE_ENV`-based check fails open under
  systemd, since systemd does not set `NODE_ENV`.
- `TRAVEL_HQ_DEV_EMAIL` is a dev-only auth bypass (no tunnel on a laptop). It
  skips the JWT check but NEVER the membership check, and the server refuses to
  boot if it is set outside development.
- The keyring auto-generates a dev key at `.dev-secrets/keyring.key` (gitignored)
  in development; in production a missing key file is a hard error rather than a
  silent fresh key that would orphan every encrypted value.

## Task 15 — code done, deployment steps remain

`docs/superpowers/plans/2026-07-21-data-entry-and-import-part-b.md`, Task 15,
builds the **Cloudflare Email Routing -> Worker -> `/api/inbound-email`** path.
The Worker, its config, and a regression test for the sender dual-check now live
in `workers/inbound-email/` (8 tests in `tests/workers/inbound-email.test.ts`).

What remains needs Cloudflare account access and cannot be automated from here —
the full checklist is in `workers/inbound-email/README.md`: create the Access
**service token** and a **separate** Access application scoped to
`/api/inbound-email` (distinct from the human app so one policy change can't
grant the Worker the whole API, and with **no Bypass policy** — a Bypass strips
the JWT and 401s every ingest request confusingly), set the agenix/systemd env
on guiltyspark, `wrangler secret put` the client id/secret, `wrangler deploy`,
and add the Email Routing rule for `trips@badgerops.foo`.

Until those are done the app runs fine: the forward-address UI shows
"not configured yet", and the ingest endpoint fails closed with an empty
allowlist.

## Decisions made during implementation (all approved or owner-directed)

| Question | Decision |
|---|---|
| Auth household resolution | **Verify membership in a requested household** (`X-Travel-HQ-Household` header), never discover one. Fail safe, never implicit. Owner-directed. |
| Email extraction | **Hybrid local-first**: `.ics` -> local model (Ollama, OpenAI-compatible, 7-14B at q4) -> Claude only as a manual per-message escalation. Keeps PII-dense emails off third-party infra by default. Owner-directed. |
| People page | **Card grid** matching the trip-card language. Owner-directed (was an open question). |
| Checklist page | Cross-trip `/checklist` page with an add-item form. Owner-requested addition (no plan brief). |
| `machine` role | A service token gets role `machine`, denied every write/reveal except the one inbound-email create. Read containment is by ROUTING (list/get are not role-gated). |

## Security properties worth preserving (verified in review)

- **The masked-value trap cannot destroy a passport.** Three guards: tri-state
  update (absent/null/string), server-side rejection of any document value
  containing the mask glyph U+2022 (`assertNotMasked` in `crypto/envelope.ts`,
  applied to person documents AND booking confirmation numbers), and forms that
  never bind a masked value into an input. Tests assert the stored plaintext is
  *unchanged* after a rejected update, not merely that a 400 came back.
- **`TenantRepo` binds the household id as a NAMED parameter** and rejects
  queries shaped so the tenancy predicate could be neutralized. An earlier
  version counted `?` characters to place the bind and was exploitable; see
  `tests/server/repos/base-adversarial.test.ts` (16 attacks).
- **`tests/server/architecture.test.ts`** pins that raw SQL statement calls
  (including `RegExp.prototype` regex execution, which shares the banned method
  name) appear only under `repos/`, `db/`, and `auth.ts`. It is deliberately
  blunt - do not narrow it; use `str.match(re)` in parsers.
- **The ingest path fails soft.** A downed local model, a timeout, non-JSON, or
  a Zod-rejected response all still queue a draft. An email is never lost.

## Deferred (see `docs/BACKLOG.md`)

Trip editing (no `PUT /api/trips/:id`), booking delete/cancel UI, per-trip
booking counts, trip cover photos (attachments), loyalty accounts, offline
caching of the active trip, day-view shape 1d, and the paste/upload import
methods (only forward is built - paste/upload need a second human-authenticated
parse endpoint). The booking-timezone skip asymmetry (an unparseable stored zone
is skipped by the itinerary query but counted by the rollup) is documented in
BACKLOG; it is unreachable through the API today because writes validate the
zone, but any future write path that bypasses validation would make it live.

## Notes for whoever picks this up

- **The SQLite-statement-runner security-hook false positive** (from the
  original handoff) is real and recurred throughout: a global hook
  pattern-matches the method name expecting `child_process`. It fires on the
  legitimate SQLite handle method of the same name. Approve the write; it is a
  false positive. It also fires on `RegExp.prototype` regex execution.
- **Reports and scratch** from the subagent-driven build live under
  `.superpowers/` (gitignored).
