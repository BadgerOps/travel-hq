const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `today` to `isoDate`, both plain YYYY-MM-DD calendar dates.
 * Parsed as UTC midnight deliberately: these are calendar dates with no time or
 * zone, and parsing them as local time makes the count off by one either side
 * of midnight depending on the viewer's offset.
 */
export function daysUntil(isoDate: string, today: string): number {
  const target = Date.parse(`${isoDate}T00:00:00Z`);
  const from = Date.parse(`${today}T00:00:00Z`);
  return Math.round((target - from) / MS_PER_DAY);
}

/**
 * A trip is active on `today` if today falls inside [startsOn, endsOn].
 *
 * `endsOn` is optional in the schema and often absent for single-day trips and
 * for anything still being planned. Requiring both dates would mean such a
 * trip is never active on any day — so Home would show the idle hero on the
 * very morning the family is travelling. A missing `endsOn` therefore means a
 * one-day trip, not an unbounded one: an open-ended end date would make an
 * old trip active forever.
 */
export function isActiveOn(
  trip: { startsOn: string | null; endsOn: string | null },
  today: string,
): boolean {
  if (!trip.startsOn) return false;
  return today >= trip.startsOn && today <= (trip.endsOn ?? trip.startsOn);
}

export function countdownLabel(
  startsOn: string | null,
  endsOn: string | null,
  today: string,
): string {
  if (!startsOn) return "Unscheduled";
  // No `endsOn &&` guard: isActiveOn now handles a missing end date itself,
  // and gating on it here would relabel a mid-trip day as "Past".
  if (isActiveOn({ startsOn, endsOn }, today)) return "Today";
  const days = daysUntil(startsOn, today);
  if (days < 0) return "Past";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export function formatTimeInZone(utcInstant: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(utcInstant));
}

function zoneAbbrev(utcInstant: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(new Date(utcInstant));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/**
 * A flight departing 6pm Boise and arriving 11pm Atlanta is not a five-hour
 * flight. Both endpoints render in their own zone, with the abbreviation shown
 * once when they match and on both sides when they do not.
 */
/**
 * The "when" line for a booking card, shared by OverviewTab and
 * SharedAgenda. The two call sites used to carry byte-identical copies of
 * this function that differ only in what they show for a booking with no
 * `startsAt` yet ("No date yet" on Overview, "" in the day view's time
 * gutter, where a label would misalign the timeline) — `emptyLabel` makes
 * that divergence an explicit choice at the call site instead of something
 * to notice by diffing two files.
 */
export function formatBookingWhen(
  b: {
    startsAt: string | null;
    startsAtTz: string | null;
    endsAt: string | null;
    endsAtTz: string | null;
  },
  emptyLabel: string,
): string {
  if (!b.startsAt) return emptyLabel;
  if (b.endsAt && b.endsAtTz && b.startsAtTz) {
    return formatDualZone(b.startsAt, b.startsAtTz, b.endsAt, b.endsAtTz);
  }
  return formatTimeInZone(b.startsAt, b.startsAtTz ?? "UTC");
}

export function formatDualZone(
  startUtc: string,
  startTz: string,
  endUtc: string,
  endTz: string,
): string {
  const start = formatTimeInZone(startUtc, startTz);
  const end = formatTimeInZone(endUtc, endTz);
  const startAbbr = zoneAbbrev(startUtc, startTz);
  const endAbbr = zoneAbbrev(endUtc, endTz);

  return startAbbr === endAbbr
    ? `${start} → ${end} ${endAbbr}`
    : `${start} ${startAbbr} → ${end} ${endAbbr}`;
}

/**
 * The offset, in milliseconds, that `timeZone` was on at `instant`.
 * Computed by formatting the instant in that zone and reading the result back
 * as if it were UTC; the difference is the offset. This is the portable way —
 * there is no API that hands you a zone's offset for a date directly.
 */
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
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    // Some engines render midnight as hour 24 under hour12:false.
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  return asUtc - instant;
}

/**
 * The inverse of `zonedToUtc` below: a stored UTC instant rendered as the
 * wall-clock date-time it reads in `timeZone`, in exactly the shape
 * `<input type="datetime-local">` wants (`"2026-10-09T09:40"`). The import
 * review's edit form prefills its datetime inputs with this, so a reviewer
 * sees the flight's own local time — not the browser's — and a save round-
 * trips through `zonedToUtc` to the identical instant.
 */
export function utcToZonedLocal(utcInstant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcInstant));
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  // Some engines render midnight as hour 24 under hour12:false — same note
  // as offsetAt above.
  const hour = String(Number(read("hour")) % 24).padStart(2, "0");
  return `${read("year")}-${read("month")}-${read("day")}T${hour}:${read("minute")}`;
}

/**
 * Convert a wall-clock local time (`"2026-10-09T09:40"`, as produced by
 * `<input type="datetime-local">`) in a named IANA zone into a UTC ISO
 * instant.
 *
 * `new Date("2026-10-09T09:40")` interprets the string in the *browser's*
 * zone, which is wrong for every flight that does not depart from where the
 * person filling in the form happens to be sitting. Storing that value would
 * put the booking on the wrong day in the itinerary.
 *
 * Throws `RangeError` rather than returning an "Invalid Date" — a booking
 * with an unparseable `starts_at` passes a non-empty-string check, is stored,
 * and then throws inside `ItineraryRepo.localDateOf()` on every future read
 * of that trip's day view, with no API route to repair it.
 */
export function zonedToUtc(localDateTime: string, timeZone: string): string {
  // Reject the zone first, so a bad zone is never blamed on the date.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new RangeError(`${timeZone} is not a recognised IANA timezone`);
  }

  // Read the wall clock as though it were UTC; the true instant differs from
  // this by exactly the zone's offset.
  const naive = Date.parse(`${localDateTime}:00.000Z`);
  if (Number.isNaN(naive)) {
    throw new RangeError(`${localDateTime} is not a parseable local date-time`);
  }

  // Two passes: the first guess can land on the wrong side of a DST
  // transition, and re-deriving the offset at the guessed instant settles it.
  let instant = naive - offsetAt(naive, timeZone);
  instant = naive - offsetAt(instant, timeZone);
  return new Date(instant).toISOString();
}
