-- Push notifications (issue #61): the state a reminder or a morning digest
-- needs in order to be sent to the right person, at the right local moment,
-- exactly once.
--
-- Nothing here lives in `household_settings`. Whether and when *I* want to be
-- nudged about a flight is a property of a person, not of a household -- two
-- adults sharing one household routinely want opposite answers, and a shared
-- row would force one of them to accept the other's. Every table below is
-- therefore keyed by `user_id` and carries NO `household_id`, exactly like
-- `trip_member` (migrations/0014_trip_members.sql). The consequence is that
-- the repository must prove reachability with a household-scoped query BEFORE
-- it writes an unscoped row; see src/server/repos/notification.ts, where every
-- such write names the scoped query that vouched for it.

-- WHICH WALL CLOCK IS "8am"? A digest is the one feature in the app that has
-- to answer that without an open browser tab to ask, so the answer has to be
-- stored.
--
-- An IANA zone NAME ('America/Los_Angeles'), never a fixed offset: the name
-- carries the DST rules, an offset is only true until the next transition. A
-- household that stored '-08:00' in November would send the March digest an
-- hour late, forever, with nothing in the data to show why. This is the same
-- rule `booking.starts_at_tz` already follows.
ALTER TABLE user ADD COLUMN timezone TEXT;
-- HOW the zone was set, and therefore who is allowed to overwrite it.
-- 'device' is posted automatically by the client on open and on
-- `visibilitychange`; 'manual' is a deliberate pin by the account holder. The
-- distinction exists so an auto-update cannot silently clobber a pin: someone
-- who lives in Boise and pinned it must not be moved to Europe/Paris by
-- opening the app in an airport lounge. NULL means never set, and behaves as
-- 'device' would -- the first auto-post wins.
ALTER TABLE user ADD COLUMN timezone_source TEXT
  CHECK (timezone_source IN ('device','manual'));
-- WHEN it was last set (ISO 8601, UTC). The digest reads this to tell a fresh
-- zone from a stale one; a zone last confirmed months ago is a worse guess
-- about where someone is this morning than the zone of that day's first event.
ALTER TABLE user ADD COLUMN timezone_updated_at TEXT;

-- One row per user, created lazily on the first save. A user with no row is
-- not an error and not "notifications broken" -- it is the documented default
-- (defaultNotificationPreferences() in src/server/repos/notification.ts), so
-- the read path never has to distinguish "off" from "not configured yet".
CREATE TABLE notification_preference (
  user_id                TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  -- The digest is OPT-IN (default 0): a daily unprompted push is a bigger ask
  -- than a reminder about a flight the person already booked.
  digest_enabled         INTEGER NOT NULL DEFAULT 0,
  -- Local wall clock as 'HH:MM', in the user's `timezone` above -- not an
  -- instant. "8am" must stay 8am across a DST boundary and across a move.
  -- NULL means the user enabled the digest without choosing a time yet.
  digest_send_time       TEXT,
  -- Reminders are OPT-OUT (default 1): the case for them is the one the issue
  -- opens with, and a reminder is only ever sent about something the person
  -- is already travelling on.
  reminders_enabled      INTEGER NOT NULL DEFAULT 1,
  -- How long before an event to fire, in minutes. 60 is the default the issue
  -- mandates. Overridable per booking below.
  reminder_lead_minutes  INTEGER NOT NULL DEFAULT 60,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- One row per BROWSER/DEVICE, not per user: the same account signed in on a
-- phone and a laptop is two independent Web Push endpoints and both should
-- ring.
CREATE TABLE push_subscription (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- The push service URL. UNIQUE so that re-subscribing an existing device --
  -- which browsers do routinely, after a service-worker update or a key
  -- rotation -- updates the row it already has instead of accumulating a
  -- duplicate that would double every notification on that device.
  endpoint         TEXT NOT NULL UNIQUE,
  -- The client's public key and auth secret from the PushSubscription. They
  -- are the encryption inputs for the payload, not credentials of ours, and
  -- are useless without the endpoint they belong to.
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  -- NULL until the first successful send. Together with failure_count it is
  -- how the sweep decides an endpoint is dead: a push service answers 404/410
  -- for a subscription the browser has discarded, and the row must be pruned
  -- rather than retried forever.
  last_success_at  TEXT,
  failure_count    INTEGER NOT NULL DEFAULT 0
);

-- The send path's only lookup: every live endpoint for one user.
CREATE INDEX idx_push_subscription_user ON push_subscription(user_id);

-- EXPLICIT subscription state, layered over the implicit default.
--
-- The implicit default is "you are notified about bookings you are travelling
-- on" (booking_person -> person.user_id), and it needs no rows at all. This
-- table records only the DEVIATIONS: a booking or trip someone asked to
-- follow though they are not on it, and -- just as important -- one they are
-- on and asked to stop hearing about.
CREATE TABLE notification_subscription (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- Exactly one of these is set; the CHECK below enforces it. A trip-scoped
  -- row is stored as ONE row rather than fanned out across that trip's
  -- bookings, so a booking added to the trip tomorrow is covered by today's
  -- decision without anything having to re-run.
  booking_id   TEXT REFERENCES booking(id) ON DELETE CASCADE,
  trip_id      TEXT REFERENCES trip(id) ON DELETE CASCADE,
  -- 1 = subscribe, 0 = EXPLICIT unsubscribe. The zero is the whole reason
  -- this is a flag rather than the mere presence of a row: "I am on this
  -- flight but do not want to be pinged about it" is unrepresentable
  -- otherwise, and an explicit 0 must beat the implicit default.
  subscribed   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK ((booking_id IS NOT NULL) + (trip_id IS NOT NULL) = 1)
);

-- One decision per user per subject. PARTIAL indexes because SQLite treats
-- two NULLs as distinct: a plain UNIQUE(user_id, booking_id) would let a user
-- accumulate unlimited trip-scoped rows (booking_id NULL each time) and never
-- collide, which is precisely the duplicate these indexes exist to prevent.
CREATE UNIQUE INDEX idx_notification_subscription_booking
  ON notification_subscription(user_id, booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX idx_notification_subscription_trip
  ON notification_subscription(user_id, trip_id) WHERE trip_id IS NOT NULL;

-- The per-booking override of the user's global lead time.
--
-- THREE STATES, NOT TWO, and the third is not decoration: 0 is a legitimate
-- lead meaning "notify me at the start", so it cannot double as "off". A
-- two-state design (nullable minutes, NULL = off) would make "at start" and
-- "never" the same stored value and there would be no way back. 'inherit' is
-- the default so that changing the account-level default keeps moving every
-- booking that never had an opinion of its own.
ALTER TABLE booking ADD COLUMN reminder_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (reminder_mode IN ('inherit','custom','off'));
-- Meaningful only when reminder_mode = 'custom'; ignored otherwise, rather
-- than cleared, so toggling to 'off' and back does not lose the number.
ALTER TABLE booking ADD COLUMN reminder_lead_minutes INTEGER;

-- The dedupe ledger. A row is written as a CLAIM, BEFORE the send, and the
-- unique index below is what makes the claim atomic: two overlapping cron
-- runs both try to insert, exactly one succeeds, and the loser stops. Writing
-- the row after a successful send instead would leave the window where a
-- retry, a second worker, or a redeploy sends the same push twice.
CREATE TABLE notification_log (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('reminder','digest')),
  -- The booking id for a reminder; the EMPTY STRING for a digest, which has
  -- no subject row. Deliberately NOT NULL: SQLite considers two NULLs
  -- distinct inside a UNIQUE index, so a nullable column here would let every
  -- digest claim insert successfully and defeat the dedupe entirely. Also
  -- deliberately without a foreign key -- like audit_log, the record of what
  -- was sent has to outlive the row it described.
  subject_id     TEXT NOT NULL,
  -- WHICH OCCURRENCE this claim is for: the booking's `starts_at` for a
  -- reminder, the digest's local calendar date (YYYY-MM-DD) for a digest.
  --
  -- This column is the load-bearing half of the claim key. Keying on the
  -- booking id alone would mean a rescheduled flight is "already notified"
  -- forever: the departure moves four hours later and the reminder silently
  -- never fires again, which is the exact moment a traveller most needs it.
  -- Keying on the instant makes a moved event a NEW claim that correctly
  -- re-arms.
  event_instant  TEXT NOT NULL,
  -- When the claim was taken, and what became of it. sent_at NULL with a
  -- claimed_at set is either in flight or abandoned by a crashed run;
  -- `outcome` records the sender's verdict ('sent', or a short failure
  -- reason) and is NULL until it has one.
  claimed_at     TEXT NOT NULL,
  sent_at        TEXT,
  outcome        TEXT
);

-- The claim itself: the insert that wins this index is the one that sends.
CREATE UNIQUE INDEX idx_notification_log_claim
  ON notification_log(user_id, kind, subject_id, event_instant);
