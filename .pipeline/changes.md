# Issue 20 coder handoff

## Files changed

- `src/server/ingest.ts`
  - added three-state Cloudflare authentication classification;
  - added the exact-address missing-verdict path;
  - added a test resolver seam.
- `src/server/ingest/dkim.ts`
  - added bounded RFC 6376 parsing and simple/relaxed canonicalization;
  - added RSA/SHA-256 body hash and signature verification with Web Crypto;
  - added strict sender/domain alignment and DNS-key policy checks;
  - isolated per-signature failures so a malformed transit signature cannot
    suppress a later valid aligned signature;
  - added a Cloudflare DNS-over-HTTPS TXT resolver.
- `src/server/worker.ts`
  - updated the email handler contract comment.
- `src/client/pages/Settings.tsx`
  - explained exact-address versus domain allowlist authentication behavior.
- `docs/cloudflare-github-setup.md`
  - documented the authentication paths, fail-closed cases, resolver
    dependency, and production direct/forwarded/spoof smoke test.
- `docs/reviews/2026-07-22-adversarial-review.md`
  - recorded the production reproduction and implemented remediation.
- `package.json`, `package-lock.json`
  - bumped the app to `0.3.1`; no runtime dependency was added.
- `CHANGELOG.md`
  - added the concrete `0.3.1` bug-fix entry.

## Behavior implemented

- A trusted Cloudflare DMARC/SPF pass remains the normal acceptance path.
- An explicit trusted failure always rejects without reading the raw stream.
- A missing verdict can proceed only for an exact-address allowlist entry.
- That narrow path reads the bounded raw message and accepts only one matching
  outer/envelope sender with a current, aligned, SHA-256 DKIM signature that
  signs `From` and the complete body.
- Bare-domain entries, unaligned/weak/partial-body signatures, too many
  signatures, and DNS/verifier failures remain fail-closed and use the existing
  metadata-only rejection and fallback forwarding behavior.
- Independent DNS uses only a fixed Cloudflare DoH endpoint with validated TXT
  query names and a five-second timeout.

## Deviations from spec

The original plan selected `mailauth`, but its mixed CommonJS/ESM Node package
graph could not load in the Workers test runtime and produced a roughly 3 MB
Worker bundle containing unrelated mail/SPF/BIMI functionality. It also
initially introduced high-severity transitive advisories. It was removed,
along with all related overrides, and replaced by the narrow Worker-native
RSA/SHA-256 implementation described above. `npm audit --audit-level=high`
reports zero vulnerabilities.

## Suggested verification

- Add signed-message Worker-pool tests using a generated test key and injected
  DNS TXT resolver.
- Add classification and malicious-message edge-case tests.
- Update the Settings copy assertion.
- Run focused tests, typecheck, the full suite, production build, Wrangler
  production dry run, and `npm audit`.
- After merge/deploy, perform the documented direct/forwarded/spoof production
  smoke test. The user-provided Activity record is the live reproduction, not
  proof of the new code path.
