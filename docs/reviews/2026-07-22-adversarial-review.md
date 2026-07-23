# Adversarial repository review — 2026-07-22

Scope: authentication and authorization, household isolation, secret handling,
email ingress, data integrity, concurrency, browser/API behavior, CI/CD,
dependencies, and operational documentation.

## Executive summary

The repository has unusually strong tenant-scoping defenses for its size:
repository queries require an explicit scope token, join-table escape hatches
are narrow and greppable, raw SQL outside the repository/auth bootstrap layer is
CI-gated, viewer writes and reveals are denied at the repository layer, and
Cloudflare Access JWT verification checks issuer, audience, signature, expiry,
human identity, and household membership.

The review found three major code-level problems, fixed on the accompanying
security-hardening branch:

1. API responses containing private travel/person data were cacheable by
   default, including plaintext secret reveals. Reveal was also an audited GET,
   which made it eligible for prefetch/speculative invocation.
2. A rejected inbound message was fully read and persisted with up to 1 MB of
   attacker-controlled raw content. A public forward address was therefore a
   cheap D1 storage-exhaustion endpoint.
3. Sender authentication accepted verdict text from any Authentication-Results
   authority and did not read Cloudflare's documented
   ARC-Authentication-Results form. A planted pass could be selected over a
   genuine trusted SPF failure.

One major operational blocker and six medium/minor issues remain. They are
tracked in GitHub and summarized below so the review remains useful as a single
artifact.

## Fixed major findings

### M1 — Sensitive API caching and unsafe reveal semantics

Impact: plaintext passport, known-traveler, redress, and confirmation values
could be retained by a browser/intermediary or exposed to a future cache rule.
GET also misrepresented the logged reveal action as safe and prefetchable.

Remediation:

- every `/api/*` response, including errors, now carries
  `Cache-Control: no-store`;
- reveals use POST;
- reveal POSTs require `application/json`, making them non-simple browser
  requests that a cross-origin HTML form cannot submit;
- client and server regression tests cover method, content type, caching,
  viewer denial, errors, and refusal of form-style POSTs.

### M2 — Rejected-mail storage amplification

Impact: an unauthenticated sender could repeatedly send large messages to a
known household forward address and consume roughly 1 MB of D1 storage per
message. The handler also consumed the untrusted raw stream before deciding to
reject it.

Remediation:

- sender verification now occurs before the raw stream is read;
- rejected rows retain audit metadata and reason but store an empty raw body;
- accepted raw input is capped at 1,000,000 bytes while streaming, so a 25 MiB
  Email Routing message never needs to occupy Worker memory in full;
- regression tests prove a broken raw stream is untouched when the sender is
  rejected.

Residual risk: rejected metadata rows can still grow without a rate/retention
policy, but the amplification factor is removed.

### M3 — Untrusted authentication-result authority

Impact: the parser previously extracted all `dmarc=` text without authenticating
the `authserv-id`. In particular, a sender-planted DMARC pass plus a trusted SPF
failure and no trusted DMARC result was accepted because the presence of any
DMARC result suppressed SPF evaluation.

Remediation:

- only records whose authority is exactly `mx.cloudflare.net` are considered;
- both Authentication-Results and Cloudflare's documented
  ARC-Authentication-Results form are parsed;
- upstream/forged authorities are ignored, and all trusted results remain
  fail-closed.

Reference:
<https://blog.cloudflare.com/email-routing-subdomains/#arc>

## Outstanding findings

### O1 — Major: live Email Routing may expose no usable authentication verdict

Tracked in <https://github.com/BadgerOps/travel-hq/issues/20>.

Cloudflare workerd issue #6740 reports Worker deliveries with no
Authentication-Results and only an upstream ARC record containing no
SPF/DKIM/DMARC verdict:
<https://github.com/cloudflare/workerd/issues/6740>.

This matches the app's Gmail-forwarding use case. The application must not
weaken to envelope/allowlist-only trust, but staying fail-closed can reject all
legitimate forwarded confirmations.

Required action:

- deploy a diagnostic handler on the actual production rule;
- test direct vendor mail and Gmail-forwarded mail;
- record redacted authentication-related header names/values;
- prove legitimate mail becomes `received` and an allowlisted-sender spoof
  remains `rejected`;
- if the Cloudflare limitation persists, use an authenticated application-level
  forwarder or independent DKIM/SPF verification.

### O2 — Medium: temporal and numeric validation is inconsistent

Tracked in <https://github.com/BadgerOps/travel-hq/issues/23>.

Evidence:

- trip create accepts arbitrary `startsOn`/`endsOn`, while update validates
  exact calendar dates and ordering;
- person DOB/passport expiry and checklist due date accept arbitrary strings;
- bookings do not reject an end before the start, and `Date.parse` accepts
  ambiguous date-only/timezone-less values;
- costs and points accept negative integers despite being summed as
  spend/usage.

Required action: centralize exact calendar/instant validators, enforce them at
both route and repository boundaries on every create/update path, reject
inverted ranges, and explicitly decide whether negative adjustments are part of
the model.

### O3 — Medium: multi-row invariants and transitions are not atomic

Tracked in <https://github.com/BadgerOps/travel-hq/issues/21>.

Evidence:

- `BookingRepo.assignPerson()` writes `booking_person` and `trip_person` in two
  separate D1 calls, so the invariant can split after a partial failure;
- `InboundEmailRepo.transition()` performs read-then-conditional-update, ignores
  affected-row metadata, and returns the requested state even if a concurrent
  transition won;
- forward-address uniqueness is pre-checked, but a race reaching the database
  constraint maps to a generic 500 rather than the intended validation error.

Required action: batch the two join inserts, use compare-and-set with verified
row counts for transitions, translate raced uniqueness conflicts, and add
failure/concurrency tests.

### O4 — Medium: high-severity advisory in the Cloudflare toolchain

Tracked in <https://github.com/BadgerOps/travel-hq/issues/25>.

`npm audit` reported four high findings on 2026-07-22. The root is
`sharp@0.34.5` through `miniflare@4.20260721.0`, used by
`wrangler@4.113.0` and `@cloudflare/vitest-pool-workers@0.18.7`.
The advisory is <https://github.com/advisories/GHSA-f88m-g3jw-g9cj> and fixes
in `sharp>=0.35.0`.

This is not in the deployed Worker application bundle, but it is in developer
and CI/deploy tooling. Upgrade when the Cloudflare dependency graph supports the
fixed version (or test a compatible override); do not apply npm audit's proposed
large downgrade blindly.

### O5 — Medium: nested trip routes do not enforce parent-child integrity

Tracked in <https://github.com/BadgerOps/travel-hq/issues/19>.

The confirmation reveal route ignores its `:tripId` and looks up only
`:bookingId`, so a booking can be revealed under another trip's URL within the
same household. The travelers route returns `200 []` for an unknown trip while
bookings, itinerary, and rollup return 404.

Household scoping prevents a cross-tenant disclosure today, but the inconsistent
semantics weaken audit context and future authorization assumptions. Require the
booking to belong to the path trip and existence-check travelers' trip.

### O6 — Medium: raw verified email has no privacy lifecycle

Tracked in <https://github.com/BadgerOps/travel-hq/issues/22>.

Verified RFC 5322 messages are stored as plaintext in D1 and may contain names,
contact details, loyalty numbers, confirmation codes, itineraries, and payment
metadata. There is no application encryption, purge window, post-extraction
redaction, or delete path.

Define minimum retry/debug retention, purge/redact terminal messages, decide
whether raw needs envelope encryption/key rotation, document the policy, and
test it. The major fix above intentionally removes raw only from rejected mail;
verified mail remains available for the planned extractor.

### O7 — Minor: README describes mutually incompatible architectures

Tracked in <https://github.com/BadgerOps/travel-hq/issues/24>.

README correctly mentions a single Worker/D1 in its run section, but elsewhere
describes Node plus `node:sqlite`, a separate nonexistent
`src/server/serve.ts`, a nonexistent `workers/inbound-email` tree, local
Ollama/Claude parsing, and a Cloudflare Tunnel/self-hosted deployment.

Rewrite architecture, build, test, layout, status, ingest, and data-location
claims from the current tree before onboarding or production deployment.

## Verification performed

- inspected every server route/repository, auth, crypto, ingress, migration,
  workflow, client API/reveal path, and architecture guard;
- reviewed existing GitHub issues/PRs to avoid duplicate findings;
- ran the full server, architecture, and client suites before changes;
- after changes, passed all 536 server/architecture/client tests, TypeScript
  project references, the production Vite build, and `git diff --check`;
- ran `npm audit` against the current registry/advisory database.
