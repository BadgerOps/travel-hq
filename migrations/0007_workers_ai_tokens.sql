-- Give each household an explicit Workers AI output budget. Cloudflare's
-- model default is too small for a multi-booking response and may be consumed
-- before a reasoning model emits its structured answer.
ALTER TABLE household_settings
  ADD COLUMN ai_max_tokens INTEGER NOT NULL DEFAULT 4096
    CHECK (ai_max_tokens BETWEEN 256 AND 8192);
