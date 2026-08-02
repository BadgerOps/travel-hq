/**
 * The words and links a notification is made of. Issue #61.
 *
 * Everything here is pure and takes plain values, for the same reason
 * `effectiveReminderLeadMinutes` is pure: the phrasing of a lock-screen line
 * is worth pinning exhaustively, and none of it needs a database to be right.
 *
 * ── THE ZONE RULE ─────────────────────────────────────────────────────────
 * Times are rendered in the EVENT's own zone (`booking.starts_at_tz`), with
 * the offset spelled out, never in the reader's. "Departs 10:15 AM GMT+9" is
 * the sentence a traveller can act on; the same moment rendered as "6:15 PM"
 * because that is what the clock says at home is a sentence that reads
 * perfectly and means the wrong thing. This is the exact counterpart of the
 * rule on `reminderSendAt`: the zone decides what a notification SAYS and
 * never when it fires.
 */

import { localDateOf } from "../repos/itinerary.js";

/**
 * Where a tap lands for a specific day of a trip.
 *
 * `#days:YYYY-MM-DD` is the hash format issue #60 shipped (see `parseHash` in
 * src/client/pages/TripDetail.tsx) — colon, not slash, because a hash may
 * legally hold only one `#` and the colon keeps `#days` a plain prefix of
 * `#days:<date>`. Built here rather than spelled inline at the two call sites
 * so there is one place to change if that format ever moves.
 */
export function dayPath(tripId: string, localDate: string): string {
  return `/trips/${tripId}#days:${localDate}`;
}

/**
 * The calendar day an event belongs to, in its own zone (see `localDateOf`),
 * or null for a row whose stored instant will not parse.
 *
 * Null rather than a throw, and rather than a guessed date: this is called
 * while building a payload for a claim that has already been taken, so
 * throwing here would cost the notification AND leave the ledger row saying
 * an internal error rather than anything a reader could act on. A reminder
 * with no deep link still tells someone their flight is in an hour.
 */
export function eventLocalDate(startsAt: string, startsAtTz: string | null): string | null {
  if (Number.isNaN(Date.parse(startsAt))) return null;
  try {
    return localDateOf(startsAt, safeZone(startsAtTz));
  } catch {
    return null;
  }
}

/**
 * The local hour (0–23) an event starts at, in its own zone. Used for exactly
 * one decision — "is this early enough that last night's digest should have
 * warned about it?" — and returns null when the row cannot be read, so that
 * decision fails towards "treat it as an ordinary event" rather than throwing.
 */
export function eventLocalHour(startsAt: string, startsAtTz: string | null): number | null {
  try {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: safeZone(startsAtTz),
      hour: "2-digit",
      hour12: false,
    }).format(new Date(startsAt));
    const parsed = Number(hour);
    return Number.isFinite(parsed) ? parsed % 24 : null;
  } catch {
    return null;
  }
}

/**
 * "6:40 AM" in the event's own zone.
 *
 * The space before AM is normalized to a plain one. Current ICU emits U+202F
 * (narrow no-break space) there, which is invisible in a diff, counts as a
 * different string to every assertion, and renders as a tofu box on some
 * notification surfaces. One `replace` is cheaper than discovering that on a
 * lock screen.
 */
export function formatClock(startsAt: string, startsAtTz: string | null): string {
  try {
    return normalizeSpaces(
      new Intl.DateTimeFormat("en-US", {
        timeZone: safeZone(startsAtTz),
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(startsAt)),
    );
  } catch {
    return "";
  }
}

/**
 * "6:40 AM GMT+9". The offset is appended only when the event carries a zone
 * of its own: a row with no `starts_at_tz` is rendered in UTC, and labelling
 * that "GMT" would dress a missing value up as a deliberate one.
 */
export function formatEventTime(startsAt: string, startsAtTz: string | null): string {
  const clock = formatClock(startsAt, startsAtTz);
  if (clock === "") return "";
  if (startsAtTz === null) return clock;
  const zone = formatZoneLabel(startsAt, startsAtTz);
  return zone === "" ? clock : `${clock} ${zone}`;
}

/** "GMT+9" — the short offset, which is what a traveller recognises. */
export function formatZoneLabel(startsAt: string, startsAtTz: string | null): string {
  if (startsAtTz === null) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: startsAtTz,
      hour: "numeric",
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(startsAt));
    return normalizeSpaces(parts.find((part) => part.type === "timeZoneName")?.value ?? "");
  } catch {
    return "";
  }
}

/** See formatClock: ICU's non-breaking spaces are not worth shipping. */
function normalizeSpaces(value: string): string {
  return value.replace(/[\u00a0\u202f\u2009]/g, " ");
}

/**
 * How far out the reminder is, as a phrase: "In 1 hour", "In 45 minutes",
 * "In 1 day 2 hours". Zero is "Starting now" rather than "In 0 minutes",
 * because 0 is a legitimate lead meaning "tell me when it starts" (see the
 * tri-state on `booking.reminder_mode`) and must not read like a bug.
 */
export function formatLead(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Starting now";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = Math.round(minutes % 60);
  const parts: string[] = [];
  if (days > 0) parts.push(plural(days, "day"));
  if (hours > 0) parts.push(plural(hours, "hour"));
  // Minutes are dropped once the lead is measured in days: "In 2 days
  // 15 minutes" is precision nobody asked for.
  if (mins > 0 && days === 0) parts.push(plural(mins, "minute"));
  return `In ${parts.join(" ") || plural(minutes, "minute")}`;
}

/**
 * The verb that fits the booking kind. Deliberately a small map with a
 * generic default rather than an exhaustive union: `booking.kind` is a string
 * column that gains values over time, and a new kind should read slightly
 * blandly, not crash the sweep or say "Departs" about a dinner reservation.
 */
export function verbForKind(kind: string): string {
  switch (kind) {
    case "flight":
    case "train":
    case "ferry":
    case "bus":
      return "Departs";
    case "lodging":
      return "Check-in";
    case "car":
      return "Pick-up";
    case "activity":
    case "restaurant":
      return "Starts";
    default:
      return "Starts";
  }
}

/**
 * Trims a string to fit a payload field's budget, on a word boundary where it
 * can. Used so a long trip title costs a truncated line rather than a
 * `PushError` that loses the whole notification — `buildNotificationJson`
 * enforces the limits, and the sweep would rather bend than break.
 */
export function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const hard = value.slice(0, Math.max(1, maxLength - 1));
  const space = hard.lastIndexOf(" ");
  const kept = space > maxLength / 2 ? hard.slice(0, space) : hard;
  return `${kept.trimEnd()}…`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * A booking written directly into D1 by hand can carry a zone `Intl` does not
 * recognise; every write path through the API rejects one (see
 * `assertTimezonePaired`). UTC is the same fallback `ItineraryRepo` uses for a
 * row with no zone at all, so the day view and the digest agree about which
 * day such a row belongs to.
 */
function safeZone(zone: string | null): string {
  if (zone === null) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
