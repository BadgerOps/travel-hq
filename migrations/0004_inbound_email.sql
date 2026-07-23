-- Durable record of inbound mail handled by the Worker's email() ingest
-- handler (src/server/ingest.ts). A row is written ONLY after the envelope
-- recipient matched a household's forward address (household_settings.
-- forward_address) -- an unclaimed recipient is dropped/forwarded, never
-- stored. The raw message is stored BEFORE any extraction so a failed
-- extraction is retryable from this row alone.
--
-- Status vocabulary (the extractor -- issue #6 -- and the review UI -- issue
-- #7 -- consume these):
--   received  -- stored by ingest; sender passed the allowlist AND DMARC/SPF.
--                The extraction queue: #6 reads rows in this state and
--                transitions them to extracted or failed.
--   extracted -- extraction produced a draft (written by #6, never by ingest).
--   failed    -- an internal error, at ingest time (raw kept best-effort,
--                may be empty) or at extraction time (#6). `error` says why.
--   rejected  -- recipient matched a household but the sender failed
--                verification (not allowlisted and/or failed DMARC/SPF).
--                Stored for auditability; never extracted. `error` says why.
CREATE TABLE inbound_email (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  -- Envelope (SMTP) addresses as seen by Email Routing; from_address is what
  -- the allowlist was checked against.
  from_address  TEXT NOT NULL,
  to_address    TEXT NOT NULL,
  -- Parsed from the message headers; either may legitimately be absent.
  subject       TEXT,
  message_id    TEXT,
  -- The full raw RFC 5322 message text (headers + body), truncated by the
  -- ingest handler to stay under D1's row-size limit. Empty string (never
  -- NULL) when the raw stream could not be read (a `failed` row).
  raw           TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','extracted','failed','rejected')),
  -- Human-readable outcome for failed/rejected rows (surfaced by issue #8 in
  -- Settings/Import); NULL on received rows.
  error         TEXT,
  -- When the ingest handler stored the row (ISO 8601).
  received_at   TEXT NOT NULL
);
CREATE INDEX idx_inbound_email_household ON inbound_email(household_id);
-- The extractor's queue scan: rows in a given status for a household.
CREATE INDEX idx_inbound_email_status ON inbound_email(household_id, status);
