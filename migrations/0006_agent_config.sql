-- Configurable extraction provider and household-specific prompt guidance.
-- Anthropic credentials are envelope-encrypted by HouseholdSettingsRepo;
-- plaintext is never stored in D1 or returned by the settings API.
ALTER TABLE household_settings
  ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'workers-ai'
    CHECK (ai_provider IN ('workers-ai', 'anthropic'));

ALTER TABLE household_settings
  ADD COLUMN anthropic_model TEXT NOT NULL DEFAULT 'claude-opus-4-8';

ALTER TABLE household_settings
  ADD COLUMN anthropic_api_key TEXT;

ALTER TABLE household_settings
  ADD COLUMN extraction_instructions TEXT NOT NULL DEFAULT '';
