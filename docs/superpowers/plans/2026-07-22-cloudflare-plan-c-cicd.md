# Cloudflare Plan C — GitHub, CI/CD, and email forwarding

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** GitHub Actions that gate every PR on the full test suite, deploy same-repo PRs to a testing Worker, and deploy `master` to production after tests — plus a stubbed `email()` handler and the interim `trips@badgerops.foo` forwarding.

**Architecture:** Two workflows. A test workflow runs on every PR and on `master` (typecheck + server tests on workerd/local-D1 + client tests + build). A deploy workflow, gated so fork PRs never receive secrets, deploys the testing Worker on same-repo PRs and the production Worker on `master`, each after the test gate. Deploys use a least-privilege `CLOUDFLARE_API_TOKEN`.

**Tech Stack:** GitHub Actions, `wrangler`, Cloudflare Workers/D1, Node 22.

## Global Constraints (from the spec + setup doc)

- **Public repo — never expose deploy secrets to fork PRs.** The deploy job runs ONLY for same-repo PRs (`head.repo.full_name == github.repository`) and for `push` to `master`. Fork PRs run the test job only; no secrets.
- Tests gate BOTH deploys — a red suite blocks the deploy.
- CI runs on GitHub Ubuntu runners with `actions/setup-node@v4` (Node 22) + `npm ci` — NOT nix (nix only pins local dev). workerd (the test pool's runtime) runs on a standard Ubuntu runner.
- Secrets: `CLOUDFLARE_API_TOKEN` (Account Workers Scripts:Edit + D1:Edit) and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets; runtime `ENCRYPTION_KEY` set per env via `wrangler secret put` (owner, out of band — see `docs/cloudflare-github-setup.md`). Nothing secret in the repo.
- Validate workflow YAML with `actionlint` if available (or a YAML parse); the real end-to-end validation is the first PR — say so.

---

### Task 1: The test-gate workflow

**Files:** Create `.github/workflows/ci.yml`.

- [ ] **Step 1:** Write `ci.yml` triggering on `pull_request` and `push` to `master`. One job `test` on `ubuntu-latest`: checkout; `actions/setup-node@v4` node 22 + npm cache; `npm ci`; then `npm run typecheck`, `npm test`, `npm run test:client`, `npm run build`. This job needs NO secrets, so it runs for fork PRs too. Confirm the workers-pool tests run on the runner (workerd downloads and runs on Ubuntu; no special setup beyond npm ci).
- [ ] **Step 2:** Validate the YAML (`actionlint` if present, else a YAML parse). Note that live validation happens on the first PR.
- [ ] **Step 3:** Commit.

### Task 2: The deploy workflow (fork-safe)

**Files:** Create `.github/workflows/deploy.yml`.

- [ ] **Step 1:** Write `deploy.yml`. A `test` job (reuse the same gate — either `workflow_call` into ci.yml or duplicate the steps) runs first. A `deploy` job `needs: test`, gated:
  - **testing:** on `pull_request` AND `github.event.pull_request.head.repo.full_name == github.repository` (same-repo only — fork PRs are excluded, so the token is never exposed to fork code). Runs `npm ci`, `npm run build`, then `wrangler d1 migrations apply travel-hq-testing --env testing --remote`, then `wrangler deploy --env testing`.
  - **production:** on `push` to `master`. Same steps with `--env production` and `travel-hq-production`.
  Use `cloudflare/wrangler-action@v3` (or the `wrangler` CLI directly) with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from `secrets`. The deploy job — and only it — references secrets.
- [ ] **Step 2:** Ensure `dist/` is built before deploy (the build step precedes the wrangler steps). Ensure migrations are applied before the deploy so the Worker never runs against an unmigrated D1.
- [ ] **Step 3:** Add a concurrency guard (cancel in-progress deploys for the same ref) so overlapping pushes don't race.
- [ ] **Step 4:** Validate YAML; note first-PR live validation. Commit.

### Task 3: Stub `email()` + interim forwarding docs

**Files:** Modify `src/server/worker.ts`; update `docs/cloudflare-github-setup.md`.

- [ ] **Step 1:** Add a **stub** `email()` handler to the Worker's default export: correct signature `async email(message, env, ctx)`, no parsing and no D1 writes — it forwards the message to a fallback address if one is configured (`env.FALLBACK_FORWARD_TO`), else is a no-op. A short comment: real ingest (parse → Workers AI → D1 draft queue) is the deferred ingest plan; for now `trips@badgerops.foo` is forwarded to a mailbox at the Email Routing level (dashboard), not through this handler.
- [ ] **Step 2:** Add a test (workers pool) that the stub `email()` does not throw and does not write to D1 (a household/person count is unchanged after calling it). Keep the four gates green.
- [ ] **Step 3:** In `docs/cloudflare-github-setup.md`, confirm the "Email forwarding (interim)" section is accurate: Email Routing → forward `trips@badgerops.foo` to a real mailbox (dashboard), and note the Worker `email()` is a dormant stub until the ingest plan.
- [ ] **Step 4:** Commit.

---

## Non-goals

- Real email ingest / Workers AI extraction / the draft queue / agent-config (the deferred ingest plan).
- Creating the Cloudflare account resources (D1 databases, token, secrets) or the Email Routing rule — owner steps, documented in `docs/cloudflare-github-setup.md`.
- Pushing the repo — done after the whole re-platform is reviewed.
