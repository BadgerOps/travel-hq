-- Draft bookings extracted from inbound mail (issue #6). One row per booking
-- the extractor pulled out of an inbound_email — .ics attachment first, then
-- Workers AI JSON Mode. Drafts are NOT bookings: they carry no trip and are
-- invisible to the trip/itinerary views until the review UI (issue #7)
-- accepts one onto a trip (creating a real `booking` row via BookingRepo) or
-- dismisses it. Dismissal is a status change, never a delete — the row is the
-- audit trail of what the extractor claimed to have read.
--
-- Status vocabulary:
--   pending   -- written by the extractor; awaiting review (#7's queue).
--   accepted  -- a reviewer accepted it onto a trip; booking_id links the
--                created booking. Terminal.
--   dismissed -- a reviewer rejected it. Kept for audit. Terminal.
--
-- confirmation_number is stored in the clear here, unlike booking's encrypted
-- envelope: the same value already sits in plaintext in inbound_email.raw in
-- this same database, so encrypting the draft copy would add ceremony, not
-- security. It is encrypted at accept time, when BookingRepo.create writes
-- the real booking row and the raw email becomes prunable.
CREATE TABLE draft_booking (
  id                   TEXT PRIMARY KEY,
  household_id         TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  -- The stored email this draft was extracted from (#7 shows them together).
  inbound_email_id     TEXT NOT NULL REFERENCES inbound_email(id) ON DELETE CASCADE,
  -- Same vocabulary as booking.kind (BOOKING_KINDS); validated in the repo
  -- and by the extraction schema, not by a CHECK, matching booking's own
  -- convention.
  kind                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  location             TEXT,
  -- UTC instant + IANA zone pairs, same discipline as booking: a timestamp
  -- never appears without its zone (enforced in the repo).
  starts_at            TEXT,
  starts_at_tz         TEXT,
  ends_at              TEXT,
  ends_at_tz           TEXT,
  confirmation_number  TEXT,
  -- What produced this draft: the calendar attachment or the model.
  source               TEXT NOT NULL CHECK (source IN ('ics','ai')),
  -- The full validated extraction payload as JSON — everything the extractor
  -- read, including fields with no column here (costCents, per-kind details).
  -- The review UI carries this into the booking it creates on accept.
  extracted_json       TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','accepted','dismissed')),
  -- Set when accepted: the booking the reviewer created from this draft.
  -- SET NULL so deleting that booking later keeps the audit row.
  booking_id           TEXT REFERENCES booking(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  -- When the draft left pending (accepted or dismissed); NULL while pending.
  resolved_at          TEXT
);
CREATE INDEX idx_draft_booking_household ON draft_booking(household_id);
-- The review UI's queue scan: pending drafts for a household.
CREATE INDEX idx_draft_booking_status ON draft_booking(household_id, status);
-- "Show me what came out of this email" (#7 groups drafts by source email).
CREATE INDEX idx_draft_booking_email ON draft_booking(inbound_email_id);
