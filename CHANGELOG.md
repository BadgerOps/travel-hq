# Changelog

## Unreleased

- Added booking editing. Every field a booking has — kind, title, location,
  both timestamps and their timezones, cost, confirmation number, status,
  travellers, and the per-kind details — can now be changed from an Edit
  button in the booking detail dialog, which reuses the same form as Add
  booking rather than a second one that could disagree with it. Adds
  `PUT /api/bookings/:bookingId`.
- Added excursion logistics to activities: pickup time, pickup location, how
  early to arrive, return time and return location are now first-class,
  editable fields, shown as their own block at the top of the booking detail
  dialog instead of a row in a JSON-shaped grid. Car bookings gained pickup
  and drop-off times alongside their existing locations.
- Taught the email parser to find those facts. A tour confirmation's "Pickup:
  1:30pm at Quarter Circle/West Side Parking Lot […] arrive 15 minutes before
  departure […] Approximate return time: 5:00" is now read out of the prose —
  and out of a calendar attachment's description — and used as the booking's
  location when the extractor found none. The model is asked for the same
  fields first and always wins; the scanner only fills gaps, and stands down
  entirely when one message describes more than one excursion.

- Added duplicate detection to trips, for the bookings a re-forwarded (or
  restated) confirmation email leaves behind: matching bookings are grouped on
  the trip page with the reason they matched, and can be merged into one — the
  survivor keeps its own values and fills its blanks from the others, inherits
  their travelers, the strongest status, and their source emails — or marked
  "not duplicates" so the group is never reported again. Adds
  `GET/POST /api/trips/:tripId/duplicates*`, `DELETE /api/bookings/:bookingId`,
  and a D1 migration.
- Added the same detection to the import review queue, so a re-forwarded
  confirmation is caught before it becomes a booking: a pending import that
  repeats an existing booking (or another import still in the queue) says so
  and names the trip, and accepting a confident match answers 409 until the
  reviewer chooses "Import anyway".
- Fixed duplicate detection treating the legs of one connecting itinerary as
  duplicates of each other — every leg of a ticket shares its record locator,
  so a shared confirmation number now has to be corroborated by the same name
  or the same departure minute.
- Fixed dialogs running off the bottom of the screen on mobile: the panel is
  now capped to the visible viewport, its body scrolls with the title and
  close control pinned above it, it clears the notch and home-indicator safe
  areas, it paints over the bottom tab bar, and the page behind it no longer
  scrolls while it is open.
- Fixed dates and amounts being validated differently depending on which write
  path you used. Creating a trip accepted "next tuesday", February 30th, or a
  range that ended before it began — all of which updating the same trip had
  always refused — and checklist due dates, dates of birth and passport
  expiries were never checked at all. A booking could be saved with a
  timestamp carrying no timezone, or one landing before it took off, and both
  a cost and a points total could be negative, which quietly subtracted from
  the trip's spend and points rollups. All of these are now the same 400 on
  every path, enforced in the repositories so the email-import path is covered
  too, and an imported booking whose extracted times or price cannot be
  trusted now arrives without them rather than not at all.

## 0.7.0 - 2026-07-27

- Made Recent ingest activity entries clickable, opening a detail dialog with
  the bookings parsed from each email, their extracted details, and the
  stored message content.
- Replaced JSON dumps in the booking-details and ingest-activity dialogs with
  readable label–value rows, and made the booking dialog's confirmation
  number revealable in place.
- Fixed the ingest-activity status chips stretching into ovals next to
  multi-line subjects.
- Added actionable pending-import cards to Home and Trips, with draft
  selection and the same atomic create-trip workflow used by the Import page.
- Added a manual existing-trip selector for unmatched pending imports.
- Added booking details from overview and day cards, including parsed source
  email content and retained calendar artifacts.
- Moved booking prices out of Overview into a dedicated Costs tab with total,
  status, category, booking, points, and filterable day-by-day analysis.
- Added an existing-trip traveler picker so owners and adults can add people
  from the Travelers tab and immediately refresh the trip roster.
- Added optional traveler email and phone contact fields, including create,
  edit, API validation, clickable card display, and a D1 migration.
- Improved app performance by excluding authenticated APIs from service-worker
  caching, batching traveler joins, reusing trip-list requests, lazy-loading
  cost totals, and bounding long-trip chart rendering.

## 0.6.0 - 2026-07-27

- Added authenticated `.eml` file uploads alongside PDF itinerary uploads,
  preserving the original MIME message and sender/subject metadata while using
  the same ICS-first, AI-fallback draft extraction as forwarded email.
- Updated the Import page with one PDF/EML file picker, format-specific size
  guidance, and validation errors.
- Added end-to-end coverage showing PDF uploads, EML uploads, and authenticated
  email forwarding produce the same reviewable drafts.
- Added a pending-import review queue for uploads and forwarded email, grouped
  by source message with explicit accept and dismiss actions.
- Suggested an existing non-cancelled trip only when it uniquely contains an
  import's local date range; ambiguous or unmatched imports remain unassigned.
- Added multi-select trip creation that converts selected drafts into
  source-linked planned bookings in one atomic operation.

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
