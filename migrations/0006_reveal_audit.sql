-- Durable audit trail for sensitive-document reveals (issue #8). One row per
-- successful reveal of an encrypted person document field (passport number,
-- Known Traveler Number, redress number) through
-- GET /api/people/:id/reveal/:field. The route writes the row BEFORE the
-- plaintext is returned to the client, so a failed audit write fails the
-- reveal -- there is no such thing as an unaudited reveal response.
--
-- Who/what/when only -- NEVER the revealed value, which must not exist
-- anywhere outside its encrypted envelope and the one-off reveal response.
--
-- user_email is denormalized on purpose: an audit record captures the fact
-- as it stood at reveal time and must survive the user row changing or
-- disappearing. person_id carries no FK for the same reason -- the audit row
-- must outlive the person it names. The household FK is the one cascade that
-- SHOULD take the trail with it: a deleted household owns its own history.
CREATE TABLE reveal_audit (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  -- Who: the authenticated identity that performed the reveal.
  user_id       TEXT NOT NULL,
  user_email    TEXT NOT NULL,
  -- What: the person whose document was revealed, and which field. Kept in
  -- sync with DOCUMENT_FIELDS in src/server/repos/person.ts.
  person_id     TEXT NOT NULL,
  field         TEXT NOT NULL
                  CHECK (field IN ('passport_number','known_traveler_number','redress_number')),
  -- When (ISO 8601).
  revealed_at   TEXT NOT NULL
);
CREATE INDEX idx_reveal_audit_household ON reveal_audit(household_id);
