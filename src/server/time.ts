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
export function isValidTimestamp(value: string): boolean {
  // A timestamp without an offset is a wall clock, not an instant. Accepting
  // it makes `new Date(value)` depend on the runtime's own timezone, which is
  // how two equivalent KOA imports rendered six hours apart in production.
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value));
}

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

/** Exact calendar-date validation shared by trips and import review. */
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
