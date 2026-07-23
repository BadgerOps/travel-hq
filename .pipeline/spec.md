# Issue 20 specification — authenticated fallback for Email Routing

## Goal

Accept legitimate forwarded mail when Cloudflare Email Routing delivers it to
the Worker without a usable Cloudflare-authored `Authentication-Results` or
`ARC-Authentication-Results` verdict, while preserving the rule that an
allowlisted sender claim is never trusted on its own.

The production observation for message
`<97031b5b-1418-4a04-a2ed-1773894d0b14@app.fastmail.com>` establishes the
failure mode: Cloudflare's Activity log reports SPF, DKIM, and DMARC `pass`,
but the Worker sees no trusted verdict and currently rejects the message.

## Non-goals

- Do not accept a missing verdict based only on the envelope sender,
  RFC 5322 `From`, or arbitrary authentication-result text.
- Do not implement SPF independently: the Email Worker API does not expose the
  SMTP peer IP needed for a trustworthy SPF evaluation.
- Do not change routing rules, deploy production, or weaken handling of an
  explicit Cloudflare failure.
- Do not broaden the fallback to bare-domain allowlist entries. They remain
  supported when Cloudflare supplies a trusted passing verdict.
- Do not refactor MIME extraction or the household settings schema.

## User-facing behavior

- Existing behavior is unchanged when a trusted Cloudflare verdict is present:
  allowlist plus passing DMARC (or SPF when DMARC is absent) accepts; any
  explicit failure rejects.
- When no trusted Cloudflare verdict is available, an allowlisted exact sender
  address can be accepted only if:
  - the raw message has exactly one outer RFC 5322 `From` address;
  - that address equals the SMTP envelope sender;
  - a current, SHA-256 DKIM signature covering `From` and the full body verifies
    against the selector's DNS key; and
  - the verified DKIM signing domain aligns with the outer `From`.
- Missing verdicts for domain-only allowlist entries, unsigned mail, invalid or
  unaligned signatures, body-length-limited signatures, DNS errors, and
  multiple/mismatched `From` addresses remain rejected and go through the
  existing fallback-forward path.
- Rejection text distinguishes an explicit authentication failure from an
  unavailable Cloudflare verdict whose independent DKIM fallback did not pass.
- Settings help and the operations guide explain that exact sender addresses
  enable the independent DKIM fallback; domain entries require Cloudflare's
  trusted verdict.

## Technical approach

1. Replace the boolean Cloudflare-header parser result with a three-state
   classification: `pass`, `fail`, or `unavailable`. A trusted record that
   reports a verdict but does not pass is `fail`; no trusted DMARC/SPF verdict
   is `unavailable`. Untrusted planted records never become trusted.
2. Preserve verification before raw-stream reads for non-allowlisted senders,
   explicit Cloudflare failures, and missing-verdict domain entries.
3. For an allowlisted exact address with an unavailable verdict, read the raw
   message through the existing one-megabyte limiter, then verify DKIM with a
   narrow RFC 6376 implementation built on Worker-native Web Crypto. Support
   RSA/SHA-256 plus simple/relaxed canonicalization; reject unsupported or weak
   algorithms rather than pulling a full Node mail stack into the Worker.
4. Supply the verifier with a custom TXT resolver backed by Cloudflare's
   DNS-over-HTTPS JSON endpoint, because Workers do not expose a synchronous
   DNS lookup API. Normalize DNS failures to fail closed. Cap the number of
   DKIM signatures processed to bound DNS/CPU work.
5. Require a single parsed outer `From` equal to the normalized envelope sender,
   a `pass` result aligned to that `From`, SHA-256, `From` among the signed
   headers, a valid signature time, and no DKIM `l=` body-length limit.
6. Add a test-only resolver seam through `EmailIngestEnv` so Worker-pool tests
   exercise real DKIM cryptography without public DNS.
7. Log when the independent fallback succeeds or fails without logging message
   bodies, keys, or private household configuration.

## Likely affected files or modules

- `src/server/ingest.ts`
- `src/server/ingest/dkim.ts`
- `src/server/worker.ts` comments
- `src/client/pages/Settings.tsx`
- `tests/server/email.test.ts`
- `tests/client/pages/Settings.test.tsx`
- `docs/cloudflare-github-setup.md`
- `docs/reviews/2026-07-22-adversarial-review.md`
- `package.json`
- `package-lock.json`
- `CHANGELOG.md`
- `.pipeline/changes.md`, `.pipeline/tests.md`, `.pipeline/review.md`

## Changelog plan

This is a production-blocking bug fix. Add a concrete `0.3.1` section dated
2026-07-23 to `CHANGELOG.md`, and bump both package version fields in
`package.json` and `package-lock.json` from `0.3.0` to `0.3.1`. Do not add an
`Unreleased` section.

## Edge cases

- Trusted DMARC failure plus a valid DKIM signature must still reject.
- A sender-planted pass from another authserv-id must not suppress the fallback
  or override a trusted failure.
- A DKIM signature from an unrelated domain must not authenticate the sender.
- A valid signature whose signed header set omits `From`, uses SHA-1, limits the
  signed body with `l=`, is expired/future-dated, or covers a tampered body must
  reject.
- Multiple outer `From` mailboxes and group syntax must reject.
- Resolver timeout, malformed JSON/TXT data, NXDOMAIN, missing keys, weak keys,
  and excess signatures must reject without throwing out of `email()`.
- A broken raw stream on the fallback path becomes the existing metadata-only
  `failed` row and is forwarded best-effort.
- Truncated messages cannot verify their original DKIM body hash and therefore
  reject; they must not be stored as received.

## Verification plan

- Add Worker-pool integration tests that generate signed mail with a test RSA
  key and inject its DNS TXT record:
  - legitimate exact-address mail with no trusted verdict is received;
  - body or sender spoofing is rejected;
  - unaligned DKIM, multiple/mismatched `From`, domain-only allowlist, and
    explicit Cloudflare failure reject;
  - trusted passing verdict behavior remains unchanged.
- Extend parser unit tests for `pass`/`fail`/`unavailable`.
- Update the Settings test for the operational help text.
- Run focused server and client tests, typecheck, full test suite, production
  build, and a Wrangler production dry run inside `nix develop`.
- Record the supplied production forwarded-message Activity result as the live
  reproduction. A post-merge production smoke remains necessary for the new
  code path: resend that legitimate Fastmail message, send a direct vendor
  message, and attempt a controlled spoof of the exact allowlisted address.
