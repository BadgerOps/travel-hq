-- Issue #6: preserve email provenance on accepted bookings and stage extracted
-- bookings outside a trip until a person reviews them.
ALTER TABLE booking
  ADD COLUMN source_inbound_email_id TEXT
    REFERENCES inbound_email(id) ON DELETE SET NULL;

CREATE INDEX idx_booking_source_inbound_email
  ON booking(source_inbound_email_id);

CREATE TABLE draft_booking (
  id                   TEXT PRIMARY KEY,
  household_id         TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  inbound_email_id     TEXT NOT NULL REFERENCES inbound_email(id) ON DELETE CASCADE,
  -- Stable position in the validated extraction result. Together with the
  -- source id this prevents duplicate drafts if status transition is retried.
  ordinal              INTEGER NOT NULL CHECK (ordinal >= 0),
  kind                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  location             TEXT,
  starts_at            TEXT,
  starts_at_tz         TEXT,
  ends_at              TEXT,
  ends_at_tz           TEXT,
  confirmation_number  TEXT,
  source               TEXT NOT NULL CHECK (source IN ('ics','ai')),
  extracted_json       TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','accepted','dismissed')),
  booking_id           TEXT REFERENCES booking(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  resolved_at          TEXT,
  UNIQUE (inbound_email_id, ordinal)
);

CREATE INDEX idx_draft_booking_household
  ON draft_booking(household_id);
CREATE INDEX idx_draft_booking_status
  ON draft_booking(household_id, status);
CREATE INDEX idx_draft_booking_email
  ON draft_booking(inbound_email_id, ordinal);
