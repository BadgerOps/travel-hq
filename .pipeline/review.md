# Issue 20 review

## Verdict

`approve`

## Findings

No blocking, major, moderate, or minor code findings remain.

The first review pass found two non-security availability/consistency issues:

1. A malformed first DKIM signature could throw before a later valid aligned
   signature was checked.
2. One Planner sentence still named the removed `mailauth` prototype.

Both were returned to Coder/Tester. Per-signature failures are now isolated, a
real RSA regression proves a later valid signature succeeds, the spec is
consistent, and typecheck passes after the fix.

## Review notes

- Security boundary: the allowlist is still mandatory. Missing Cloudflare
  verdicts reach independent DKIM only for an exact-address entry; explicit
  trusted failures and domain-only entries reject before raw input or DNS.
- Cryptography: only RSA/SHA-256, minimum 1024-bit keys, valid signature time,
  strict signing-domain/outer-From alignment, a signed `From`, and a complete
  body are accepted. SHA-1, `l=`, invalid keys, unsupported services/hashes,
  unaligned identities, and tampering fail closed.
- Parser behavior: one outer `From` must equal the normalized envelope sender;
  duplicate/malformed tag lists, malformed headers, excess signatures, and
  multiple From fields fail closed. Signed-header selection walks repeated
  fields from the bottom as RFC 6376 requires.
- Resource bounds: raw mail remains capped at 1 MB, rejected bodies are not
  persisted, at most ten signatures are attempted, DNS goes only to the fixed
  Cloudflare DoH endpoint, and lookups time out after five seconds.
- Scope: no schema/routing/deployment changes and no new runtime dependency.
  Package and lock versions match `0.3.1`; the changelog uses a concrete
  section and contains no `Unreleased` entry.
- Verification: focused cryptographic and UI tests, the final 640-test full
  suite, typecheck, build, production dry bundle, dependency audit, and diff
  checks pass.

## Residual risks

- The new path cannot be proven against the production Email Routing rule
  before merge/deploy. The documented post-deploy direct, Fastmail-forwarded,
  and controlled-spoof smoke test remains mandatory. The supplied Activity
  record proves the original failure, not the remediation.
- Strict alignment intentionally rejects a valid DKIM signature whose `d=`
  domain is only organizationally related to, rather than exactly equal to,
  the outer From domain. That is safer for this exact-address fallback but may
  require the primary Cloudflare verdict for some providers.
- RSA/SHA-256 is deliberately the only independent fallback algorithm.
  Ed25519-only or otherwise unsupported signers remain rejected and use
  `FALLBACK_FORWARD_TO`.
- A Cloudflare DoH outage causes fail-closed rejection/forwarding until DNS
  recovers.
