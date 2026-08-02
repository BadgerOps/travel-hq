-- Turns audit_log from a reveal ledger into a rolling household activity log.
--
-- 0016 built this table to answer exactly one question -- "who unmasked my
-- passport number, and when?" -- and its CHECK constraints say so: two event
-- names, two subject types. The question a household actually asks is broader
-- ("who changed this, and when?"), and answering it in a second table would
-- give the same question two histories to disagree about.
--
-- Three changes, all of which need the table rebuilt because SQLite cannot
-- ALTER a CHECK constraint in place:
--
--   1. `self_service`, so a self-reveal can be told apart from a reveal of
--      somebody else's record.
--   2. `detail`, holding the NAMES of the fields a change touched.
--   3. Wider `event` and `subject_type` CHECKs.
--
-- WHAT `detail` MAY CONTAIN, AND WHY IT MATTERS: field NAMES only, as
-- {"fields":["phone","passport_number"]}. NEVER values, and never before/after
-- pairs. This table is append-only, long-lived, unencrypted, and readable by
-- the household owner -- writing values into it would rebuild, in the clear,
-- precisely the secrets src/server/crypto/envelope.ts exists to keep out of
-- the database, and would make the audit trail a more attractive target than
-- the data it audits. It is the same argument 0016 made for having no `value`
-- column at all, applied to the one column that could now smuggle one in.
-- AuditRepo enforces it above this line: `record()` accepts a list of field
-- names, not a value bag, and rejects any name that is not a bare identifier.
--
-- `self_service` DEFAULTS TO 0, AND THAT IS CORRECT FOR HISTORY rather than
-- merely convenient. Every reveal recorded before this migration happened
-- under a rule (requireReveal) that refused viewers outright and had no
-- concept of a self-reveal, so no historic row can be the kind of self-service
-- access this column exists to filter out. Deriving it instead by joining
-- subject_id back to person.user_id would relabel history with a rule that was
-- not in force when it was written -- and would break the moment the person is
-- deleted or relinked, which is the same reason 0016 denormalized the actor's
-- email rather than joining to user(id).

CREATE TABLE audit_log_rebuilt (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  -- Stable, greppable event names shared with the structured logger so a row
  -- here and a log line there describe the same action by the same word.
  event         TEXT NOT NULL
                  CHECK (event IN ('document_reveal','confirmation_reveal',
                                   'person_created','person_updated',
                                   'member_invited','member_role_changed')),
  -- Who did it. The user id is the durable handle; the email is denormalized
  -- because the audit view must still name the actor after that account is
  -- removed from the household. Deliberately NOT a foreign key to user(id):
  -- an audit record has to outlive the row it describes, and a cascade that
  -- deleted history when an account was removed would defeat the point.
  actor_user_id TEXT NOT NULL,
  actor_email   TEXT NOT NULL,
  -- WHICH RECORD was acted on. Also deliberately un-foreign-keyed, for the
  -- same reason: deleting a booking must not erase the record of it having
  -- been revealed.
  subject_type  TEXT NOT NULL
                  CHECK (subject_type IN ('person','booking','household_member')),
  subject_id    TEXT NOT NULL,
  -- The single field a REVEAL unmasked: 'passport_number', 'redress_number',
  -- 'confirmation_number'. A name, never a value. Now nullable, because a
  -- change event names its fields in `detail` instead -- there is no honest
  -- single value to put here when an edit touched three columns. The CHECK
  -- below keeps it required for the events that do name exactly one.
  field         TEXT,
  -- The parent trip a booking reveal was performed under, validated against
  -- the booking before the reveal ran (issue #19). NULL for person reveals,
  -- which are household-scoped and have no trip parent.
  trip_id       TEXT,
  -- 1 when the actor acted on their OWN record. Written at the time of the
  -- action; see the header above.
  self_service  INTEGER NOT NULL DEFAULT 0 CHECK (self_service IN (0,1)),
  -- JSON, field NAMES only. See the header above; this is the constraint the
  -- whole change hangs on.
  detail        TEXT CHECK (detail IS NULL OR json_valid(detail)),
  -- When it happened (ISO 8601, UTC).
  at            TEXT NOT NULL,
  -- A reveal that cannot name the field it unmasked records nothing useful,
  -- and the repo has always required one. Stated here too so a future caller
  -- writing directly cannot produce a reveal row that answers "which field?"
  -- with NULL.
  CHECK (event NOT IN ('document_reveal','confirmation_reveal') OR field IS NOT NULL)
);

-- Every existing row is a reveal, predating both new columns, so it takes the
-- defaults: no detail, and self_service 0.
INSERT INTO audit_log_rebuilt
  (id, household_id, event, actor_user_id, actor_email,
   subject_type, subject_id, field, trip_id, self_service, detail, at)
SELECT id, household_id, event, actor_user_id, actor_email,
       subject_type, subject_id, field, trip_id, 0, NULL, at
  FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_rebuilt RENAME TO audit_log;

-- Recreated because the DROP took the original with it. Still the primary read
-- pattern: this household's activity, newest first, and (id DESC) is what makes
-- the keyset cursor in AuditRepo.listActivity() a range scan rather than a sort.
CREATE INDEX idx_audit_log_household_at ON audit_log(household_id, at DESC, id DESC);

-- New, for the non-owner read. Everyone else sees only the entries they are the
-- actor or the subject of, and without this that filter is a scan of the
-- household's whole history to return one person's slice of it.
CREATE INDEX idx_audit_log_actor ON audit_log(household_id, actor_user_id, at DESC);
CREATE INDEX idx_audit_log_subject ON audit_log(household_id, subject_id, at DESC);
