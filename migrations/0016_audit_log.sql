-- Durable, owner-viewable record of the actions that unmask stored secrets
-- (issue #8). Reveals were previously only console.info'd from the routes:
-- ephemeral, unqueryable, and gone the moment the log retention window closed.
-- An owner asking "who looked at my passport number last month, and when?"
-- could not be answered at all.
--
-- WHAT IS STORED, AND WHAT IS NOT: the identifier of the revealed record and
-- the NAME of the field revealed -- never the revealed value. Persisting the
-- plaintext here would recreate, in an unencrypted table, exactly the exposure
-- the envelope encryption in src/server/crypto/envelope.ts exists to prevent,
-- and would make the audit trail a more attractive target than the data it
-- audits.
--
-- A row is written ONLY after a reveal actually succeeded. A denied (viewer
-- role) or nonexistent reveal throws in the repository before the route
-- reaches this table, so the log never claims a reveal that did not happen.
CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  -- Stable, greppable event names shared with the structured logger so a row
  -- here and a log line there describe the same action by the same word.
  event         TEXT NOT NULL
                  CHECK (event IN ('document_reveal','confirmation_reveal')),
  -- Who did it. The user id is the durable handle; the email is denormalized
  -- because the audit view must still name the actor after that account is
  -- removed from the household. Deliberately NOT a foreign key to user(id):
  -- an audit record has to outlive the row it describes, and a cascade that
  -- deleted history when an account was removed would defeat the point.
  actor_user_id TEXT NOT NULL,
  actor_email   TEXT NOT NULL,
  -- WHICH RECORD was unmasked. Also deliberately un-foreign-keyed, for the
  -- same reason: deleting a booking must not erase the record of it having
  -- been revealed.
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('person','booking')),
  subject_id    TEXT NOT NULL,
  -- WHICH FIELD of it: 'passport_number' | 'ktn' | 'redress_number' for a
  -- person, 'confirmation_number' for a booking. A name, never a value.
  field         TEXT NOT NULL,
  -- The parent trip a booking reveal was performed under, validated against
  -- the booking before the reveal ran (issue #19). NULL for person reveals,
  -- which are household-scoped and have no trip parent.
  trip_id       TEXT,
  -- When the reveal happened (ISO 8601, UTC).
  at            TEXT NOT NULL
);

-- The only read pattern: this household's audit trail, newest first.
CREATE INDEX idx_audit_log_household_at ON audit_log(household_id, at DESC, id DESC);
