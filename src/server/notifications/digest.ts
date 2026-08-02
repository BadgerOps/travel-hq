/**
 * One notification per person per local day: what today holds. Issue #61.
 *
 * ── THERE IS NO QUIET-HOURS SUPPRESSION IN THIS FEATURE ───────────────────
 * Not here, not in the sweep, not anywhere. A 05:00 reminder before an 06:00
 * flight is the single most valuable notification this app can send, and a
 * "don't disturb before 07:00" rule would swallow exactly that one. Quiet
 * hours is a bug with a friendly name.
 *
 * What this file does instead is ADDITIVE, and it is the other half of the
 * same problem. An event that starts before {@link EARLY_EVENT_HOUR} local is
 * one you have to get up for, and the morning digest that would mention it
 * arrives after you needed to be awake. So such an event ALSO appears in the
 * PREVIOUS day's digest, as a heads-up. Nothing is moved and nothing is
 * removed — the early event still appears in its own day's digest, and its
 * own reminder still fires at `starts_at − lead`. Three chances to be told,
 * zero chances to be silenced.
 *
 * ── WHICH DAY, AND IN WHOSE ZONE ──────────────────────────────────────────
 * Events are grouped by `localDateOf(starts_at, starts_at_tz)` — the one
 * definition of "which calendar day does this belong to" in the codebase,
 * exported from repos/itinerary.ts for exactly this caller. A red-eye leaving
 * Boise at 23:40 belongs to Thursday even though it is Friday in UTC, and the
 * digest and the day view must not disagree about that.
 *
 * The USER's zone is a separate question, answered by
 * {@link chooseDigestTimezone}: it decides which local date "today" is. The
 * stored `user.timezone` answers it while it is fresh; `timezone_updated_at`
 * exists so a value last confirmed months ago can be recognised as the worse
 * guess it is, and stood down in favour of the zone of that day's first
 * event. Mid-trip that fallback is simply the better answer regardless of
 * staleness — the person is where their flights are.
 */

import { localDateOf } from "../repos/itinerary.js";
import type { NotificationPayload } from "../push/index.js";
import { clip, dayPath, eventLocalDate, eventLocalHour, formatClock } from "./format.js";

/** Payload field budgets, mirrored from push/payload.ts so `clip` can fit them. */
const MAX_TITLE = 100;
const MAX_BODY = 200;

/**
 * Before this local hour, an event is "early" and earns a mention in the
 * previous day's digest as well as its own. Seven is the hour by which a
 * digest sent at a normal breakfast time is already too late to help.
 */
export const EARLY_EVENT_HOUR = 7;

/**
 * How recently `user.timezone` must have been confirmed to be preferred over
 * the zone of the day's first event. A week: long enough that someone at home
 * who has not opened the app since Sunday still gets their own zone, short
 * enough that a zone set before a trip began stops speaking for them once the
 * trip has its own opinion.
 */
export const TIMEZONE_FRESHNESS_DAYS = 7;

/**
 * One thing on the day. The same field set `DueReminder` carries, and for the
 * same reason: there is nowhere in it to put a confirmation number.
 */
export type DigestEntry = {
  bookingId: string;
  tripId: string;
  tripTitle: string;
  kind: string;
  title: string;
  location: string | null;
  startsAt: string;
  startsAtTz: string | null;
};

/** A checklist item the digest mentions: label and due date, nothing else. */
export type DigestChecklistItem = {
  id: string;
  tripId: string;
  label: string;
  dueOn: string;
};

export type DigestTimezoneSource = "stored" | "first-event";

export type DigestTimezoneChoice = {
  timezone: string;
  source: DigestTimezoneSource;
};

/**
 * Which zone the digest should call "here", and why.
 *
 * Total: an unusable stored zone, an unparseable `timezoneUpdatedAt` and a
 * missing event zone all resolve to something renderable rather than
 * throwing, because the failure of this function must never be the reason a
 * traveller is not told about their morning.
 */
export function chooseDigestTimezone(input: {
  storedTimezone: string | null;
  timezoneUpdatedAt: string | null;
  now: Date;
  firstEventTimezone: string | null;
  freshnessDays?: number;
}): DigestTimezoneChoice {
  const stored = isUsableZone(input.storedTimezone) ? input.storedTimezone : null;
  const firstEvent = isUsableZone(input.firstEventTimezone) ? input.firstEventTimezone : null;
  if (stored === null) {
    // Nothing stored (or nothing usable): the day's first event is the only
    // evidence there is about where this person is.
    return firstEvent === null
      ? { timezone: "UTC", source: "stored" }
      : { timezone: firstEvent, source: "first-event" };
  }
  if (firstEvent === null || firstEvent === stored) {
    return { timezone: stored, source: "stored" };
  }

  const days = input.freshnessDays ?? TIMEZONE_FRESHNESS_DAYS;
  const confirmedAt = input.timezoneUpdatedAt === null ? NaN : Date.parse(input.timezoneUpdatedAt);
  const fresh =
    !Number.isNaN(confirmedAt) && input.now.getTime() - confirmedAt <= days * 86_400_000;
  return fresh ? { timezone: stored, source: "stored" } : { timezone: firstEvent, source: "first-event" };
}

/**
 * The zone of the earliest event in the set — the fallback donor above.
 * Earliest by INSTANT, which needs no zone to decide and so cannot itself
 * depend on the answer it is being asked for.
 */
export function firstEventTimezone(entries: readonly DigestEntry[]): string | null {
  let best: DigestEntry | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const at = Date.parse(entry.startsAt);
    if (Number.isNaN(at)) continue;
    if (at < bestAt) {
      bestAt = at;
      best = entry;
    }
  }
  return best?.startsAtTz ?? null;
}

export type DigestSplit = {
  /** Everything whose own local date is the digest's date. */
  today: DigestEntry[];
  /** Tomorrow's before-dawn events, mentioned tonight as well as tomorrow. */
  earlyTomorrow: DigestEntry[];
};

/**
 * Sort one day's candidates into "today" and "the early start you need to
 * know about now". Both lists come back ordered by instant.
 */
export function splitDigestEntries(
  entries: readonly DigestEntry[],
  localDate: string,
  earlyHour: number = EARLY_EVENT_HOUR,
): DigestSplit {
  const tomorrow = nextDate(localDate);
  const today: DigestEntry[] = [];
  const earlyTomorrow: DigestEntry[] = [];

  for (const entry of entries) {
    if (Number.isNaN(Date.parse(entry.startsAt))) continue;
    const date = eventLocalDate(entry.startsAt, entry.startsAtTz);
    if (date === localDate) {
      today.push(entry);
      continue;
    }
    if (date !== tomorrow) continue;
    const hour = eventLocalHour(entry.startsAt, entry.startsAtTz);
    if (hour !== null && hour < earlyHour) earlyTomorrow.push(entry);
  }

  today.sort(byInstant);
  earlyTomorrow.sort(byInstant);
  return { today, earlyTomorrow };
}

export type ComposedDigest = {
  payload: NotificationPayload;
  /** What went in, for the sweep's log line and for tests to assert on. */
  todayCount: number;
  earlyCount: number;
  checklistCount: number;
};

/**
 * Turn a day into one notification, or into `null` when there is nothing to
 * say. Null is not a failure: an empty day should produce silence, not a push
 * that says "nothing today". A digest whose only content is noise is how
 * people turn digests off.
 */
export function composeDigest(input: {
  localDate: string;
  entries: readonly DigestEntry[];
  checklist: readonly DigestChecklistItem[];
  /** The instant the digest is for; becomes the payload's timestamp. */
  sendAt: string;
  earlyHour?: number;
}): ComposedDigest | null {
  const { today, earlyTomorrow } = splitDigestEntries(input.entries, input.localDate, input.earlyHour);
  const checklist = input.checklist.filter((item) => item.label.trim() !== "");
  if (today.length === 0 && earlyTomorrow.length === 0 && checklist.length === 0) return null;

  const lines: string[] = [];
  for (const entry of today) {
    const clock = formatClock(entry.startsAt, entry.startsAtTz);
    lines.push(clock === "" ? entry.title : `${clock} ${entry.title}`);
  }
  if (checklist.length > 0) lines.push(`${plural(checklist.length, "task")} due`);
  for (const entry of earlyTomorrow) {
    const clock = formatClock(entry.startsAt, entry.startsAtTz);
    // Named as tomorrow's, every time. An early flight listed among today's
    // rows without that word is the one sentence in the whole feature that
    // could make someone miss it.
    lines.push(`Tomorrow ${clock === "" ? entry.title : `${clock} ${entry.title}`}`);
  }

  const anchor = today[0] ?? earlyTomorrow[0] ?? null;
  const anchorDay = anchor === null ? null : eventLocalDate(anchor.startsAt, anchor.startsAtTz);
  const path =
    anchor !== null && anchorDay !== null
      ? dayPath(anchor.tripId, anchorDay)
      : anchor !== null
        ? `/trips/${anchor.tripId}`
        : checklist.length > 0
          ? `/trips/${checklist[0]!.tripId}`
          : "/";

  return {
    payload: {
      title: clip(digestTitle(today, earlyTomorrow, checklist), MAX_TITLE),
      body: clip(lines.join(" · "), MAX_BODY),
      tag: digestTag(input.localDate),
      path,
      timestamp: input.sendAt,
    },
    todayCount: today.length,
    earlyCount: earlyTomorrow.length,
    checklistCount: checklist.length,
  };
}

/** One digest per local day replaces the last, rather than stacking. */
export function digestTag(localDate: string): string {
  return `d:${localDate}`;
}

/**
 * The local date a digest due at `sendAt` is about, once the zone question
 * has been settled. Separate from `NotificationRepo.findDueDigests`, which
 * had to use the stored zone to decide WHEN to fire — by the time the content
 * is assembled there is more evidence available.
 */
export function digestLocalDate(sendAt: string, timezone: string): string {
  try {
    return localDateOf(sendAt, timezone);
  } catch {
    return localDateOf(sendAt, "UTC");
  }
}

function digestTitle(
  today: readonly DigestEntry[],
  early: readonly DigestEntry[],
  checklist: readonly DigestChecklistItem[],
): string {
  if (today.length === 0 && early.length > 0) return "Early start tomorrow";
  if (today.length === 0) return `${plural(checklist.length, "task")} due today`;
  if (today.length === 1) return `Today: ${today[0]!.title}`;
  return `Today: ${plural(today.length, "plan")}`;
}

function byInstant(a: DigestEntry, b: DigestEntry): number {
  return Date.parse(a.startsAt) - Date.parse(b.startsAt);
}

/**
 * The next calendar date. Noon UTC as the cursor for the same reason
 * `itineraryDates` uses it: adding a day to a midnight cursor can land back
 * on the same date once a zone gets involved, and noon has twelve hours of
 * slack in both directions.
 */
export function nextDate(localDate: string): string {
  const cursor = new Date(`${localDate}T12:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return localDate;
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  return cursor.toISOString().slice(0, 10);
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function isUsableZone(zone: string | null): zone is string {
  if (zone === null || zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
