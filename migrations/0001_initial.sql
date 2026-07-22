CREATE TABLE household (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE user (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  auth_subject  TEXT UNIQUE,
  created_at    TEXT NOT NULL
);

CREATE TABLE household_member (
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner','adult','viewer')),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE person (
  id                    TEXT PRIMARY KEY,
  household_id          TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  user_id               TEXT REFERENCES user(id) ON DELETE SET NULL,
  display_name          TEXT NOT NULL,
  dob                   TEXT,
  notes                 TEXT,
  passport_number       TEXT,   -- encrypted envelope
  passport_expiry       TEXT,
  passport_country      TEXT,
  known_traveler_number TEXT,   -- encrypted envelope
  redress_number        TEXT,   -- encrypted envelope
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_person_household ON person(household_id);

CREATE TABLE loyalty_account (
  id                  TEXT PRIMARY KEY,
  household_id        TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  person_id           TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  program             TEXT NOT NULL,
  account_number      TEXT,     -- encrypted envelope
  status_tier         TEXT,
  balance             INTEGER,
  balance_updated_at  TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_loyalty_household ON loyalty_account(household_id);

CREATE TABLE trip (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  destination   TEXT,
  starts_on     TEXT,
  ends_on       TEXT,
  status        TEXT NOT NULL DEFAULT 'planning'
                  CHECK (status IN ('planning','active','complete','cancelled')),
  notes         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_trip_household ON trip(household_id);

CREATE TABLE trip_person (
  trip_id    TEXT NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (trip_id, person_id)
);

CREATE TABLE booking (
  id                   TEXT PRIMARY KEY,
  household_id         TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  trip_id              TEXT NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  location             TEXT,
  starts_at            TEXT,
  starts_at_tz         TEXT,
  ends_at              TEXT,
  ends_at_tz           TEXT,
  confirmation_number  TEXT,
  cost_cents           INTEGER,
  points_used          INTEGER,
  points_program       TEXT,
  status               TEXT NOT NULL DEFAULT 'planned'
                         CHECK (status IN ('draft','planned','booked','cancelled')),
  details              TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_booking_household ON booking(household_id);
CREATE INDEX idx_booking_trip_starts ON booking(trip_id, starts_at);

CREATE TABLE booking_person (
  booking_id  TEXT NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (booking_id, person_id)
);
CREATE INDEX idx_booking_person_person ON booking_person(person_id);

CREATE TABLE checklist_item (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  trip_id       TEXT NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  person_id     TEXT REFERENCES person(id) ON DELETE SET NULL,
  label         TEXT NOT NULL,
  due_on        TEXT,
  done_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_checklist_household ON checklist_item(household_id);
