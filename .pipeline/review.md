# Reviewer Handoff

## Verdict

`approve`

## Findings

No unresolved findings.

The first review pass found and returned three correctness issues to the Coder:

1. A calendar with both valid and invalid VEVENTs could have produced a
   silently partial draft set.
2. JavaScript date normalization could have converted impossible or
   nonexistent local calendar times into a different valid instant.
3. `markAccepted` did not require the accepted booking to retain the draft's
   source inbound-email id.

Those issues are fixed in `src/server/ingest/ics.ts` and
`src/server/repos/draft-booking.ts`, covered by focused tests, and the complete
suite passed afterward.

After the user clarified that ordinary airline/hotel forwards and in-app AI
configuration are mandatory, a second adversarial pass reviewed the expansion:

- HTML is converted to text without rendering or executing it; script, style,
  head, and comments are discarded.
- `message/rfc822` attachments recurse into the forwarded sender, subject,
  body, and calendars.
- MIME depth and prompt length are bounded to contain resource exhaustion.
- Email text remains untrusted model input, but constrained schema validation
  and pending-draft review prevent it from directly creating a live itinerary
  booking.
- `household_settings.ai_model`, `/api/settings`, and the Settings page—not
  Wrangler—select the per-household model. Wrangler supplies only `env.AI`.

No additional blocking findings remain after that pass.

## Review notes

- Issue #6 acceptance criteria are covered:
  - AI binding in default/testing/production and deploy permission documented.
  - Calendar-first behavior skips AI even on calendar parse failure.
  - Plain-text, HTML-only, and attached forwarded messages reach Workers AI.
  - Workers AI call uses the in-app household model and one strict JSON schema.
  - Drafts and accepted bookings retain source provenance.
  - `received → extracted|failed` transitions are exercised.
  - Inline entry point is wired after verified storage and remains fail-soft.
  - Fake-AI success/failure tests make no real inference calls.
- Existing issue-#4 protections remain intact: sender verification precedes
  body reads, rejected content is not stored, raw input remains byte-bounded,
  and extraction cannot create a duplicate failed inbound row.
- Draft inserts are tenant-validated and transactional; ordinals provide retry
  uniqueness.
- Scope is limited to issue #6 plus its migration, deployment configuration,
  release metadata, and tests.
- Changelog/version requirements are satisfied with concrete version `0.2.0`.

## Residual risks

- Production still needs a Cloudflare deploy token carrying
  **Account · Workers AI · Read**. A token without it will fail the deployment
  that attaches `env.AI`.
- Real Workers AI output and latency are not exercised in CI by design.
- Real Email Routing delivery remains dependent on the production routing
  switch and sender-authentication behavior tracked separately.
- Extraction runs inline; production-sized latency/load is not benchmarked.
- MIME and iCalendar parsing are deliberately bounded rather than RFC-complete.
- Binary-only attachments such as PDF itineraries are not text-extracted by
  this issue; a useful email body, HTML body, nested email, or `.ics` part is
  required.
