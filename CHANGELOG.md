# Changelog

## 0.4.0 - 2026-07-24

- Added authenticated PDF itinerary uploads that convert documents with
  Workers AI, preserve an inbound audit record, and create reviewable booking
  drafts through the household's configured extraction provider.
- Replaced the Import placeholder with upload progress, extraction errors, and
  draft previews, while keeping imports unavailable to viewer roles.
- Hardened Workers AI response handling for valid JSON wrapped in Markdown
  fences or model prose without accepting malformed JSON.

## 0.3.1 - 2026-07-23

- Fixed legitimate forwarded-email rejection when Cloudflare omits its
  authentication-result headers by independently verifying aligned DKIM for
  exact-address allowlist entries.
- Kept explicit Cloudflare failures, domain-only fallback, unaligned or
  partial-body signatures, and DNS failures fail-closed; documented the
  production direct/forwarded/spoof smoke test.
- Added a bounded Worker-native RSA/SHA-256 verifier using Web Crypto and a
  fixed DNS-over-HTTPS resolver, with a clean dependency audit.

## 0.3.0 - 2026-07-23

- Added configurable Workers AI and Anthropic extraction providers, encrypted
  per-household Anthropic keys, model selection, and household prompt guidance.
- Added a paste-based extraction dry run and a metadata-only recent ingest
  activity feed to Settings.
- Added runtime fallback to Workers AI when saved Anthropic credentials cannot
  be used, while recording the provider that produced each AI draft.

## 0.2.0 - 2026-07-23

- Added `.ics`-first inbound-email extraction with a Workers AI JSON-mode
  fallback for plain-text, HTML-only, and attached forwarded confirmations,
  using the model configured per household in the app.
- Added transactional pending drafts and source-email provenance for extracted
  and accepted bookings.
- Added the Workers AI binding to every deployment environment and documented
  the required deploy-token permission.
