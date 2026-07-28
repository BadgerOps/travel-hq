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

/**
 * The one effective state a trip is in — what Home's hero, the grid
 * ordering, and every badge read. "Status wins when set, dates fill in":
 * a stored `cancelled`/`complete`/`active` is an explicit human decision
 * and beats whatever the dates say; the default `planning` means "nobody
 * has said anything", so the dates decide.
 */
export type TripState = "active" | "upcoming" | "past" | "complete" | "cancelled";

type TripLike = {
  status: "planning" | "active" | "complete" | "cancelled";
  startsOn: string | null;
  endsOn: string | null;
};

export function resolveTripState(trip: TripLike, today: string): TripState {
  switch (trip.status) {
    case "cancelled":
      return "cancelled";
    case "complete":
      return "complete";
    case "active":
      return "active";
    case "planning": {
      if (isActiveOn(trip, today)) return "active";
      // Undated sorts with the future, not the past: a trip with no start
      // date is one still being planned, which is an upcoming thing.
      if (!trip.startsOn || trip.startsOn > today) return "upcoming";
      return "past";
    }
  }
}

/** Display order, ascending: the now, the next, then the finished. */
const TRIP_STATE_RANK: Record<TripState, number> = {
  active: 0,
  upcoming: 1,
  past: 2,
  complete: 3,
  cancelled: 4,
};

export function tripStateRank(state: TripState): number {
  return TRIP_STATE_RANK[state];
}

/**
 * The one comparator for trip lists (Home's grid and the Trips page), so
 * the two can never disagree about order. Rank first; within a rank the
 * live states (active/upcoming) read soonest-first with undated last, and
 * the finished states (past/complete/cancelled) most-recent-first.
 */
export function compareTrips(a: TripLike, b: TripLike, today: string): number {
  const rankA = tripStateRank(resolveTripState(a, today));
  const rankB = tripStateRank(resolveTripState(b, today));
  if (rankA !== rankB) return rankA - rankB;
  const finished = rankA >= TRIP_STATE_RANK.past;
  const as = a.startsOn;
  const bs = b.startsOn;
  if (as === null || bs === null) {
    // Undated last in either direction — "no date" is the least informative
    // sort key there is.
    return as === bs ? 0 : as === null ? 1 : -1;
  }
  return finished ? bs.localeCompare(as) : as.localeCompare(bs);
}

/**
 * The badge text for a trip, state-aware. An explicit state names itself;
 * a date-derived state keeps the countdown language ("In 12 days", "Today",
 * "Past"). A forced-active trip whose dates do not cover today says
 * "Active" — a countdown would contradict the state the family set.
 */
export function tripStateBadge(trip: TripLike, today: string): string {
  const state = resolveTripState(trip, today);
  if (state === "cancelled") return "Cancelled";
  if (state === "complete") return "Complete";
  if (state === "active" && !isActiveOn(trip, today)) return "Active";
  return countdownLabel(trip.startsOn, trip.endsOn, today);
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

/* All three calendar-date formatters below parse YYYY-MM-DD as UTC midnight
   and format in UTC, for the same reason daysUntil does: these are dates with
   no time or zone, and going through local time shifts them by a day for
   viewers west of the ISO date line the string implies. */

function utcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

function fmtUtc(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(d);
}

/** "Sunday, July 27" — the greeting subline's long form of a calendar date. */
export function formatLongDate(isoDate: string): string {
  return fmtUtc(utcDate(isoDate), { weekday: "long", month: "long", day: "numeric" });
}

/** "Fri 9" — the day gutter label on day-by-day teaser rows. */
export function formatDayLabel(isoDate: string): string {
  const d = utcDate(isoDate);
  return `${fmtUtc(d, { weekday: "short" })} ${fmtUtc(d, { day: "numeric" })}`;
}

/**
 * Human date range for a trip: "Oct 9–11", "Oct 30 – Nov 2", "Mar 20–28, 2027".
 * The year appears only when it is not `today`'s year — the mockups label the
 * current year's wedding "Oct 9–11" and next spring's Kauai "Mar 20–28, 2027".
 * A missing or equal `endsOn` collapses to the single day ("Oct 9").
 */
export function formatDateRange(
  startsOn: string,
  endsOn: string | null,
  today: string,
): string {
  const refYear = Number(today.slice(0, 4));
  const s = utcDate(startsOn);
  const sYear = s.getUTCFullYear();
  const sMonth = fmtUtc(s, { month: "short" });
  const sDay = fmtUtc(s, { day: "numeric" });
  if (!endsOn || endsOn === startsOn) {
    return `${sMonth} ${sDay}${sYear !== refYear ? `, ${sYear}` : ""}`;
  }
  const e = utcDate(endsOn);
  const eYear = e.getUTCFullYear();
  const eMonth = fmtUtc(e, { month: "short" });
  const eDay = fmtUtc(e, { day: "numeric" });
  if (sYear !== eYear) {
    return `${sMonth} ${sDay}, ${sYear} – ${eMonth} ${eDay}, ${eYear}`;
  }
  const year = sYear !== refYear ? `, ${sYear}` : "";
  return sMonth === eMonth
    ? `${sMonth} ${sDay}–${eDay}${year}`
    : `${sMonth} ${sDay} – ${eMonth} ${eDay}${year}`;
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
    details?: unknown;
  },
  emptyLabel: string,
): string {
  if (!b.startsAt) {
    const details =
      b.details !== null && typeof b.details === "object"
        ? b.details as Record<string, unknown>
        : {};
    const start = typeof details.checkInDate === "string" ? details.checkInDate : null;
    const end = typeof details.checkOutDate === "string" ? details.checkOutDate : null;
    if (start) {
      const format = (value: string) => new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(`${value}T00:00:00Z`));
      return end ? `${format(start)} → ${format(end)}` : format(start);
    }
    return emptyLabel;
  }
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

/**
 * The inverse of `zonedToUtc`: a stored UTC instant back to the
 * `"2026-10-09T09:40"` wall-clock string an `<input type="datetime-local">`
 * expects, in a named IANA zone.
 *
 * Needed to seed the edit form. Slicing `new Date(instant).toISOString()`
 * would show the departure in UTC, and `toLocaleString` would show it in the
 * browser's zone — both put a 1:30 PM Montana pickup on screen as some other
 * time, and saving that back would move the booking.
 *
 * Returns `""` for an instant or zone the platform cannot render, so a bad
 * stored value leaves the field blank instead of writing "Invalid Date" into
 * it (and then back to the server).
 */
export function utcToZonedLocal(utcInstant: string, timeZone: string): string {
  const date = new Date(utcInstant);
  if (Number.isNaN(date.valueOf())) return "";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
  } catch {
    return "";
  }
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // Some engines render midnight as hour 24 under hour12:false, the same
  // quirk offsetAt() above compensates for.
  const hour = String(Number(read("hour")) % 24).padStart(2, "0");
  return `${read("year")}-${read("month")}-${read("day")}T${hour}:${read("minute")}`;
}
