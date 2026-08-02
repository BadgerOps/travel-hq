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
   every `wrangler.toml` environment and billed per use.

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

## 2a. VAPID keypair (Web Push identity)

Push notifications need a P-256 keypair that identifies **this server** to the
push services (RFC 8292). It authorizes nothing on a user's behalf — it only
proves that whoever is POSTing to a subscription endpoint is the same server
the browser subscribed to.

**The public half is a var** (`wrangler.toml`, committed — the browser receives
it anyway as `applicationServerKey`). **The private half is a secret.** Both are
base64url, and the encodings are not interchangeable with every tool's output:
public is the 65-byte *uncompressed* point (`0x04 || X || Y`), private is the
raw 32-byte scalar — the JWK `d` value, not PKCS#8 and not a PEM. This matches
what `web-push generate-vapid-keys` prints, so a pair generated elsewhere pastes
in cleanly.

Generate one with Node ≥ 18 and no dependencies:

```bash
node -e 'const {webcrypto:w}=require("crypto");(async()=>{ \
  const kp=await w.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]); \
  const jwk=await w.subtle.exportKey("jwk",kp.privateKey); \
  const pub=Buffer.from(await w.subtle.exportKey("raw",kp.publicKey)); \
  console.log("VAPID_PUBLIC_KEY =",pub.toString("base64url")); \
  console.log("VAPID_PRIVATE_KEY=",jwk.d);})()'
```

Then put the public half in **both** `[vars]` and `[env.production.vars]` in
`wrangler.toml` (an environment's `vars` replaces the top-level table wholesale
rather than merging into it), and the private half in the secret store:

```bash
printf '%s' '<the VAPID_PRIVATE_KEY value>' | wrangler secret put VAPID_PRIVATE_KEY --env production
```

`VAPID_SUBJECT` is already set to `mailto:trips@badgerops.foo` — a contact the
push service operator can reach if our traffic causes them a problem.

**The two halves must stay the same pair forever.** The browser pins the public
key at `pushManager.subscribe()` time; rotating it makes every stored
subscription fail with a 403 and they all have to be re-created. If a pair is
ever mismatched, VAPID JWTs still *sign* fine and are rejected only by the push
service, so validate a new pair by signing and verifying a probe before
installing it (`verifyVapidKeys()` in `src/server/push/vapid.ts` exists for
exactly this).

Until all three values are present the five-minute sweep does nothing and logs
`notification_sweep_unconfigured` once per tick. That is a supported state, not
a broken one: it deliberately takes no claims it cannot honour, because a claim
is permanent and claiming-then-failing would mean those reminders never re-arm.

For local development the same two values go in `.dev.vars` (gitignored).

## 2b. Cloudflare Access (human auth) — REQUIRED or `/api` 500s

The Worker validates a Cloudflare Access JWT on every `/api` request. Without
the two Access values set, `resolveVerifier` throws and the first `/api` request
returns 500 (fail-closed — never an auth bypass). Set them **per environment**:

1. Put the Worker behind a **Cloudflare Access application** (Zero Trust →
   Access → Applications → Add a self-hosted app) for each environment's
   hostname (the testing and production Workers). Add an Allow policy for your
   household's identities (e.g. the family's emails / your IdP).
2. From each Access application, note its **AUD tag** and your **team domain**.
   Two traps here:
   - **`CF_ACCESS_TEAM_DOMAIN` must include the `https://` scheme** — the
     full value is `https://<team>.cloudflareaccess.com`. The Worker uses it
     verbatim as both the JWKS fetch URL base and the JWT `issuer` claim, and
     Access mints tokens with the scheme included; without it every request
     fails with a 401.
   - The **AUD tag** is the 64-hex-character "Application Audience (AUD) Tag"
     under the app's **Additional settings → AUD tag** — NOT the application's
     UUID id that appears in the dashboard URL. A UUID there will never match
     the JWT's `aud` claim.

   Neither value is secret (the AUD is an identifier, not a credential), so
   they live as **committed `[vars]`** in the `[env.testing]`/`[env.production]`
   blocks of `wrangler.toml` — the production values are already there. Set the
   testing ones the same way once a testing Access app exists. Use each
   environment's own Access application and AUD.

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
   - **Account · Workers AI · Read** — required so deployment can validate and
     attach the `AI` binding. Inference runs through the deployed binding.
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

## 5. Email ingest (Email Routing → Worker)

The Worker's `email()` handler (`src/server/worker.ts`, logic in
`src/server/ingest.ts`) is **real ingest**: it resolves the target household
by matching the envelope recipient against
`household_settings.forward_address`, verifies the sender, and stores the raw
message plus parsed metadata as an `inbound_email` row — status `received` on
success, or `rejected`/`failed` with a human-readable reason.

Sender verification always requires the household allowlist. The primary
authentication path uses a Cloudflare-authored DMARC/SPF pass from
`Authentication-Results` or `ARC-Authentication-Results`. Email Routing does
not consistently expose those headers to Workers even when its Activity log
shows SPF, DKIM, and DMARC passed. When the trusted verdict is unavailable,
the Worker independently verifies DKIM against the selector's DNS key. That
fallback is deliberately narrower: the allowlist must contain the exact
envelope address, the message must have one matching outer `From`, and a
SHA-256 DKIM signature aligned to that address must cover `From` and the full
body. An explicit Cloudflare failure never falls back, and bare-domain
allowlist entries require a Cloudflare pass.

DKIM keys are resolved through Cloudflare's DNS-over-HTTPS endpoint. A DNS
failure, missing/invalid signature, unaligned signer, body-length-limited
signature, or message with excessive signatures fails closed. The handler is
still fail-soft end to end: it never bounces the sender; anything **not**
stored as `received` (unclaimed recipient, rejected sender, internal error) is
forwarded best-effort to `env.FALLBACK_FORWARD_TO` when that var/secret is set,
so mail is never silently lost.

Extraction runs inline after a verified message is stored. A
`text/calendar` attachment is parsed directly and never sent to a model.
Otherwise readable content is collected from plain text, HTML-only mail, and
attached `message/rfc822` forwarded messages before the household-configured
Workers AI model runs in JSON mode against the committed extraction schema.
The model id is changed in the app's **Settings → Extraction model** field;
Wrangler only supplies the `AI` binding. The complete result is validated
before its pending `draft_booking` rows are inserted as one batch; the email
then becomes `extracted`, or `failed` without partial drafts.

### Switching the routing rule to the Worker (owner action)

The interim dashboard rule forwards `trips@badgerops.foo` straight to a
mailbox. Once this ingest code is deployed, switch that rule to the Worker.
Before flipping it, prepare:

1. Migrations are applied to the target environment
   (`wrangler d1 migrations apply travel-hq-<env> --remote`) —
   `0004_inbound_email.sql` must be live, or every message lands in the
   fail-soft path.
2. In the app's **Settings** page, set the household's **forward address** to
   `trips@badgerops.foo` and add the expected senders to the **sender
   allowlist**. Use the exact address for people or forwarding mailboxes (for
   example, `person@example.com`) so independent DKIM verification can recover
   when Cloudflare omits its verdict. Bare domains (for example,
   `airline.com`) are convenient for vendor infrastructure but require a
   trusted Cloudflare verdict. An unclaimed recipient is never stored, and an
   empty allowlist rejects every sender.
3. Optionally set `FALLBACK_FORWARD_TO` on the Worker (var or secret) to an
   Email Routing **verified destination address** — `message.forward()` only
   works to verified destinations.

Then flip the rule:

Cloudflare dashboard → the `badgerops.foo` zone → Email → Email Routing →
Routing rules → edit the `trips@badgerops.foo` custom address → change the
action from **Send to an email** to **Send to a Worker** → pick the production
`travel-hq` Worker → save.

To roll back at any time, switch the action back to **Send to an email**
pointing at the mailbox; the Worker keeps working for anything already stored.

### Production authentication smoke test

After each change to Email Routing or sender verification:

1. Send one direct vendor confirmation from a configured domain and confirm
   its `inbound_email` activity reaches `received` or `extracted`.
2. Forward one confirmation from an exact-address allowlist entry and confirm
   it reaches `received` or `extracted`, even if Cloudflare does not expose a
   trusted result header to the Worker.
3. From infrastructure not authorized by the allowlisted domain, attempt a
   controlled message with both envelope and outer `From` set to the exact
   allowlisted address. Confirm Cloudflare rejects it before the Worker or the
   Worker records it as `rejected`; it must never become `received`.
4. In **Compute → Email Service → Email Routing → Activity**, record the
   message ID and redacted SPF, DKIM, DMARC, ARC, and lifecycle results for all
   three checks. In Travel HQ Settings, record the corresponding metadata-only
   ingest activity. Never paste raw personal mail into an issue.

The independent fallback needs outbound HTTPS access to
`cloudflare-dns.com`. A resolver outage intentionally rejects and uses
`FALLBACK_FORWARD_TO`; retry the message after DNS recovers.

## 6. First run

- `wrangler dev` runs the Worker locally against a local D1 for development.
- Apply migrations to an environment with
  `wrangler d1 migrations apply travel-hq-<env> --remote`.
- Bootstrapping the first household/user (so Access can resolve a membership) is
  handled by a seed path described in the platform plan — the D1 equivalent of
  the old `npm run seed`.

## What must never be committed

The repo is public. Keep out of git: the Cloudflare API token, the encryption
keys, any real family email addresses (the sender allowlist lives in D1
settings, not code). Only the public app hostname and
non-secret config belong in `wrangler.toml`.
