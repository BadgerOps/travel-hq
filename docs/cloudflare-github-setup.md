# Cloudflare + GitHub setup

How to configure the hosting and CI/CD for Travel HQ. The app runs entirely on
Cloudflare: one Worker serves the API and the static client, backed by D1, with
the encryption key in a Workers secret. Deploys are driven by GitHub Actions.

The repository lives at **https://github.com/BadgerOps/travel-hq** (public).

> Some files referenced here (`wrangler.toml`, `.github/workflows/*`) are added
> by the implementation plans. This doc is the configuration runbook — the
> account-level and secret setup that only the owner can do, and that must not
> live in a public repo.

## Two environments

| | Worker | D1 database | Purpose |
|---|---|---|---|
| **testing** | `travel-hq-testing` | `travel-hq-testing` | PR previews; the owner's manual testing |
| **production** | `travel-hq-production` | `travel-hq-production` | live, deployed from `master` |

Each environment has its **own D1 database and its own Workers secrets**, so a
PR preview never touches production data. Both are declared as `[env.testing]`
and `[env.production]` blocks in `wrangler.toml`.

## 1. Cloudflare account

1. Note your **Account ID** (Cloudflare dashboard → Workers & Pages → right
   sidebar, or `wrangler whoami`).
2. Create the two D1 databases and record each `database_id`:
   ```bash
   wrangler d1 create travel-hq-testing
   wrangler d1 create travel-hq-production
   ```
   Put the returned `database_id`s into the matching `[env.*]` blocks of
   `wrangler.toml`.
3. The **Workers AI** binding (`AI`) needs no resource creation — it is bound in
   `wrangler.toml` and billed per use. (Only relevant once ingest/extraction is
   built; deferred for now.)

## 2. Encryption key (Workers secret, per environment)

The key is a 32-byte AES-256 value. The secret's **value must be
`<key_id> <base64-of-32-bytes>`** (a key id, a space, then the base64) — this is
what `loadKeyring` parses, and it's what lets keys rotate later. A bare base64
string (no key id) will fail to load. Set it once per environment:

```bash
# value is "<key_id> <base64>", e.g.:
printf 'server-v1 %s' "$(openssl rand -base64 32)" | wrangler secret put ENCRYPTION_KEY --env testing
printf 'server-v1 %s' "$(openssl rand -base64 32)" | wrangler secret put ENCRYPTION_KEY --env production
```

Use a **different** key per environment. Losing the production key makes every
stored document number permanently undecryptable — back it up where you keep
other production secrets. (To rotate later, prepend a new `server-v2 <base64>`
line and make it the last line — the active key is the last one listed.)

## 2b. Cloudflare Access (human auth) — REQUIRED or `/api` 500s

The Worker validates a Cloudflare Access JWT on every `/api` request. Without
the two Access values set, `resolveVerifier` throws and the first `/api` request
returns 500 (fail-closed — never an auth bypass). Set them **per environment**:

1. Put the Worker behind a **Cloudflare Access application** (Zero Trust →
   Access → Applications → Add a self-hosted app) for each environment's
   hostname (the testing and production Workers). Add an Allow policy for your
   household's identities (e.g. the family's emails / your IdP).
2. From each Access application, note its **AUD tag** and your **team domain**
   (`<team>.cloudflareaccess.com`). Set them on the matching Worker environment
   — these are not secret, so `[vars]` in the env block works, or `wrangler
   secret put`:
   ```bash
   # e.g. as vars in the [env.testing]/[env.production] blocks of wrangler.toml,
   # or:
   wrangler secret put CF_ACCESS_TEAM_DOMAIN --env testing      # <team>.cloudflareaccess.com
   wrangler secret put CF_ACCESS_AUD --env testing              # the testing Access app's AUD
   wrangler secret put CF_ACCESS_TEAM_DOMAIN --env production
   wrangler secret put CF_ACCESS_AUD --env production            # the production Access app's AUD
   ```
   Use each environment's own Access application and AUD.

> **Do not add a Bypass policy** to the Access application — a Bypass mints no
> JWT, so the Worker fails closed with a confusing 401/500 that looks like a
> token problem. See the design spec.

## 3. GitHub Actions token

CI deploys with a Cloudflare API token stored as a **GitHub Actions secret**,
never in the repo.

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → **Create
   Custom Token** (not the "Edit Cloudflare Workers" template — it bundles KV /
   Routes / Tail and a Zone requirement you don't need, and it omits D1). Give
   it exactly these **Account**-scoped permissions:
   - **Account · Workers Scripts · Edit** — deploy the Worker.
   - **Account · D1 · Edit** — `wrangler d1 migrations apply` and D1 queries.
   - **Account · Account Settings · Read** — optional, lets wrangler resolve
     account details without broader read.
   - *(Do NOT add **Workers AI** yet — extraction is deferred. Add
     **Account · Workers AI · Read** only when ingest is built.)*
   - **Account Resources:** Include → **your specific account**, not "All
     accounts." No Zone or Email permission is needed (Email Routing is
     dashboard-configured). Optionally set a TTL; leave Client IP filtering
     blank (Actions runners have dynamic IPs).
2. GitHub → the `travel-hq` repo → Settings → Secrets and variables → Actions →
   New repository secret:
   - `CLOUDFLARE_API_TOKEN` = the token above
   - `CLOUDFLARE_ACCOUNT_ID` = your account ID (so wrangler doesn't enumerate
     accounts, which would need broader read)

Treat the token like a deploy key: it can edit Workers and D1 in your account
and nothing else.

## 4. How CI/CD behaves

Defined in `.github/workflows/` (added by the CI/CD plan):

- **Every PR** runs the full suite — server tests on `vitest-pool-workers`
  (local D1), client tests on jsdom, typecheck, and the client build. This is
  the gate; nothing deploys if it is red.
- **A PR from a branch in this repo** whose tests passed deploys to the
  **testing** Worker, so you can try it live.
- **A PR from a fork** runs tests only. The deploy job is skipped and the
  Cloudflare token is never exposed to fork code — deliberate, because this is a
  public repo. Deploy a fork's preview by hand after reviewing it.
- **Merge to `master`** re-runs the full suite, then deploys to **production**.
  A red suite blocks the production deploy.

## 5. Email forwarding (interim)

The Worker exports an `email()` handler (`src/server/worker.ts`), but it is a
**dormant stub**: no parsing, no Workers AI, no D1 writes. It only forwards to
`env.FALLBACK_FORWARD_TO` if that var/secret happens to be set on the Worker,
else it no-ops. It is **not wired to Email Routing** — nothing today points
mail at this Worker, so the stub only matters once you deliberately switch the
routing rule below to "Send to a Worker."

Until then, configure Cloudflare **Email Routing** to forward
`trips@badgerops.foo` directly to a real mailbox so you can see confirmation
emails and decide how to build ingest for real:

Cloudflare dashboard → the `badgerops.foo` zone → Email → Email Routing →
Routing rules → add a custom address `trips@badgerops.foo` → action **Send to**
your mailbox. (Requires Email Routing to be enabled on the zone and the
destination address verified.)

When ingest is built later, this rule changes to **Send to a Worker** targeting
the app Worker's `email()` handler, and the handler itself is replaced with
real parsing/extraction/D1 writes (see the design spec's "Ingest and
extraction — DEFERRED" section) — the stub is only a placeholder shape until
then.

## 6. First run

- `wrangler dev` runs the Worker locally against a local D1 for development.
- Apply migrations to an environment with
  `wrangler d1 migrations apply travel-hq-<env> --remote`.
- Bootstrapping the first household/user (so Access can resolve a membership) is
  handled by a seed path described in the platform plan — the D1 equivalent of
  the old `npm run seed`.

## What must never be committed

The repo is public. Keep out of git: the Cloudflare API token, the encryption
keys, any real family email addresses (the sender allowlist, when ingest is
built, lives in D1 settings, not code). Only the public app hostname and
non-secret config belong in `wrangler.toml`.
