# Issue 20 tester handoff

## Tests added or updated

- `tests/server/email.test.ts`
  - generates a real RSA keypair and independently signs RFC 5322 messages;
  - accepts aligned RSA/SHA-256 DKIM for an exact allowlisted sender when the
    Cloudflare verdict is unavailable;
  - rejects a mismatched outer/envelope sender, tampered body, unaligned signer,
    multiple outer `From` fields, a DKIM `l=` partial-body signature, excess
    signatures, domain-only fallback, and an explicit Cloudflare failure;
  - accepts a later valid aligned signature after an earlier malformed transit
    signature;
  - verifies `pass`, `fail`, and `unavailable` Cloudflare classification;
  - confirms rejected raw bodies remain unpersisted and the explicit-failure
    path does not read raw input or resolve DNS.
- `tests/client/pages/Settings.test.tsx`
  - verifies the exact-address/DKIM and domain/Cloudflare help text.

## Commands run

All commands ran inside `nix develop`.

- `npx vitest run tests/server/email.test.ts`
  - initial pass: 1 file, 35 tests;
  - post-review regression pass: 1 file, 36 tests.
- `npx vitest run -c vitest.client.config.ts tests/client/pages/Settings.test.tsx`
  - pass: 1 file, 14 tests.
- `npm run test:all`
  - initial pass: server 30 files / 375 tests;
  - final post-review pass: server 30 files / 376 tests;
  - pass: architecture 1 file / 1 test;
  - pass: client 35 files / 263 tests;
  - final total: 66 files / 640 tests.
- `npm run typecheck`
  - pass after replacing a runtime-only Web Crypto type name with an equivalent
    structural cast supported by the project's generated types;
  - pass again after the post-review multi-signature fix.
- `npm run build`
  - pass: TypeScript project build and Vite production build.
- `npx wrangler deploy --env production --dry-run --outdir
  /tmp/travel-hq-issue20-final-dry-run`
  - pass: production Worker bundle generated, 1307.82 KiB / 232.52 KiB gzip.
- `npm audit --audit-level=high`
  - pass: zero vulnerabilities.
- `git diff --check`
  - pass.

The initial `mailauth` prototype was also dry-bundled successfully but was
removed because the Workers test runtime could not load its Node/CommonJS
graph, it inflated the bundle to 2924.66 KiB, and it introduced vulnerable
transitives before overrides. The final implementation has no added runtime
dependency and the normal Worker-pool suite passes.

## Changelog verification

- `CHANGELOG.md` has a concrete `0.3.1 - 2026-07-23` section.
- `package.json` and the root `package-lock.json` package entry are `0.3.1`.
- No `Unreleased` section was introduced.

## Coverage gaps

- The user-provided Cloudflare Activity record is a live reproduction of the
  missing-header bug, but this branch cannot exercise the production Email
  Routing rule before deployment.
- After merge/deploy, perform the documented three-part production smoke:
  direct vendor mail, the legitimate Fastmail forward, and a controlled spoof
  from unauthorized infrastructure. Record redacted Activity and Travel HQ
  ingest results.
- DNS-over-HTTPS behavior is covered through injected TXT responses and the
  production bundle; a live public-DNS integration test is intentionally
  omitted from deterministic CI.
