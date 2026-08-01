/**
 * How well an existing trip fits the imports a reviewer is looking at.
 *
 * This is the single definition of "this draft belongs to that trip". It has
 * two consumers that used to disagree:
 *
 *  - `ImportReviewRepo.listPending` decides the per-draft `suggestedTrip` (the
 *    "Matches Europe" chip, and the one-click accept behind it), and
 *  - the review queue's "Existing trip" picker, which until now rendered the
 *    trips in whatever order `GET /api/trips` returned — alphabetical by
 *    nothing in particular, so the trip the drafts obviously belong to could
 *    sit tenth in a list of twelve.
 *
 * Keeping the rules here rather than in either caller means the picker cannot
 * put a trip at the top that the server would refuse to call a match, and it
 * means the awkward cases (a stay that starts the day a trip ends, two trips a
 * week apart, a trip with no dates at all) are testable without a database or
 * a browser.
 *
 * PURE AND IMPORT-FREE by design — no server types, no repositories, no React.
 * The server half runs inside a Worker and the client half runs in the browser
 * bundle; anything imported here would be dragged into both.
 *
 * ---------------------------------------------------------------------------
 * THE SCORE
 *
 * Date proximity is primary and location is a tie-breaker, expressed as one
 * number so a caller can sort by it without knowing the rules:
 *
 *   trip range contains the selection            1000
 *   ranges overlap without containing             800
 *   ranges are apart by N days             600 - 20*N   (floored at 0)
 *   trip has no dates                            -1000
 *   the selection itself has no dates                0   (date says nothing)
 *
 *   + same destination                             +60
 *   + destination shares a word                    +30
 *   + trip TITLE shares a word                     +15
 *
 * The location bonus is capped at 60 and the gap between containment and mere
 * overlap is 200, so location can reorder trips whose dates are equally good
 * but can never promote a trip over one whose dates actually contain the
 * booking. That asymmetry is deliberate: a wrong "smart" match is worse than
 * no match, because the reviewer is one click from filing a hotel onto the
 * wrong trip and only finds out on the day.
 *
 * An undated trip sits below even a trip a year away (-1000 against a floor of
 * 0) because "no dates" is not evidence of fit, and the maximum location bonus
 * cannot lift it back over one.
 *
 * Everything past a month ties at 0 by design, so `rankTrips` breaks ties on
 * the actual gap, ascending. That is a presentation rule as much as a ranking
 * one — every option is labelled with its exact day count, and a list ordered
 * 2, 103, 67 reads as broken however defensible the arithmetic behind it is.
 * See `rankTrips` for why the gap is a tie-break rather than part of the score.
 *
 * MULTI-DRAFT SELECTIONS are scored against the selection's own COMBINED range
 * — earliest start to latest end across every selected draft — which is the
 * same range `ImportReviewRepo.createTripFromDrafts` would give a trip created
 * from those same drafts. Scoring each draft separately and averaging would
 * rank a trip that fits the flight but not the week-long stay above one that
 * comfortably contains both; the union asks the question the reviewer is
 * actually asking, which is "does this whole selection fit in that trip?".
 * Location is the opposite — it takes the BEST match across the selected
 * drafts, because a flight whose location is "DEN → AMS" says nothing about
 * Amsterdam while the hotel selected beside it says it plainly.
 */

/** A local calendar-date range, `YYYY-MM-DD`, inclusive at both ends. */
export type DateRange = { startsOn: string; endsOn: string };

/** The subset of a trip this module needs. Structural, so both sides fit it. */
export type MatchableTrip = {
  title?: string | null;
  destination?: string | null;
  startsOn: string | null;
  endsOn: string | null;
};

/** What the reviewer currently has selected, reduced to what scoring needs. */
export type ImportSelection = {
  /** Combined range of the selection; null when nothing selected is dated. */
  range: DateRange | null;
  /** Each selected draft's location line. Blank/absent entries are ignored. */
  locations: string[];
};

/**
 * Where a trip's range sits relative to the selection's.
 *
 * `unknown` is not a failure — it is "the selection has no dates, so dates
 * cannot rank anything", which is a different statement from `undated` ("this
 * trip has no dates") and must not be conflated with it: the first applies to
 * every trip equally, the second only to that one trip.
 */
export type DateFit = "contains" | "overlaps" | "before" | "after" | "undated" | "unknown";

export type LocationFit = "destination" | "destination-word" | "title-word" | "none";

export type TripMatch = {
  score: number;
  dateFit: DateFit;
  /** Whole days between the nearest edges, for `before`/`after`. Else null. */
  gapDays: number | null;
  locationFit: LocationFit;
  /**
   * Why this trip ranks where it does, in the reviewer's words ("covers these
   * dates · same destination"). A silently reordered dropdown is confusing;
   * this is the sentence that makes the order answerable.
   */
  label: string;
};

const DATE_CONTAINS = 1000;
const DATE_OVERLAPS = 800;
const DATE_NEAR_BASE = 600;
/** A month away scores the same as the far side of the calendar: nothing. */
const DATE_NEAR_PER_DAY = 20;
const DATE_UNDATED = -1000;

const LOCATION_DESTINATION = 60;
const LOCATION_DESTINATION_WORD = 30;
const LOCATION_TITLE_WORD = 15;

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Words too generic to be evidence, plus the ones a title picks up for free.
 * Deliberately short: every entry is a word we have actually seen produce a
 * false match, not a guess at what might.
 */
const STOPWORDS = new Set([
  "trip",
  "trips",
  "vacation",
  "holiday",
  "travel",
  "airport",
  "intl",
  "international",
  "city",
  "area",
  "county",
  "north",
  "south",
  "east",
  "west",
  "the",
  "and",
]);

/**
 * Below four characters a "word" is an airport code, a road number, or a
 * two-letter country abbreviation — "DEN → AMS" must not match a trip to
 * Denmark, and "St." must not match anything at all.
 */
const MIN_WORD_LENGTH = 4;

/** Case-, accent- and punctuation-insensitive words worth matching on. */
export function locationWords(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized === "") return [];
  return normalized
    .split(" ")
    .filter((word) => word.length >= MIN_WORD_LENGTH && !STOPWORDS.has(word));
}

/** The union of every supplied range. Undated entries contribute nothing. */
export function combineRanges(ranges: Array<DateRange | null | undefined>): DateRange | null {
  let combined: DateRange | null = null;
  for (const range of ranges) {
    if (!range) continue;
    if (!combined) {
      combined = { startsOn: range.startsOn, endsOn: range.endsOn };
      continue;
    }
    if (range.startsOn < combined.startsOn) combined.startsOn = range.startsOn;
    if (range.endsOn > combined.endsOn) combined.endsOn = range.endsOn;
  }
  return combined;
}

/**
 * Where the trip sits relative to the range, and how far away if apart.
 *
 * Both halves of a trip's range must be present: a trip with only a start is
 * treated as undated, because "contains" is a claim about an interval and half
 * an interval cannot support it. Same for a date string the calendar does not
 * contain — this module never invents a day, it declines to rank.
 */
export function tripDateFit(
  trip: Pick<MatchableTrip, "startsOn" | "endsOn">,
  range: DateRange | null,
): { fit: DateFit; gapDays: number | null } {
  if (!range) return { fit: "unknown", gapDays: null };
  const tripStart = dayNumber(trip.startsOn);
  const tripEnd = dayNumber(trip.endsOn);
  const start = dayNumber(range.startsOn);
  const end = dayNumber(range.endsOn);
  if (tripStart === null || tripEnd === null) return { fit: "undated", gapDays: null };
  if (start === null || end === null) return { fit: "unknown", gapDays: null };

  if (tripStart <= start && tripEnd >= end) return { fit: "contains", gapDays: 0 };
  if (tripStart <= end && tripEnd >= start) return { fit: "overlaps", gapDays: 0 };
  return tripEnd < start
    ? { fit: "before", gapDays: start - tripEnd }
    : { fit: "after", gapDays: tripStart - end };
}

/** The one place that turns a fit into a number. */
function dateScore(fit: DateFit, gapDays: number | null): number {
  switch (fit) {
    case "contains":
      return DATE_CONTAINS;
    case "overlaps":
      return DATE_OVERLAPS;
    case "before":
    case "after":
      return Math.max(0, DATE_NEAR_BASE - DATE_NEAR_PER_DAY * (gapDays ?? 0));
    case "undated":
      return DATE_UNDATED;
    case "unknown":
      return 0;
  }
}

/**
 * How closely this trip's destination (and, failing that, its title) reads
 * like the places the selected drafts name.
 *
 * Destination before title, and title worth a quarter of a destination match:
 * a trip called "Grandma's" tells you nothing about where it is, whereas its
 * destination field exists for exactly this question. The title is consulted
 * anyway — even when a destination is present and disagrees — because plenty
 * of trips are named after the place ("Silverwood weekend") and carry a
 * destination that is merely the nearest city. At 15 points it can only
 * separate trips whose dates already tie, which is the most a name deserves.
 */
function locationFitOf(trip: MatchableTrip, locations: string[]): LocationFit {
  const wanted = locations.map(locationWords).filter((words) => words.length > 0);
  if (wanted.length === 0) return "none";

  const destination = locationWords(trip.destination);
  if (destination.length > 0) {
    // Subset either way counts as the same place: "Stuttgart, Germany" and
    // "Germany" are not two destinations, they are one written at two zoom
    // levels. Sharing merely A word ("France" in "Paris, France" and "Nice,
    // France") is a weaker claim and scores as one.
    if (wanted.some((words) => isSubset(words, destination) || isSubset(destination, words))) {
      return "destination";
    }
    if (wanted.some((words) => sharesWord(words, destination))) return "destination-word";
  }

  const title = locationWords(trip.title);
  if (title.length > 0 && wanted.some((words) => sharesWord(words, title))) {
    return "title-word";
  }
  return "none";
}

function locationScore(fit: LocationFit): number {
  switch (fit) {
    case "destination":
      return LOCATION_DESTINATION;
    case "destination-word":
      return LOCATION_DESTINATION_WORD;
    case "title-word":
      return LOCATION_TITLE_WORD;
    case "none":
      return 0;
  }
}

/** How well one trip fits one selection, with the sentence that explains it. */
export function scoreTripMatch(trip: MatchableTrip, selection: ImportSelection): TripMatch {
  const { fit, gapDays } = tripDateFit(trip, selection.range);
  const locationFit = locationFitOf(trip, selection.locations);
  return {
    score: dateScore(fit, gapDays) + locationScore(locationFit),
    dateFit: fit,
    gapDays,
    locationFit,
    label: matchLabel(fit, gapDays, locationFit),
  };
}

/**
 * The trips, best fit first, each with its reason.
 *
 * Two keys, and the second one is not decoration. The score floors at 0 past a
 * month (see DATE_NEAR_PER_DAY), which is the honest thing for the score to do
 * — a trip 40 days away and one 300 days away are equally "not this one" — but
 * every option is LABELLED with its exact day count, and a list that reads
 * "ends 2 days before / ends 103 days before / starts 67 days later" makes the
 * whole feature look broken. It does not matter that the ranking is behaving
 * as designed; the user is reading the numbers, and the visible order must
 * never contradict the visible label.
 *
 * So the gap breaks ties, ascending, without entering the score. Scoring the
 * gap all the way out instead would have meant claiming a precision the fit
 * does not have — and would have let a 40-days-away trip with a matching
 * destination outrank a 300-days-away one for a reason the label never
 * mentions. This way the score still says "these are equally unrelated" and
 * the order still reads in calendar order.
 *
 * Trips with nothing to separate them on either key keep the order the caller
 * supplied — the API's own — because the sort is STABLE (Array.prototype.sort
 * has been since ES2019). An unchanged queue must not reshuffle between
 * renders. Undated trips are unaffected: they carry no gap, and their -1000
 * puts them below everything dated whatever the tie-break says.
 */
export function rankTrips<T extends MatchableTrip>(
  trips: readonly T[],
  selection: ImportSelection,
): Array<{ trip: T; match: TripMatch }> {
  return trips
    .map((trip) => ({ trip, match: scoreTripMatch(trip, selection) }))
    .sort((a, b) => b.match.score - a.match.score || nearness(a.match) - nearness(b.match));
}

/**
 * How far this trip is from the selection, for the tie-break above. A fit with
 * no gap to speak of — it contains, it overlaps, it has no dates, the selection
 * has no dates — is 0, which leaves those trips in the caller's order rather
 * than sorting them against a number they do not have.
 */
function nearness(match: TripMatch): number {
  return match.gapDays ?? 0;
}

function matchLabel(fit: DateFit, gapDays: number | null, locationFit: LocationFit): string {
  const days = gapDays === 1 ? "1 day" : `${gapDays} days`;
  const date =
    fit === "contains"
      ? "covers these dates"
      : fit === "overlaps"
        ? "dates overlap"
        : fit === "before"
          ? `ends ${days} before`
          : fit === "after"
            ? `starts ${days} later`
            : fit === "undated"
              ? "no dates"
              : "";
  const location =
    locationFit === "destination"
      ? "same destination"
      : locationFit === "destination-word"
        ? "destination matches"
        : locationFit === "title-word"
          ? "matches trip name"
          : "";
  return [date, location].filter((part) => part !== "").join(" · ");
}

/** Whole days since the epoch, or null for anything that is not a real date. */
function dayNumber(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  // `.match()` rather than the pattern's own matcher: the architecture test
  // bans the `.exec(` spelling outside the repository layer because it cannot
  // tell a regular expression's from a database handle's. See time.ts.
  const match = value.match(CALENDAR_DATE);
  if (!match) return null;
  const [, year, month, day] = match;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(at);
  // Date.UTC rolls February 30th forward into March rather than failing, so a
  // date the calendar does not contain would otherwise score as a real one.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return at / DAY_MS;
}

function isSubset(subject: string[], of: string[]): boolean {
  return subject.every((word) => of.includes(word));
}

function sharesWord(a: string[], b: string[]): boolean {
  return a.some((word) => b.includes(word));
}
