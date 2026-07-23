-- Card portfolio + per-card perks/credits (issue #2).
-- Deliberately stores NO sensitive card data: no PAN, no last4, no account
-- numbers. A card is identified by its display name and referenced by id.
-- Anything secret belongs on the loyalty_account-style encrypted path, not
-- here. See docs/superpowers/specs/2026-07-23-card-perks-design.md.

CREATE TABLE card (
  id                  TEXT PRIMARY KEY,
  household_id        TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  issuer              TEXT,
  points_program      TEXT,
  points_balance      INTEGER,
  balance_updated_at  TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_card_household ON card(household_id);

CREATE TABLE card_perk (
  id              TEXT PRIMARY KEY,
  household_id    TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  card_id         TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL
                    CHECK (kind IN ('statement_credit','free_night','lounge','multiplier','fee_offset')),
  -- Credit value in cents; NULL for perks with no dollar value (a lounge
  -- membership, an unvalued free night) and always NULL for multipliers.
  value_cents     INTEGER,
  -- Earn multiplier (e.g. 3.0 for 3x) and its spend category; both set only
  -- when kind = 'multiplier'.
  multiplier      REAL,
  category        TEXT,
  cadence         TEXT NOT NULL
                    CHECK (cadence IN ('annual','monthly','one_time')),
  -- Annual-cadence reset day as MM-DD (e.g. '01-01' calendar year, '07-15'
  -- cardmember anniversary). NULL means 01-01.
  reset_month_day TEXT,
  -- When the credit was last marked used. "Used this period" is derived at
  -- read time from this timestamp and the cadence; a period rollover needs
  -- no write. NULL = never used / explicitly marked unused.
  used_at         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_card_perk_household ON card_perk(household_id);
CREATE INDEX idx_card_perk_card ON card_perk(card_id);
