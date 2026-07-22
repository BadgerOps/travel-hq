# Cloudflare Plan B — serve the client from the Worker

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** One Worker serves both `/api/*` and the built React SPA (Workers static assets), behind one origin and one Access application.

**Architecture:** The Vite build (`dist/`) is served by Cloudflare Workers static assets bound in `wrangler.toml`. The Worker handles `/api/*` via Hono; everything else is served from the static assets, with an SPA fallback (unknown paths → `index.html`) so `wouter` client-side routes resolve.

**Tech Stack:** Cloudflare Workers static assets, wrangler, Vite, Hono.

## Global Constraints (from the spec)

- One Worker, one origin, one Access application. No Pages project, no second deploy.
- The HTTP `/api` contract is unchanged. Static assets must not shadow `/api/*`.
- `wrangler dev` serves the SPA and `/api` together.
- Verify config against **current** Cloudflare Workers static-assets docs — the assets/SPA/worker-routing model has specific knobs (`not_found_handling`, `run_worker_first`/routing); do not transcribe from memory.

---

### Task 1: Configure Workers static assets with SPA fallback and /api routing

**Files:**
- Modify: `wrangler.toml` (the commented `[assets]` placeholder), `src/server/worker.ts` if needed, `package.json` (build ordering for deploy).

- [ ] **Step 1: Verify the current Workers static-assets contract**

Check the installed `wrangler` (^4.x) docs/behaviour for serving an SPA alongside a Worker API. Confirm the exact `wrangler.toml` keys: the `[assets]` block (`directory = "dist"`, a `binding` if the Worker needs to reference assets, `not_found_handling = "single-page-application"`), and how a request is routed between static assets and the Worker `fetch` (assets-first vs `run_worker_first`). Write down what the installed version actually does — the executor runs this, so it must be real.

- [ ] **Step 2: Configure `[assets]` in wrangler.toml**

Uncomment and set the `[assets]` block to serve `dist/` with SPA `not_found_handling`, in the top-level config and both `[env.testing]` / `[env.production]`. Ensure `/api/*` still reaches the Worker (the Worker's Hono app owns `/api`; static assets serve everything else; unknown non-asset paths fall back to `index.html`). If the installed model serves assets before the Worker, confirm `/api/*` is not shadowed by a static file (it won't be — there is no `dist/api`); if it needs `run_worker_first` for `/api`, set it.

- [ ] **Step 3: Build ordering**

Ensure `dist/` exists before `wrangler deploy`/`wrangler dev` needs it. Add/confirm a `predeploy` or explicit `npm run build` step so the deploy scripts (`deploy:testing`/`deploy:production`) build the client first. Do not break the existing `build` script.

- [ ] **Step 4: Verify end to end with `wrangler dev`**

Build the client, run `wrangler dev` (with a local D1 + a dev key + the dev-email bypass so auth resolves — reuse the `.dev.vars` approach from Plan A Task 8's verification), and confirm by hand:
- `GET /` serves the SPA (`index.html`), and a deep client route like `/trips` also serves `index.html` (SPA fallback), not a 404.
- `GET /api/me` returns the dev identity JSON (the Worker, not a static file).
- `GET /healthz` still returns `ok`.
- A static asset (a hashed JS/CSS bundle under `/assets/…`) is served.
Record the actual output. Kill `wrangler dev` when done.

- [ ] **Step 5: Guard it with a test where practical**

Add a server-suite test (workers pool) asserting the Worker still returns `/api/me`/`/healthz` correctly with the assets binding present (a regression guard that assets config didn't break API routing). Full SPA-serving is verified manually in Step 4 (the workers pool doesn't build/serve `dist`). Keep the four gates green: `npm run typecheck`, `npm test`, `npm run test:client`, `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml src/server/worker.ts package.json tests/server
git commit -m "feat(cf): serve the React SPA from the Worker via static assets"
```

---

## Non-goals

- No Pages project; no second deployment.
- No change to the `/api` contract or the client app itself.
- Deploying to real Cloudflare environments is Plan C (needs the account/token/D1 setup).
