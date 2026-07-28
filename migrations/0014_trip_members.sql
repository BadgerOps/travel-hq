-- Cloudflare Access authenticates an email; Travel HQ decides which trips
-- that signed-in account may see and whether it may change them.
CREATE UNIQUE INDEX idx_user_email_nocase ON user(lower(email));

CREATE TABLE trip_member (
  trip_id             TEXT NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  invited_by_user_id  TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (trip_id, user_id)
);

CREATE INDEX idx_trip_member_user ON trip_member(user_id, trip_id);
