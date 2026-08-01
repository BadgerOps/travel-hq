-- Raw inbound mail is the densest personal data Travel HQ stores: one
-- forwarded confirmation carries the traveller's name, contact details, the
-- whole itinerary, loyalty numbers and sometimes payment metadata, all in a
-- single column. Until this migration `inbound_email.raw` was written as
-- plaintext and kept forever -- weaker than the treatment of a passport
-- number or a booking confirmation number, both of which are already sealed
-- with the AES-GCM envelope in src/server/crypto/envelope.ts and its
-- rotatable key ring.
--
-- Two columns give raw the same protection and, for the first time, an end:
--
--   raw_encryption -- how `raw` is physically stored.
--     'plaintext' is BOTH the legacy value and the DEFAULT, on purpose: every
--     row written before this migration holds a readable RFC 5322 message and
--     is now labelled as such without a rewrite (a rewrite would need the key
--     ring, which a migration does not have). New rows written by a path that
--     has the key ring are stored 'envelope' -- the same `v1.<key-id>.<iv>.
--     <ciphertext>` format, and therefore the same key rotation story, as
--     person.passport_number and booking.confirmation_number.
--     InboundEmailRepo reads the column rather than sniffing the value, so a
--     legacy plaintext message is decoded as plaintext instead of failing to
--     decrypt and being dropped on the floor.
--
--   raw_purged_at -- when the retention sweep redacted `raw` to ''.
--     NULL means "never purged", which is deliberately NOT the same as "has
--     raw": a rejected sender's row, and a row whose ingest failed before the
--     stream could be read, are both born with raw = '' and no purge stamp.
--     Keeping the two apart is what lets the UI (and the re-extraction
--     endpoint) say "the message is no longer retained" rather than the
--     misleading "no message was ever stored", and stops the sweep rewriting
--     rows that have nothing to redact.
--
-- The windows themselves are NOT encoded here. SQLite has no scheduled work,
-- and a CHECK constraint cannot express "older than N days"; the numbers live
-- in src/shared/email-retention.ts as named constants that both the sweep and
-- the Settings copy read, so the policy and what the owner is told about it
-- cannot drift apart.
ALTER TABLE inbound_email ADD COLUMN raw_encryption TEXT NOT NULL DEFAULT 'plaintext'
  CHECK (raw_encryption IN ('plaintext', 'envelope'));
ALTER TABLE inbound_email ADD COLUMN raw_purged_at TEXT;

-- The retention sweep's access path: within one household, the rows that
-- still hold an unpurged message, oldest first. Leading with household_id
-- keeps it usable by the per-household opportunistic sweep; the trailing
-- received_at is what the age comparison reads.
CREATE INDEX idx_inbound_email_raw_retention
  ON inbound_email(household_id, raw_purged_at, received_at);
