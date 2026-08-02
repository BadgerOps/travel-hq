import { TenantRepo, NotFoundError, TenantScopeError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { newId } from "../ids.js";
import { isValidTimezone, zonedTimestampToUtc } from "../time.js";
import { localDateOf } from "./itinerary.js";
import { MAX_REMINDER_LEAD_MINUTES, REMINDER_MODES } from "./booking.js";
import type { ReminderMode } from "./booking.js";

/**
 * The tenancy-layer view of the notification tables
 * (migrations/0017_notifications.sql).
 *
 * WHY EVERY WRITE HERE IS `unscoped`: `notification_preference`,
 * `push_subscription`, `notification_subscription` and `notification_log` are
 * keyed by `user_id` and carry no `household_id`, exactly like `trip_member`.
 * A person belongs to households; their phone and their 8am does not. That
 * makes the usual `{scope}` predicate inexpressible, so every statement below
 * goes through unscoped()/runAsSelf() with a reason naming what already
 * proved the caller may do this.
 *
 * WHICH MAKES REACHABILITY THIS FILE'S JOB. The acceptance criterion in #61 is
 * that "a user is never notified about a trip or booking they cannot see", and
 * with no household column there is nothing structural to enforce it. So every
 * write that names a booking or a trip is preceded by a household-SCOPED
 * SELECT of that row — `WHERE {scope} AND id = ?2` — which 404s if the caller's
 * household does not contain it. The unscoped write that follows is safe only
 * because that query ran, and each reason string says so.
 *
 * AND WHY NONE OF THESE WRITES ASK requireWrite(). `requireWrite()` denies the
 * household `viewer` role, because a viewer may not change HOUSEHOLD DATA:
 * trips, bookings, people, cards, settings. Nothing in this file is household
 * data. Every row written here is keyed by `user_id` and describes the caller's
 * own phone, their own 8am, and which events they personally want to hear
 * about — changing it cannot alter one byte another member of the household
 * will ever read.
 *
 * Gating it on the household write role was not a harmless extra safety net,
 * it was WRONG, and wrong precisely for #61's motivating example: a parent
 * following a kid's connection is a shared-trip account, which is a household
 * `viewer` globally (see trip-authorization.ts — a trip VIEWER stays `viewer`
 * even inside their own trip). Under `requireWrite()` that parent could not
 * register their phone, could not set their digest time, and could not follow
 * the one flight the feature exists for. The feature was unusable by exactly
 * the person it was built for.
 *
 * So the writes below go through `runAsSelf()` rather than `unscopedRun()`:
 * same bypass of the {scope} machinery, same mandatory reason string, but no
 * role check — because the role being checked was answering a question about
 * somebody else's data. What replaces it is not "nothing":
 *
 *   - preferences / timezone / push devices are constrained to
 *     `user_id = this.ctx.userId`. The caller's own identity, verified by
 *     Access, IS the authorization; there is no id from the request to abuse.
 *   - subscribing to a booking or a trip additionally keeps the household-
 *     SCOPED reachability SELECT, unchanged. That is the check that matters
 *     here, and it is the one a `viewer` must still face: a viewer may follow
 *     a booking they can see and gets the same 404 as anyone else for one they
 *     cannot.
 */

/** Kept in sync by hand with the CHECK on `user.timezone_source`. */
export const TIMEZONE_SOURCES = ["device", "manual"] as const;
export type TimezoneSource = (typeof TIMEZONE_SOURCES)[number];

/** Kept in sync by hand with the CHECK on `notification_log.kind`. */
export const NOTIFICATION_KINDS = ["reminder", "digest"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Re-exported rather than redeclared: the values belong to a `booking` column
 * and live next to BOOKING_STATUSES in booking.ts, but every consumer of the
 * notification API expects to find them here.
 */
export { REMINDER_MODES, MAX_REMINDER_LEAD_MINUTES };
export type { ReminderMode };

/** The lead time #61 mandates for an account that has never chosen one. */
export const DEFAULT_REMINDER_LEAD_MINUTES = 60;

/**
 * How far ahead of the send window the reminder sweep has to look for
 * candidate bookings. It is exactly the largest lead any booking or account
 * can ask for, so a wider value would only cost work and a narrower one would
 * silently drop the longest-lead reminders.
 */
const REMINDER_CANDIDATE_WINDOW_MINUTES = MAX_REMINDER_LEAD_MINUTES;

/** 'HH:MM', 24-hour, zero-padded — a wall clock, never an instant. */
const SEND_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type NotificationPreferences = {
  /** Opt-in. A daily unprompted push is a bigger ask than a flight reminder. */
  digestEnabled: boolean;
  /** Local wall clock 'HH:MM' in the user's own zone; null = not chosen yet. */
  digestSendTime: string | null;
  /** Opt-out: on unless the account turned it off. */
  remindersEnabled: boolean;
  /** The account-wide default a booking on 'inherit' follows. */
  reminderLeadMinutes: number;
};

/**
 * Tri-state, as UpdateHouseholdSettingsInput established: absent leaves the
 * stored value alone, null clears it, a value sets it. Only
 * `digestSendTime` is nullable — "no digest time" is a real state, whereas
 * "no lead time" is spelled `off` on the booking, not NULL here.
 */
export type UpdateNotificationPreferencesInput = {
  digestEnabled?: boolean;
  digestSendTime?: string | null;
  remindersEnabled?: boolean;
  reminderLeadMinutes?: number;
};

export type UserTimezone = {
  /** An IANA name, never an offset; null = never reported. */
  timezone: string | null;
  source: TimezoneSource | null;
  /** ISO 8601, UTC. How the digest tells a fresh zone from a stale one. */
  updatedAt: string | null;
};

export type SetTimezoneInput = {
  /** null clears the stored zone (and, with it, the pin). */
  timezone: string | null;
  /** 'device' is the client's automatic report; 'manual' is a deliberate pin. */
  source: TimezoneSource;
};

export type PushSubscriptionRecord = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
};

export type RegisterPushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * Everything that decides whether one user hears about one booking, kept
 * separate so the answer can be shown as well as acted on: a UI that only
 * knew the boolean could not explain "you get this because you are on it".
 */
export type BookingSubscriptionState = {
  bookingId: string;
  tripId: string;
  /** Travelling on it: booking_person -> person.user_id. The implicit default. */
  implicit: boolean;
  /** An explicit per-booking decision, or null when none was made. */
  bookingChoice: boolean | null;
  /** An explicit trip-wide decision, or null when none was made. */
  tripChoice: boolean | null;
  /** What the sweep will act on. */
  subscribed: boolean;
};

/**
 * One row of the reminder sweep's answer — deliberately NOT a `Booking`.
 *
 * A push payload is handed to a third-party push service and rendered on a
 * lock screen that anyone holding the phone can read, so it carries titles,
 * places and times and nothing else. There is no confirmation number and no
 * document number in this type, and there must never be one: the columns are
 * simply not selected, so a future edit to the sender cannot reach them.
 */
export type DueReminder = {
  userId: string;
  bookingId: string;
  tripId: string;
  tripTitle: string;
  kind: string;
  title: string;
  location: string | null;
  /** ISO 8601, UTC — the event itself. */
  startsAt: string;
  /** The event's own IANA zone, which need not be the recipient's. */
  startsAtTz: string | null;
  /** The lead that resolved for this pair, in minutes. */
  leadMinutes: number;
  /** ISO 8601, UTC — when this reminder was due, i.e. startsAt minus the lead. */
  sendAt: string;
};

export type DueDigest = {
  userId: string;
  /** The user's stored IANA zone; a digest is impossible without one. */
  timezone: string;
  /** The local calendar date the digest covers, YYYY-MM-DD. */
  localDate: string;
  /** The local wall clock it was scheduled for, 'HH:MM'. */
  sendTime: string;
  /** ISO 8601, UTC — the instant that wall clock resolved to. */
  sendAt: string;
};

/** The four columns of the unique claim index, and nothing else. */
export type NotificationClaim = {
  userId: string;
  kind: NotificationKind;
  /** The booking id for a reminder; the empty string for a digest. */
  subjectId: string;
  /** starts_at for a reminder; the local calendar date for a digest. */
  eventInstant: string;
};

type PreferenceRow = {
  digest_enabled: number;
  digest_send_time: string | null;
  reminders_enabled: number;
  reminder_lead_minutes: number;
};

type TimezoneRow = {
  timezone: string | null;
  timezone_source: string | null;
  timezone_updated_at: string | null;
};

type PushSubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_success_at: string | null;
  failure_count: number;
};

type SubscriptionRow = {
  booking_id: string | null;
  trip_id: string | null;
  subscribed: number;
};

type DueReminderRow = {
  user_id: string;
  booking_id: string;
  trip_id: string;
  trip_title: string;
  kind: string;
  title: string;
  location: string | null;
  starts_at: string;
  starts_at_tz: string | null;
  reminder_mode: string;
  booking_lead_minutes: number | null;
  reminders_enabled: number;
  user_lead_minutes: number;
};

type DigestCandidateRow = {
  user_id: string;
  timezone: string;
  digest_send_time: string;
};

/**
 * What an account with no `notification_preference` row behaves as — the
 * mirror of defaultHouseholdSettings(). Having this means the read path never
 * distinguishes "turned everything off" from "has not visited settings yet",
 * which are wildly different intentions with the same absence of a row.
 */
export function defaultNotificationPreferences(): NotificationPreferences {
  return {
    digestEnabled: false,
    digestSendTime: null,
    remindersEnabled: true,
    reminderLeadMinutes: DEFAULT_REMINDER_LEAD_MINUTES,
  };
}

/**
 * THE reminder decision, as a pure function of plain values.
 *
 * Pure and exported on purpose: this is the rule the cron sweep applies to
 * every candidate pair, and a rule embedded in a repository method can only
 * be tested by standing up a database and a household. Here it can be tested
 * across the whole tri-state in microseconds, which is what keeps the
 * `0`-means-at-start case honest.
 *
 * Returns the lead in minutes, or null for "do not send at all":
 *
 *   reminders off for the account -> null, whatever the booking says
 *   booking mode 'off'            -> null
 *   booking mode 'custom'         -> the booking's minutes
 *   booking mode 'inherit'        -> the account's default
 *
 * `0` is a lead time, not a falsy sentinel. A booking on 'custom' with 0
 * minutes means "tell me when it starts" and MUST NOT be confused with 'off';
 * that confusion is the specific bug the third state exists to prevent.
 */
export function effectiveReminderLeadMinutes(inputs: {
  remindersEnabled: boolean;
  userLeadMinutes: number;
  bookingMode: ReminderMode;
  bookingLeadMinutes: number | null;
}): number | null {
  if (!inputs.remindersEnabled) return null;
  const fallback = normalizeStoredLeadMinutes(inputs.userLeadMinutes);
  // An unrecognised stored mode fails closed to 'inherit' rather than
  // throwing or silently muting: a corrupt row should still get its reminder
  // at the account default, because the alternative is a traveller who is
  // never told and never finds out why.
  const mode = (REMINDER_MODES as readonly string[]).includes(inputs.bookingMode)
    ? inputs.bookingMode
    : "inherit";
  if (mode === "off") return null;
  if (mode === "custom") {
    return inputs.bookingLeadMinutes === null
      ? fallback
      : normalizeStoredLeadMinutes(inputs.bookingLeadMinutes);
  }
  return fallback;
}

/**
 * When a reminder for `startsAt` is due, computed from the stored INSTANT
 * alone. No timezone is involved and none is needed: "an hour before" is an
 * hour before, whether the flight leaves Boise or Bangkok and wherever the
 * recipient happens to be. The zone matters for what the notification SAYS,
 * not for when it fires — conflating the two is how a reminder ends up
 * arriving at the right local time in the wrong local place.
 *
 * Returns null for an unparseable stored instant rather than throwing: one
 * corrupt row must cost one reminder, not the whole sweep.
 */
export function reminderSendAt(startsAt: string, leadMinutes: number): string | null {
  const at = Date.parse(startsAt);
  if (Number.isNaN(at)) return null;
  const lead = normalizeStoredLeadMinutes(leadMinutes);
  return new Date(at - lead * 60_000).toISOString();
}

/**
 * The UTC instant a local wall clock ('08:00') falls on, on a given local
 * calendar date, in a given IANA zone. Returns null when that wall clock does
 * not exist there — 02:30 on a spring-forward morning is a real answer of
 * "never", and skipping that day's digest is better than inventing an instant.
 */
export function digestSendInstant(
  localDate: string,
  sendTime: string,
  timezone: string,
): string | null {
  if (!SEND_TIME_PATTERN.test(sendTime)) return null;
  try {
    return zonedTimestampToUtc(`${localDate}T${sendTime}`, timezone);
  } catch {
    return null;
  }
}

/**
 * Explicit beats implicit, in BOTH directions, and the nearer subject beats
 * the wider one.
 *
 * The two directions matter equally. "Notify me about my partner's flight" is
 * a subscribe on a booking nobody put me on; "stop telling me about the
 * shuttle I am literally riding" is an unsubscribe on a booking I am on. A
 * design where presence of a row means "subscribed" can express the first and
 * not the second.
 *
 * Mirrored by the CASE expression in findDueReminders' SQL, which has to make
 * the same decision for thousands of rows at once. The pair is deliberately
 * pinned by tests on both sides.
 */
export function resolveSubscription(state: {
  implicit: boolean;
  bookingChoice: boolean | null;
  tripChoice: boolean | null;
}): boolean {
  if (state.bookingChoice !== null) return state.bookingChoice;
  if (state.tripChoice !== null) return state.tripChoice;
  return state.implicit;
}

export class NotificationRepo extends TenantRepo {
  /**
   * The same D1 handle TenantRepo was given, kept because `runAsSelf()` needs
   * to reach it and the base class's copy is private. Held here and nowhere
   * else, so the only statements that can skip the role check are the ones in
   * this file.
   */
  private readonly selfDb: D1Database;

  constructor(db: D1Database, ctx: HouseholdContext) {
    super(db, ctx);
    this.selfDb = db;
  }

  // ---------------------------------------------------------------- prefs

  /** The caller's own preferences, or the documented defaults. */
  async getPreferences(): Promise<NotificationPreferences> {
    const row = await this.preferenceRow();
    return row ? toPreferences(row) : defaultNotificationPreferences();
  }

  /**
   * Upserts the caller's single preference row. Absent fields keep their
   * stored value; the first write creates the row from the defaults plus
   * whatever was supplied.
   */
  async updatePreferences(
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferences> {
    const current = await this.getPreferences();

    const digestEnabled =
      input.digestEnabled === undefined ? current.digestEnabled : Boolean(input.digestEnabled);
    const digestSendTime =
      input.digestSendTime === undefined
        ? current.digestSendTime
        : normalizeSendTime(input.digestSendTime);
    const remindersEnabled =
      input.remindersEnabled === undefined
        ? current.remindersEnabled
        : Boolean(input.remindersEnabled);
    const reminderLeadMinutes =
      input.reminderLeadMinutes === undefined
        ? current.reminderLeadMinutes
        : assertLeadMinutes(input.reminderLeadMinutes);

    const now = new Date().toISOString();
    await this.runAsSelf(
      "notification_preference is keyed by user, not household; the row written is the authenticated caller's own, so a viewer may set their own digest time",
      `INSERT INTO notification_preference
         (user_id, digest_enabled, digest_send_time, reminders_enabled,
          reminder_lead_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         digest_enabled = excluded.digest_enabled,
         digest_send_time = excluded.digest_send_time,
         reminders_enabled = excluded.reminders_enabled,
         reminder_lead_minutes = excluded.reminder_lead_minutes,
         updated_at = excluded.updated_at`,
      this.ctx.userId,
      digestEnabled ? 1 : 0,
      digestSendTime,
      remindersEnabled ? 1 : 0,
      reminderLeadMinutes,
      now,
      now,
    );
    return this.getPreferences();
  }

  // ------------------------------------------------------------- timezone

  async getTimezone(): Promise<UserTimezone> {
    const rows = await this.unscoped<TimezoneRow>(
      "user accounts are globally keyed and carry no household_id; the row read is the authenticated caller's own",
      "SELECT timezone, timezone_source, timezone_updated_at FROM user WHERE id = ?",
      this.ctx.userId,
    );
    const row = rows[0];
    if (!row) return { timezone: null, source: null, updatedAt: null };
    return toUserTimezone(row);
  }

  /**
   * Stores the caller's zone, and enforces THE rule the client cannot be
   * trusted with: an automatic 'device' report never overwrites a 'manual'
   * pin.
   *
   * The client posts its device zone on open and again on every
   * `visibilitychange`, so a pin that could be clobbered would survive
   * roughly until the next time the app was backgrounded. Someone who lives
   * in Boise, pinned it, and then opened the app during a layover in
   * Amsterdam would silently start getting their morning digest at 08:00 CET.
   *
   * The rule lives here rather than in the route because the route is not the
   * only caller-shaped thing that will ever set a timezone, and a rule
   * enforced at one entrance is a rule with a side door.
   *
   * Resetting back to automatic is `{ timezone: null, source: 'device' }`:
   * clearing the value clears the pin with it, and the next device report is
   * accepted normally. A 'manual' write always wins — that IS the pin.
   */
  async setTimezone(input: SetTimezoneInput): Promise<UserTimezone> {
    if (!(TIMEZONE_SOURCES as readonly string[]).includes(input.source)) {
      throw new ValidationError(`timezone source must be one of ${TIMEZONE_SOURCES.join(", ")}`);
    }
    const timezone = normalizeTimezone(input.timezone);
    const current = await this.getTimezone();

    // A pinned zone is only displaced by another deliberate act, or by
    // clearing it. Note that a 'device' report is not an error here -- it is
    // simply ignored, because the client sends it unprompted and a 403 for
    // doing what it was built to do would be noise.
    if (input.source === "device" && current.source === "manual" && timezone !== null) {
      return current;
    }

    const now = new Date().toISOString();
    await this.runAsSelf(
      "user accounts are globally keyed and carry no household_id; the row written is the authenticated caller's own, so a viewer may report their own zone",
      "UPDATE user SET timezone = ?, timezone_source = ?, timezone_updated_at = ? WHERE id = ?",
      timezone,
      // Clearing the zone clears its provenance too: a source with no value
      // would claim a pin that no longer pins anything.
      timezone === null ? null : input.source,
      now,
      this.ctx.userId,
    );
    return this.getTimezone();
  }

  // -------------------------------------------------------- push endpoints

  /**
   * Registers (or re-registers) one device. Upserted on `endpoint`, not
   * inserted: browsers hand back the same endpoint with fresh keys after a
   * service-worker update, and inserting would leave the old row behind to
   * double every future notification on that device.
   */
  async registerPushSubscription(
    input: RegisterPushSubscriptionInput,
  ): Promise<PushSubscriptionRecord> {
    const endpoint = requireNonBlank("endpoint", input.endpoint);
    const p256dh = requireNonBlank("p256dh", input.p256dh);
    const auth = requireNonBlank("auth", input.auth);

    await this.runAsSelf(
      "push_subscription is keyed by user, not household; the row written is the authenticated caller's own device, so a viewer may register their own phone",
      `INSERT INTO push_subscription
         (id, user_id, endpoint, p256dh, auth, created_at, last_success_at, failure_count)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         failure_count = 0`,
      newId(),
      this.ctx.userId,
      endpoint,
      p256dh,
      auth,
      new Date().toISOString(),
    );

    const rows = await this.unscoped<PushSubscriptionRow>(
      "push_subscription is keyed by user, not household; re-reads the row just written by this caller",
      "SELECT * FROM push_subscription WHERE endpoint = ?",
      endpoint,
    );
    const row = rows[0];
    if (!row) throw new Error("Push subscription disappeared immediately after registration");
    return toPushSubscription(row);
  }

  async listPushSubscriptions(): Promise<PushSubscriptionRecord[]> {
    const rows = await this.unscoped<PushSubscriptionRow>(
      "push_subscription is keyed by user, not household; only the authenticated caller's own rows are read",
      "SELECT * FROM push_subscription WHERE user_id = ? ORDER BY created_at, id",
      this.ctx.userId,
    );
    return rows.map(toPushSubscription);
  }

  /**
   * Removes one of the caller's own devices. The `user_id` predicate is the
   * whole authorization: there is no household to scope to, so an id alone
   * would let any account delete any endpoint it could guess.
   */
  async deletePushSubscription(id: string): Promise<void> {
    const existing = await this.unscoped<{ id: string }>(
      "push_subscription is keyed by user, not household; the lookup is constrained to the authenticated caller's own rows",
      "SELECT id FROM push_subscription WHERE id = ? AND user_id = ?",
      id,
      this.ctx.userId,
    );
    if (existing.length === 0) throw new NotFoundError("Push subscription not found");
    await this.runAsSelf(
      "push_subscription is keyed by user, not household; ownership was confirmed by the user-constrained query above",
      "DELETE FROM push_subscription WHERE id = ? AND user_id = ?",
      id,
      this.ctx.userId,
    );
  }

  // --------------------------------------------------------- subscriptions

  /** Follow a booking the caller is not travelling on. */
  async subscribeToBooking(bookingId: string): Promise<BookingSubscriptionState> {
    return this.setBookingSubscription(bookingId, true);
  }

  /** Stop hearing about a booking, INCLUDING one the caller is on. */
  async unsubscribeFromBooking(bookingId: string): Promise<BookingSubscriptionState> {
    return this.setBookingSubscription(bookingId, false);
  }

  /** Drop the explicit decision and fall back to the implicit default. */
  async clearBookingSubscription(bookingId: string): Promise<BookingSubscriptionState> {
    await this.requireReachableBooking(bookingId);
    await this.runAsSelf(
      "notification_subscription is keyed by user, not household; the booking was confirmed in-household by the scoped SELECT above and the row is the caller's own",
      "DELETE FROM notification_subscription WHERE user_id = ? AND booking_id = ?",
      this.ctx.userId,
      bookingId,
    );
    return this.getBookingSubscriptionState(bookingId);
  }

  /**
   * Quick-subscribe to a whole trip. Stored as ONE row naming the trip, not
   * fanned out across its bookings: the point of the gesture is "keep me
   * posted about this trip", and a fan-out would silently exclude every
   * booking added after the moment it ran.
   */
  async subscribeToTrip(tripId: string): Promise<void> {
    await this.setTripSubscription(tripId, true);
  }

  async unsubscribeFromTrip(tripId: string): Promise<void> {
    await this.setTripSubscription(tripId, false);
  }

  async clearTripSubscription(tripId: string): Promise<void> {
    await this.requireReachableTrip(tripId);
    await this.runAsSelf(
      "notification_subscription is keyed by user, not household; the trip was confirmed in-household by the scoped SELECT above and the row is the caller's own",
      "DELETE FROM notification_subscription WHERE user_id = ? AND trip_id = ?",
      this.ctx.userId,
      tripId,
    );
  }

  /**
   * The full picture for one booking: whether the caller is on it, what they
   * explicitly said about it and about its trip, and the answer that falls
   * out of resolveSubscription().
   */
  async getBookingSubscriptionState(bookingId: string): Promise<BookingSubscriptionState> {
    const booking = await this.requireReachableBooking(bookingId);

    const implicitRows = await this.unscoped<{ n: number }>(
      "booking_person and person are join/child tables; the booking was confirmed in-household by the scoped SELECT above",
      `SELECT COUNT(*) AS n
         FROM booking_person bp
         JOIN person p ON p.id = bp.person_id
        WHERE bp.booking_id = ? AND p.user_id = ?`,
      bookingId,
      this.ctx.userId,
    );
    const rows = await this.unscoped<SubscriptionRow>(
      "notification_subscription is keyed by user, not household; the booking and its trip were confirmed in-household by the scoped SELECT above",
      `SELECT booking_id, trip_id, subscribed
         FROM notification_subscription
        WHERE user_id = ? AND (booking_id = ? OR trip_id = ?)`,
      this.ctx.userId,
      bookingId,
      booking.trip_id,
    );

    const bookingRow = rows.find((r) => r.booking_id === bookingId);
    const tripRow = rows.find((r) => r.trip_id === booking.trip_id);
    const state = {
      implicit: (implicitRows[0]?.n ?? 0) > 0,
      bookingChoice: bookingRow ? bookingRow.subscribed === 1 : null,
      tripChoice: tripRow ? tripRow.subscribed === 1 : null,
    };
    return {
      bookingId,
      tripId: booking.trip_id,
      ...state,
      subscribed: resolveSubscription(state),
    };
  }

  /**
   * The lead time that would actually be used for the caller and one booking,
   * or null for "no reminder". A thin loader around
   * effectiveReminderLeadMinutes() — the rule itself stays pure.
   */
  async effectiveReminderLeadFor(bookingId: string): Promise<number | null> {
    const booking = await this.requireReachableBooking(bookingId);
    const prefs = await this.getPreferences();
    return effectiveReminderLeadMinutes({
      remindersEnabled: prefs.remindersEnabled,
      userLeadMinutes: prefs.reminderLeadMinutes,
      bookingMode: normalizeStoredMode(booking.reminder_mode),
      bookingLeadMinutes: booking.reminder_lead_minutes,
    });
  }

  // -------------------------------------------------------------- internals

  /**
   * `unscopedRun()` minus the household write-role check, for the per-user
   * rows described in the note at the top of this file. Read that note before
   * adding a call: the ONLY statements that belong here are ones whose every
   * affected row is already pinned to `this.ctx.userId`, or whose subject was
   * proved reachable by a household-scoped SELECT immediately above the call.
   *
   * The reason string is mandatory for the same purpose it is on
   * `unscopedRun()`: every bypass in this codebase is greppable and says out
   * loud what already proved the caller may do this.
   */
  private async runAsSelf(reason: string, sql: string, ...params: unknown[]): Promise<void> {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new TenantScopeError("unscoped access requires a non-empty, human-readable reason");
    }
    await this.selfDb.prepare(sql).bind(...(params as never[])).run();
  }

  private async setBookingSubscription(
    bookingId: string,
    subscribed: boolean,
  ): Promise<BookingSubscriptionState> {
    // THE reachability gate, and — since the role check came out (see the note
    // at the top of this file) — the ONLY gate. Without this scoped SELECT, the
    // unscoped upsert
    // below would happily record a subscription to any booking id the caller
    // could guess, in any household, and the sweep would then dutifully push
    // its title and departure time to them.
    await this.requireReachableBooking(bookingId);
    await this.upsertSubscription("booking_id", bookingId, subscribed);
    return this.getBookingSubscriptionState(bookingId);
  }

  private async setTripSubscription(tripId: string, subscribed: boolean): Promise<void> {
    // Same gate as setBookingSubscription, for the same reason.
    await this.requireReachableTrip(tripId);
    await this.upsertSubscription("trip_id", tripId, subscribed);
  }

  /**
   * The column name is chosen by this file from a two-value literal union,
   * never from caller input, so no request body can reach the statement with
   * an identifier of its own choosing — the TripRepo.update pattern.
   */
  private async upsertSubscription(
    column: "booking_id" | "trip_id",
    subjectId: string,
    subscribed: boolean,
  ): Promise<void> {
    const other = column === "booking_id" ? "trip_id" : "booking_id";
    await this.runAsSelf(
      "notification_subscription is keyed by user, not household; the subject was confirmed in-household by the scoped SELECT above and the row is the caller's own",
      `INSERT INTO notification_subscription (id, user_id, ${column}, ${other}, subscribed, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(user_id, ${column}) WHERE ${column} IS NOT NULL
         DO UPDATE SET subscribed = excluded.subscribed`,
      newId(),
      this.ctx.userId,
      subjectId,
      subscribed ? 1 : 0,
      new Date().toISOString(),
    );
  }

  /**
   * The scoped proof that the caller's household contains this booking. 404s
   * exactly like BookingRepo does, so an out-of-household id is
   * indistinguishable from a nonexistent one.
   */
  private async requireReachableBooking(bookingId: string): Promise<{
    id: string;
    trip_id: string;
    reminder_mode: string;
    reminder_lead_minutes: number | null;
  }> {
    const booking = await this.get<{
      id: string;
      trip_id: string;
      reminder_mode: string;
      reminder_lead_minutes: number | null;
    }>(
      `SELECT id, trip_id, reminder_mode, reminder_lead_minutes
         FROM booking WHERE {scope} AND id = ?2`,
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");
    return booking;
  }

  /** The trip-shaped counterpart of requireReachableBooking. */
  private async requireReachableTrip(tripId: string): Promise<void> {
    const trip = await this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?2",
      tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");
  }

  private async preferenceRow(): Promise<PreferenceRow | undefined> {
    const rows = await this.unscoped<PreferenceRow>(
      "notification_preference is keyed by user, not household; the row read is the authenticated caller's own",
      `SELECT digest_enabled, digest_send_time, reminders_enabled, reminder_lead_minutes
         FROM notification_preference WHERE user_id = ?`,
      this.ctx.userId,
    );
    return rows[0];
  }

  // ------------------------------------------------------------- cron seam
  //
  // Everything below is static and takes a D1Database directly, following
  // InboundEmailRepo.purgeExpiredRawEverywhere: a cron has no household
  // context to bind, and inventing a synthetic one per household would mean
  // first listing every household -- a cross-tenant read by another name.
  // `db.prepare` here is what the architecture test permits under repos/: the
  // tenancy layer is allowed to be the place that knows how to bypass itself.
  //
  // What keeps these safe is that they never take a household, a trip or a
  // booking from a caller. Their inputs are two instants; their outputs are
  // (user, event) pairs that the SQL itself proves the user may see.

  /**
   * Every reminder whose send moment falls in [from, to), already de-duped
   * against claims taken by an earlier run.
   *
   * WHY THE LEAD IS RESOLVED IN TYPESCRIPT and not in SQL: the tri-state rule
   * is `effectiveReminderLeadMinutes` above, the sweep and the HTTP path must
   * apply the same one, and a CASE expression restating it in SQL would be a
   * second implementation to keep in sync. The query instead fetches every
   * candidate whose event starts within the widest lead any account can ask
   * for and lets the pure function decide.
   *
   * WHO IS A CANDIDATE: users implicitly on the booking (booking_person ->
   * person.user_id) plus users with an explicit subscribe on the booking or
   * its trip. The CASE in the WHERE clause then applies the precedence in
   * resolveSubscription() -- booking decision, else trip decision, else
   * implicit -- so an explicit unsubscribe removes someone who is travelling
   * on it, and an explicit subscribe adds someone who is not.
   *
   * AND WHO IS NOT, whatever the subscription rows say: an account that is
   * neither a member of the booking's household nor a member of its trip.
   * Subscriptions were reachability-checked when written, but membership can
   * be revoked afterwards, and #61's criterion is about the moment of
   * sending. This is the re-check.
   */
  static async findDueReminders(db: D1Database, from: Date, to: Date): Promise<DueReminder[]> {
    const windowStart = from.toISOString();
    const windowEnd = new Date(
      to.getTime() + REMINDER_CANDIDATE_WINDOW_MINUTES * 60_000,
    ).toISOString();

    const { results } = await db
      .prepare(
        `SELECT u.id                                    AS user_id,
                b.id                                    AS booking_id,
                b.trip_id                               AS trip_id,
                t.title                                 AS trip_title,
                b.kind                                  AS kind,
                b.title                                 AS title,
                b.location                              AS location,
                b.starts_at                             AS starts_at,
                b.starts_at_tz                          AS starts_at_tz,
                b.reminder_mode                         AS reminder_mode,
                b.reminder_lead_minutes                 AS booking_lead_minutes,
                COALESCE(np.reminders_enabled, 1)       AS reminders_enabled,
                COALESCE(np.reminder_lead_minutes, ?)   AS user_lead_minutes
           FROM booking b
           JOIN trip t ON t.id = b.trip_id
           JOIN user u ON u.id IN (
                  SELECT p.user_id
                    FROM booking_person bp
                    JOIN person p ON p.id = bp.person_id
                   WHERE bp.booking_id = b.id AND p.user_id IS NOT NULL
                  UNION
                  SELECT ns.user_id
                    FROM notification_subscription ns
                   WHERE ns.subscribed = 1
                     AND (ns.booking_id = b.id OR ns.trip_id = b.trip_id)
                )
           LEFT JOIN notification_preference np ON np.user_id = u.id
           LEFT JOIN notification_subscription bsub
                  ON bsub.user_id = u.id AND bsub.booking_id = b.id
           LEFT JOIN notification_subscription tsub
                  ON tsub.user_id = u.id AND tsub.trip_id = b.trip_id
          WHERE b.starts_at IS NOT NULL
            AND b.status != 'cancelled'
            AND b.starts_at >= ?
            AND b.starts_at < ?
            AND COALESCE(np.reminders_enabled, 1) = 1
            AND b.reminder_mode != 'off'
            AND (CASE
                   WHEN bsub.subscribed IS NOT NULL THEN bsub.subscribed
                   WHEN tsub.subscribed IS NOT NULL THEN tsub.subscribed
                   ELSE (SELECT COUNT(*)
                           FROM booking_person bp2
                           JOIN person p2 ON p2.id = bp2.person_id
                          WHERE bp2.booking_id = b.id AND p2.user_id = u.id)
                 END) > 0
            AND (
                  EXISTS (SELECT 1 FROM household_member hm
                           WHERE hm.user_id = u.id AND hm.household_id = b.household_id)
               OR EXISTS (SELECT 1 FROM trip_member tm
                           WHERE tm.user_id = u.id AND tm.trip_id = b.trip_id)
                )
            AND NOT EXISTS (
                  SELECT 1 FROM notification_log nl
                   WHERE nl.user_id = u.id
                     AND nl.kind = 'reminder'
                     AND nl.subject_id = b.id
                     AND nl.event_instant = b.starts_at
                )
          ORDER BY b.starts_at, b.id, u.id`,
      )
      .bind(DEFAULT_REMINDER_LEAD_MINUTES, windowStart, windowEnd)
      .all<DueReminderRow>();

    const due: DueReminder[] = [];
    for (const row of results) {
      const leadMinutes = effectiveReminderLeadMinutes({
        remindersEnabled: row.reminders_enabled === 1,
        userLeadMinutes: row.user_lead_minutes,
        bookingMode: normalizeStoredMode(row.reminder_mode),
        bookingLeadMinutes: row.booking_lead_minutes,
      });
      if (leadMinutes === null) continue;
      const sendAt = reminderSendAt(row.starts_at, leadMinutes);
      if (sendAt === null) continue;
      const at = Date.parse(sendAt);
      if (at < from.getTime() || at >= to.getTime()) continue;
      due.push({
        userId: row.user_id,
        bookingId: row.booking_id,
        tripId: row.trip_id,
        tripTitle: row.trip_title,
        kind: row.kind,
        title: row.title,
        location: row.location,
        startsAt: row.starts_at,
        startsAtTz: row.starts_at_tz,
        leadMinutes,
        sendAt,
      });
    }
    return due;
  }

  /**
   * Every account whose chosen local wall clock falls in [from, to).
   *
   * A wall clock is not an instant, so the comparison cannot be done in SQL:
   * "08:00" is a different moment for each stored zone and a different moment
   * for the same zone either side of a DST change. Both local dates spanned
   * by the window are tried, because a window that straddles midnight
   * somewhere covers two candidate days there.
   *
   * An account with no stored zone is not a candidate at all: there is no
   * defensible guess about when their morning is, and sending at the server's
   * idea of 08:00 would be worse than not sending.
   *
   * Dedupe is left to claim() rather than filtered here: the local date is
   * only known after this computation, so a NOT EXISTS in the query would
   * have nothing to compare against.
   */
  static async findDueDigests(db: D1Database, from: Date, to: Date): Promise<DueDigest[]> {
    const { results } = await db
      .prepare(
        `SELECT u.id AS user_id, u.timezone AS timezone, np.digest_send_time AS digest_send_time
           FROM notification_preference np
           JOIN user u ON u.id = np.user_id
          WHERE np.digest_enabled = 1
            AND np.digest_send_time IS NOT NULL
            AND u.timezone IS NOT NULL
          ORDER BY u.id`,
      )
      .all<DigestCandidateRow>();

    const due: DueDigest[] = [];
    for (const row of results) {
      if (!isValidTimezone(row.timezone)) continue;
      const dates = new Set([
        localDateOf(from.toISOString(), row.timezone),
        localDateOf(to.toISOString(), row.timezone),
      ]);
      for (const localDate of dates) {
        const sendAt = digestSendInstant(localDate, row.digest_send_time, row.timezone);
        if (sendAt === null) continue;
        const at = Date.parse(sendAt);
        if (at < from.getTime() || at >= to.getTime()) continue;
        due.push({
          userId: row.user_id,
          timezone: row.timezone,
          localDate,
          sendTime: row.digest_send_time,
          sendAt,
        });
        break;
      }
    }
    return due;
  }

  /**
   * Takes the claim, BEFORE the send. Returns true if this caller now owns
   * the notification and must send it; false if another run already does.
   *
   * The order is the whole design. Writing the log row after a successful
   * send leaves a window -- a retry, an overlapping cron tick, a redeploy
   * mid-flight -- in which the same push goes out twice, and a duplicate
   * "your flight leaves in an hour" at 4am is worse than a missed one. The
   * unique index idx_notification_log_claim makes the insert itself the lock:
   * two racing runs both attempt it, SQLite lets exactly one through, and the
   * loser's UNIQUE violation is mapped to a plain `false` here rather than
   * escaping as a 500 for a race the caller can do nothing about (the
   * translation is deliberately narrow -- see isClaimConflict).
   */
  static async claim(db: D1Database, claim: NotificationClaim, at?: Date): Promise<boolean> {
    const key = assertClaim(claim);
    try {
      await db
        .prepare(
          `INSERT INTO notification_log
             (id, user_id, kind, subject_id, event_instant, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId(),
          key.userId,
          key.kind,
          key.subjectId,
          key.eventInstant,
          (at ?? new Date()).toISOString(),
        )
        .run();
      return true;
    } catch (err) {
      if (isClaimConflict(err)) return false;
      throw err;
    }
  }

  /** Records that the claimed notification was delivered. */
  static async markSent(db: D1Database, claim: NotificationClaim, at?: Date): Promise<void> {
    await NotificationRepo.closeClaim(db, claim, (at ?? new Date()).toISOString(), "sent");
  }

  /**
   * Records that the claimed notification failed. `sent_at` stays NULL --
   * the row remains the proof that this occurrence was attempted, so a retry
   * loop cannot turn one failure into an endless series of pushes, while
   * `outcome` preserves why for whoever looks.
   */
  static async markFailed(db: D1Database, claim: NotificationClaim, outcome: string): Promise<void> {
    const reason = typeof outcome === "string" && outcome.trim() !== "" ? outcome.trim() : "failed";
    await NotificationRepo.closeClaim(db, claim, null, reason);
  }

  /** Every live endpoint for one user — what the sender pushes to. */
  static async listPushSubscriptionsForUser(
    db: D1Database,
    userId: string,
  ): Promise<PushSubscriptionRecord[]> {
    const { results } = await db
      .prepare("SELECT * FROM push_subscription WHERE user_id = ? ORDER BY created_at, id")
      .bind(userId)
      .all<PushSubscriptionRow>();
    return results.map(toPushSubscription);
  }

  /**
   * Deletes an endpoint the push service has declared gone (404/410). Keyed
   * by the endpoint alone and by nothing else, because that is all a rejected
   * delivery gives back — and it is enough: the endpoint IS the identifier
   * the push service issued, so there is no other row it could match.
   * Returns whether a row was actually removed.
   */
  static async pruneEndpoint(db: D1Database, endpoint: string): Promise<boolean> {
    const result = await db
      .prepare("DELETE FROM push_subscription WHERE endpoint = ?")
      .bind(endpoint)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Clears the failure streak and stamps the last good delivery. */
  static async recordPushSuccess(db: D1Database, endpoint: string, at?: Date): Promise<void> {
    await db
      .prepare(
        "UPDATE push_subscription SET last_success_at = ?, failure_count = 0 WHERE endpoint = ?",
      )
      .bind((at ?? new Date()).toISOString(), endpoint)
      .run();
  }

  /**
   * Counts one failed delivery. A transient 5xx from a push service is not
   * evidence the subscription is dead, so this increments rather than
   * prunes; pruneEndpoint is for the 404/410 answer that IS such evidence.
   */
  static async recordPushFailure(db: D1Database, endpoint: string): Promise<void> {
    await db
      .prepare(
        "UPDATE push_subscription SET failure_count = failure_count + 1 WHERE endpoint = ?",
      )
      .bind(endpoint)
      .run();
  }

  private static async closeClaim(
    db: D1Database,
    claim: NotificationClaim,
    sentAt: string | null,
    outcome: string,
  ): Promise<void> {
    const key = assertClaim(claim);
    await db
      .prepare(
        `UPDATE notification_log
            SET sent_at = ?, outcome = ?
          WHERE user_id = ? AND kind = ? AND subject_id = ? AND event_instant = ?`,
      )
      .bind(sentAt, outcome, key.userId, key.kind, key.subjectId, key.eventInstant)
      .run();
  }
}

function toPreferences(r: PreferenceRow): NotificationPreferences {
  return {
    digestEnabled: r.digest_enabled === 1,
    // A stored send time that is not a wall clock reads as "not chosen": a
    // digest that cannot be scheduled must not be scheduled at a guess.
    digestSendTime:
      r.digest_send_time !== null && SEND_TIME_PATTERN.test(r.digest_send_time)
        ? r.digest_send_time
        : null,
    remindersEnabled: r.reminders_enabled === 1,
    reminderLeadMinutes: normalizeStoredLeadMinutes(r.reminder_lead_minutes),
  };
}

function toUserTimezone(r: TimezoneRow): UserTimezone {
  // An unrecognised stored zone reads as no zone at all. Handing a bad IANA
  // name to Intl throws, and one hand-edited row must not be able to take
  // down the digest sweep for everybody.
  const timezone =
    r.timezone !== null && isValidTimezone(r.timezone) ? r.timezone : null;
  return {
    timezone,
    source:
      timezone !== null && (TIMEZONE_SOURCES as readonly string[]).includes(r.timezone_source ?? "")
        ? (r.timezone_source as TimezoneSource)
        : null,
    updatedAt: timezone !== null ? r.timezone_updated_at : null,
  };
}

function toPushSubscription(r: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    createdAt: r.created_at,
    lastSuccessAt: r.last_success_at,
    failureCount: r.failure_count,
  };
}

function normalizeStoredMode(mode: string): ReminderMode {
  return (REMINDER_MODES as readonly string[]).includes(mode) ? (mode as ReminderMode) : "inherit";
}

/** A stored lead that is not a whole number of minutes in range reads as 60. */
function normalizeStoredLeadMinutes(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_LEAD_MINUTES
    ? value
    : DEFAULT_REMINDER_LEAD_MINUTES;
}

function assertLeadMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_REMINDER_LEAD_MINUTES) {
    throw new ValidationError(
      `reminderLeadMinutes must be a whole number of minutes from 0 to ${MAX_REMINDER_LEAD_MINUTES}`,
    );
  }
  return value;
}

function normalizeSendTime(value: string | null): string | null {
  if (value === null) return null;
  const time = value.trim();
  if (!SEND_TIME_PATTERN.test(time)) {
    throw new ValidationError("digestSendTime must be a local wall clock as HH:MM");
  }
  return time;
}

function normalizeTimezone(value: string | null): string | null {
  if (value === null) return null;
  const zone = value.trim();
  if (zone === "") return null;
  // An IANA name, never a fixed offset. "-08:00" is only true until the next
  // DST transition, and Intl rejects it here rather than letting it become a
  // permanently-wrong digest time.
  if (!isValidTimezone(zone) || zone.match(/^[+-]\d{2}:?\d{2}$/) !== null) {
    throw new ValidationError("timezone must be an IANA zone name such as America/Los_Angeles");
  }
  return zone;
}

function requireNonBlank(field: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertClaim(claim: NotificationClaim): NotificationClaim {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(claim.kind)) {
    throw new ValidationError(`kind must be one of ${NOTIFICATION_KINDS.join(", ")}`);
  }
  if (typeof claim.userId !== "string" || claim.userId.trim() === "") {
    throw new ValidationError("a claim requires a user id");
  }
  // subjectId is deliberately allowed to be "" -- that IS a digest's subject,
  // and the column is NOT NULL precisely so the unique index can see it.
  if (typeof claim.subjectId !== "string") {
    throw new ValidationError("a claim requires a subject id");
  }
  if (typeof claim.eventInstant !== "string" || claim.eventInstant.trim() === "") {
    throw new ValidationError("a claim requires the event instant it is keyed on");
  }
  return claim;
}

/**
 * True only for SQLite's UNIQUE violation on notification_log — the claim
 * index. Matched on the message because that is all D1 gives us: it wraps the
 * SQLite error as `D1_ERROR: UNIQUE constraint failed: notification_log.user_id,
 * ...` with no structured code, and workerd may nest the original under
 * `cause`. Naming the table keeps the match narrow, so a UNIQUE violation
 * anywhere else stays the unexpected error it is rather than being laundered
 * into "somebody else already sent it".
 *
 * Same shape as isForwardAddressConflict in household-settings.ts.
 */
const CLAIM_UNIQUE_RE = /UNIQUE constraint failed:\s*notification_log\./i;

function isClaimConflict(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor !== null && cursor !== undefined && depth < 5; depth++) {
    if (cursor instanceof Error) {
      if (CLAIM_UNIQUE_RE.test(cursor.message)) return true;
      cursor = cursor.cause;
      continue;
    }
    return typeof cursor === "string" && CLAIM_UNIQUE_RE.test(cursor);
  }
  return false;
}
