-- Household-scoped agent configuration: one row per household, read through
-- HouseholdSettingsRepo at request time (the /api/settings routes) and at
-- ingest time (the email() handler resolves the target household from the
-- inbound To: address, then reads the allowlist and model).
--
-- A household with NO row here behaves as the defaults: no forward address,
-- an empty sender allowlist (= no ingest at all), and the default Workers AI
-- model. The row is created lazily on the first settings write.
CREATE TABLE household_settings (
  -- One row per household, hence the primary key.
  household_id      TEXT PRIMARY KEY REFERENCES household(id) ON DELETE CASCADE,
  -- The address mail is sent to for this household, matched against To: in
  -- email(). Stored normalized (trimmed, lowercased) by the repo. UNIQUE so
  -- an inbound address resolves to at most one household; NULL (allowed,
  -- and multiple NULLs are fine under a SQLite UNIQUE) means ingest is not
  -- configured for this household.
  forward_address   TEXT UNIQUE,
  -- JSON array of normalized (lowercased) addresses and/or bare domains
  -- permitted to submit mail, enforced together with DMARC/SPF by the
  -- ingest handler. '[]' means no sender is permitted: no ingest.
  sender_allowlist  TEXT NOT NULL DEFAULT '[]',
  -- The Workers AI model id the extractor runs.
  ai_model          TEXT NOT NULL DEFAULT '@cf/meta/llama-3.1-8b-instruct',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
