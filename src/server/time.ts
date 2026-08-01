/**
 * The single definition of "a valid timestamp" and "a valid IANA timezone"
 * for this codebase. Previously copy-pasted in three places --
 * `routes/trips.ts` (the HTTP boundary), `repos/booking.ts`
 * (`assertTimezonePaired`, the repo-level belt-and-braces check), and
 * `ingest/extracted.ts` (every extractor's shared funnel) -- which is exactly
 * the kind of duplication that lets three copies quietly drift apart.
 *
 * That would matter more than usual here: the day-view skip-asymmetry
 * documented on `BookingRepo.listByTrip` and `ItineraryRepo.group()` (see
 * also docs/BACKLOG.md) depends on all three call sites agreeing about what
 * counts as valid. If one copy started accepting a string the others reject,
 * a row could pass the write-time check under one definition and still brick
 * `ItineraryRepo.group()`'s `localDateOf()` under another.
 *
 * `Intl.supportedValuesOf("timeZone")` would be the more direct check for
 * `isValidTimezone` but isn't universally available across runtimes;
 * constructing an `Intl.DateTimeFormat` with the candidate zone and catching
 * the throw is the portable equivalent.
 */
/**
 * The exact shape of an instant: a full ISO-8601 date-time with minute (or
 * finer) precision and an explicit UTC designator or numeric offset.
 *
 * Every part is anchored and counted because the previous spelling of this
 * check -- "ends with Z or ±HH:MM, and Date.parse doesn't return NaN" -- let
 * three whole families of garbage through:
 *
 *   "2026-02-30T00:00:00Z"       an impossible date; Date.parse silently
 *                                rolls it forward to March 2nd, so the row
 *                                stored is not the row the caller sent
 *   "2026-01-05Z"                a date with no time at all; the day it means
 *                                depends on which end of the day you assume
 *   "Jan 5 2026 10:00 GMT+05:00" the legacy, implementation-defined parser,
 *                                which no two runtimes agree about
 *
 * The seconds component stays optional because "…T10:00Z" is a legal instant
 * that airline confirmations really do state, but the offset never is -- see
 * the comment below for why a wall clock cannot be stored as an instant.
 */
const INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

/**
 * Is this string an unambiguous instant -- one moment in time that every
 * runtime reads identically?
 *
 * `isValidTimestamp` is the historical name for this check and is exported as
 * an alias below rather than as a second implementation: the whole point of
 * this module is that there is ONE definition of a valid timestamp, so the two
 * names can never drift apart the way the three copied call sites did.
 */
export function isValidInstant(value: string): boolean {
  // `.match()` rather than the pattern's own matcher, matching
  // `isValidCalendarDate` below -- and required: the architecture test bans
  // the `.exec(` spelling everywhere outside the repository layer, because it
  // cannot tell a regular expression's from a database handle's.
  const match = value.match(INSTANT_PATTERN);
  if (!match) return false;
  const [, date, hour, minute, second, offsetSign, offsetHour, offsetMinute] = match;

  // A timestamp without an offset is a wall clock, not an instant. Accepting
  // it makes `new Date(value)` depend on the runtime's own timezone, which is
  // how two equivalent KOA imports rendered six hours apart in production.
  // The pattern above has already rejected that case; what is left is to
  // reject the field values ISO-8601 spells legally but the calendar does not
  // contain -- February 30th, hour 25, the leap second at :60 -- because
  // Date.parse accepts some of them by normalizing them into a different
  // moment rather than by failing.
  if (!isValidCalendarDate(date!)) return false;
  if (Number(hour) > 23 || Number(minute) > 59) return false;
  if (second !== undefined && Number(second) > 59) return false;
  if (offsetSign !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) {
    return false;
  }

  // Belt and braces: everything above is a structural check, and this is the
  // runtime confirming it can turn the string into a number of milliseconds.
  return !Number.isNaN(Date.parse(value));
}

/**
 * The name the rest of the codebase already imports (routes/trips.ts,
 * routes/bookings.ts, repos/booking.ts, repos/draft-booking.ts,
 * ingest/extracted.ts). Deliberately an alias and not a wrapper with its own
 * body -- there is exactly one implementation to keep honest.
 */
export const isValidTimestamp = isValidInstant;

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Converts an extracted local wall-clock timestamp to a canonical UTC
 * instant using the booking's IANA timezone. Email confirmations usually
 * state "check in at 1:00 PM" rather than a UTC instant; asking a model to do
 * timezone arithmetic proved less reliable than doing it deterministically.
 */
export function zonedTimestampToUtc(localDateTime: string, timeZone: string): string {
  if (!isValidTimezone(timeZone)) {
    throw new RangeError(`${timeZone} is not a recognised IANA timezone`);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(
      localDateTime,
    )
  ) {
    throw new RangeError(`${localDateTime} is not a local ISO date-time`);
  }

  const completed =
    localDateTime.length === 16 ? `${localDateTime}:00.000` : localDateTime;
  const naive = Date.parse(`${completed}Z`);
  if (Number.isNaN(naive)) {
    throw new RangeError(`${localDateTime} is not a parseable local date-time`);
  }

  let instant = naive - offsetAt(naive, timeZone);
  instant = naive - offsetAt(instant, timeZone);
  const normalized = new Date(instant).toISOString();
  const expected = completed
    .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)!
    .slice(1)
    .join("-");

  // Date.parse normalizes impossible dates such as February 30. Round-trip
  // the result through the requested zone so impossible/nonexistent local
  // wall times are rejected instead of silently moved.
  if (localDateTimeParts(normalized, timeZone) !== expected) {
    throw new RangeError(`${localDateTime} does not exist in ${timeZone}`);
  }
  return normalized;
}

function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  ) - instant;
}

function localDateTimeParts(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return [
    value("year"),
    value("month"),
    value("day"),
    String(Number(value("hour")) % 24).padStart(2, "0"),
    value("minute"),
    value("second"),
  ].join("-");
}

/**
 * Exact calendar-date validation: a date the calendar actually contains,
 * written the one way SQLite's date functions and every `ORDER BY starts_on`
 * in this codebase can compare lexicographically.
 *
 * "Exact" is the load-bearing word. `new Date("2026-02-31")` is not an error
 * in JavaScript, it is March 3rd -- so a trip stored from that string ends up
 * with dates nobody typed. The round-trip through `Date.UTC` below is what
 * catches the rollover.
 *
 * Shared by trips, checklist due dates, person DOB/passport expiry, and import
 * review, via the assertion wrappers in `repos/validation.ts`.
 */
export function isValidCalendarDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}
