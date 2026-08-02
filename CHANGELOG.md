# Changelog

## Unreleased

- Added push notifications, so Travel HQ can say what the day holds without
  being opened. Two kinds, both per-person rather than per-household, because
  whether and when *I* want to be nudged is not a setting the household shares:
  a **daily digest** at a time you choose, summarising that day's flights,
  check-ins and check-outs, activities and anything on the checklist that is
  due; and a **pre-event reminder** a configurable lead time before anything
  with a real start instant, defaulting to 60 minutes.
- Reminder lead times are a tri-state per booking — inherit, a specific lead,
  or off — edited in the same dialog that already edits every other field.
  `0` means "at start" and is deliberately not the same as "off", so the two
  are separate settings rather than one number with a magic value.
- You are subscribed by default to bookings you are travelling on, can
  subscribe to or unsubscribe from any individual booking, and can follow every
  timed event on a trip in one go — stored as a single trip-scoped row, so
  bookings added to that trip later are covered without revisiting the setting.
  An explicit choice always beats the default, in both directions: unsubscribing
  from a flight you are on stays unsubscribed.
- Reminder send times are computed from the stored instant alone, so no device
  clock or reader's timezone can move them; a booking's own zone affects only
  the wording ("Departs 10:15 AM GMT+9" beats the same moment rendered in a home
  zone you are not in). Only the digest needs a wall clock, so `user.timezone`
  now exists: it holds an IANA name rather than an offset (the name carries DST),
  is refreshed from the device when the app is opened and on returning to the
  foreground, and can be pinned by hand in Settings — a pinned zone is never
  silently overwritten by the next refresh, and there is a one-click reset back
  to the device's.
- **There are no quiet hours, on purpose.** A 05:00 reminder before a 06:00
  flight is the most valuable notification this app can send, and a rule that
  swallowed it would be a bug with a friendly name. The real worry — that 05:00
  is the first you hear of it — is answered by adding rather than suppressing:
  an event firing before about 07:00 local also appears in the previous
  evening's digest.
- Nothing is sent twice, including across overlapping or retried scheduled runs:
  a notification is claimed in a log table before it is sent, and a losing claim
  simply means another run already owns it. The claim is keyed on the event's
  instant rather than the booking id, which is what makes a rescheduled
  departure correctly re-arm instead of silently never notifying again.
- Notification payloads carry titles and times only — never confirmation or
  document numbers. A push payload is stored on a third-party push service and
  shows on a lock screen, so it is held to the same rules as the log stream.
  Tapping one opens the relevant day.
- Settings gained a Notifications section: enable or disable this device, the
  digest and its time, the global lead time, the timezone, the list of
  registered devices, and a **"send me a test notification"** button that stays
  as a permanent diagnostic. On iOS it degrades honestly rather than offering a
  button that cannot work — web push there needs iOS 16.4+ and the app installed
  to the home screen, so a Safari tab is shown the install steps instead, and a
  previously denied permission is explained rather than silently re-requested.
- This is the Worker's first scheduled trigger — a five-minute cron and a
  `scheduled()` handler. It sweeps a *window* rather than looking for "now",
  bounds how far it will catch up after a missed run (an overdue reminder sends;
  a much staler one is dropped with a log line, because a reminder for a flight
  that left forty minutes ago is worse than silence), and prunes subscriptions
  the push service reports as gone, which iOS relies on. The raw-email retention
  purge from #22, which until now had to ride along on request paths for want of
  a timer, runs there too. Adds `GET/PUT /api/notifications/preferences`,
  `PUT /api/notifications/timezone`,
  `GET/POST/DELETE /api/notifications/subscriptions`,
  `POST /api/notifications/test`,
  `GET/PUT /api/bookings/:bookingId/notification`,
  `PUT /api/trips/:tripId/notification`, and a D1 migration. Requires a VAPID
  keypair: `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` as vars, `VAPID_PRIVATE_KEY`
  as a Worker secret. Until they are set the sweep logs that it is unconfigured
  and takes no claims, so nothing is silently consumed.
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
- Added observability, so a failure is something you can look up rather than
  guess at. Every request now emits one JSON log line carrying a request id,
  the route pattern, the household and user ids, the status and how long it
  took — and returns that id as `X-Request-Id`, so a reported problem can be
  traced from the header alone. A 500 writes the real cause (class, message,
  stack) to the log while the client still gets only `Internal error`;
  previously it left no trace anywhere. Tenancy-scope bugs are logged in
  production too, instead of being silenced in the one environment that
  needed them. Emails, document numbers, confirmation values and raw message
  bodies are kept out of the log stream by a redacting logger with a test
  that asserts it. Reveals of a passport, Known Traveler, redress or
  confirmation number are now recorded in a new `audit_log` table and shown
  to household owners in Settings — who unmasked which record, and when,
  never the value itself. Adds `GET /api/audit/reveals` and a D1 migration.
- Fixed two nested trip routes that did not check the parent in their URL.
  Revealing a booking's confirmation number under a *different* trip's URL now
  answers 404 instead of succeeding (and the audit entry records the validated
  trip), and asking for the travellers of an unknown or other-household trip
  answers 404 instead of an empty list, matching the sibling bookings,
  itinerary and rollup routes.
- Fixed three places where a failure or a second writer could leave the
  database half-changed. Assigning a person to a booking now writes the
  booking and the trip roster in one transaction, so the two can no longer
  disagree about who is on a trip. Marking a forwarded email extracted or
  failed now confirms it actually changed the row, so two overlapping
  extractor runs can no longer both be told they won. And a forward address
  claimed by two households at the same instant now answers the loser with
  the same "already in use" message the ordinary check gives, instead of a
  server error.
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
- Gave forwarded email an encryption and retention lifecycle. The raw message
  is now sealed at rest with the same envelope crypto and rotatable key ring
  that protect passport and confirmation numbers, and it no longer lives
  forever: the full text is kept for 7 days after a successful extraction and
  up to 30 days while an extraction is still queued or has failed, then
  redacted automatically — the sender, subject, status and the bookings
  extracted from it are kept. Purging is opportunistic (it rides on ingest and
  on import review, since the Worker has no cron trigger), rows written before
  this change stay readable as plaintext, Settings and the ingest activity
  dialog state the policy, and re-running extraction over a message whose
  window has passed answers 410 with the reason instead of silently finding
  nothing. Adds `POST /api/imports/:inboundEmailId/reextract` and a D1
  migration.
- Added editing to the import review queue, so an extraction can be corrected
  before it becomes a booking rather than after: an Edit button on every
  pending import opens the same form as Add booking, pre-filled from the
  draft, and every field it draws — kind, title, location, both timestamps and
  their timezones, confirmation number, cost and the per-kind details — is
  saved onto the draft and committed by the later accept. The queue's
  "Existing trip" picker is now ordered by how well each trip fits the imports
  currently selected — date containment first, then overlap, then the nearest
  gap in days, with a conservative destination match as a tie-break — and each
  option says why it is ranked where it is ("covers these dates · same
  destination"). Adds `PATCH /api/imports/drafts/:draftId`.
- Fixed a booking whose confirmation number can no longer be decrypted taking
  down far more than itself. Duplicate detection reads every booking on a trip
  at once, so one unreadable row — an envelope sealed under a key a rotation
  has since retired, or a value written before envelope encryption existed —
  turned both the trip's duplicates card and the whole import review queue into
  an Internal error, even though every other view of that same booking already
  degrades gracefully. Matching now treats an unreadable confirmation as no
  signal at all and keeps comparing on title, time and location, so the row
  cannot hide a real duplicate either; a duplicate group that cannot be
  rendered is dropped with a logged warning rather than shown half-built.

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
