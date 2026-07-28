-- Remembers that a human looked at two bookings the duplicate matcher paired
-- (src/server/dedupe.ts) and said they are NOT the same event.
--
-- Without this the trip page re-reports the same false positive on every load,
-- and the one shape that produces it is completely ordinary: a family books
-- two hotel rooms for the same night at the same property, which is same kind,
-- same start minute, same location, different names -- the matcher's weakest
-- ("same-slot") rule, and exactly what it is designed to surface for a human
-- rather than decide alone. A warning that cannot be answered is a warning
-- people learn to ignore.
--
-- One row per unordered pair: the ids are stored sorted, so dismissing A/B and
-- dismissing B/A are the same row and the second one is a no-op. Both sides
-- cascade -- deleting (or merging away) either booking retires the dismissal
-- with it, so a recycled id cannot inherit a decision made about something
-- else.
CREATE TABLE booking_duplicate_dismissal (
  household_id   TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  booking_id_lo  TEXT NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  booking_id_hi  TEXT NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  dismissed_at   TEXT NOT NULL,
  PRIMARY KEY (household_id, booking_id_lo, booking_id_hi),
  -- Enforces the sorted-pair invariant at the schema level: an unsorted insert
  -- is a bug in the repo, not a second row for the same pair.
  CHECK (booking_id_lo < booking_id_hi)
);

CREATE INDEX idx_duplicate_dismissal_household
  ON booking_duplicate_dismissal(household_id);
