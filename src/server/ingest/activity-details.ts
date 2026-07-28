/**
 * A deterministic scanner for the two facts an excursion booking lives or dies
 * by: **when and where you have to be standing**.
 *
 * Tour operators bury those in prose the model is free to paraphrase or drop —
 * "Pickup: 1:30pm at Quarter Circle/West Side Parking Lot. Please arrive at
 * your pickup location 15 minutes before departure time. […] Approximate
 * return time: 5:00". A model may return a title, a date and a cost from that
 * and consider itself done, and the family arrives at the wrong car park.
 *
 * So this module reads the same text with regexes and fills in only what the
 * model did not already provide (see `enrichActivityDetails`). It is
 * deliberately conservative: it labels nothing it did not actually find, and
 * every field it does emit is a verbatim slice of the source text (times are
 * reformatted, never invented).
 *
 * Keys emitted here must exist on `activityDetails` in
 * ../schemas/booking-kinds.ts, or they are silently stripped the moment a
 * draft is accepted into a real booking.
 */

export type ActivityTextDetails = {
  /** Local clock time as printed in the email, normalised: "1:30 PM". */
  pickupTime?: string;
  pickupLocation?: string;
  /** "arrive 15 minutes before departure" -> 15. */
  arriveMinutesBefore?: number;
  returnTime?: string;
  dropoffLocation?: string;
  /** Verbatim: "approximately 3.5 hours". */
  duration?: string;
};

/** The keys this module owns, so callers can say "did we learn anything?". */
const FIELDS = [
  "pickupTime",
  "pickupLocation",
  "arriveMinutesBefore",
  "returnTime",
  "dropoffLocation",
  "duration",
] as const;

const MAX_LOCATION_CHARS = 160;
const MAX_DURATION_CHARS = 60;
/** Text past this point is footer, unsubscribe boilerplate, and legal prose. */
const MAX_SCAN_CHARS = 20_000;

/**
 * Chunk labels. Anchored at the start of a chunk on purpose: an unanchored
 * /pickup/ matches "your pickup location" in the arrival sentence and turns a
 * reminder into a location.
 */
const PICKUP_LABEL =
  /^(?:your\s+|tour\s+|guest\s+)?(?:pick[\s.-]?up|departure|departs?|departing|boarding|meeting\s+point|meet(?:ing)?\s+(?:at|point|location)|check[\s.-]?in\s+(?:time|location|point))\b/i;

const RETURN_LABEL =
  /^(?:approx(?:imate(?:ly)?)?\.?\s+|estimated\s+|est\.?\s+|expected\s+)?(?:return|drop[\s.-]?off|arrive\s+back|back\s+at)\b/i;

const DURATION_LABEL =
  /^(?:approx(?:imate)?\.?\s+)?(?:duration|tour\s+length|length\s+of\s+(?:the\s+)?tour|trip\s+length)\b/i;

/**
 * "Please arrive at your pickup location 15 minutes before departure time."
 * The bounded gaps keep this from spanning a whole paragraph and pairing an
 * "arrive" in one sentence with a "30 minutes" three sentences later — the
 * chunker already splits sentences, and these caps are the second guard.
 */
const ARRIVE_EARLY =
  /\b(?:arrive|arrival|be\s+there|show\s+up|check[\s.-]?in)\b[^\n]{0,70}?\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b[^\n]{0,40}?\b(?:before|prior|early|earlier|ahead|in\s+advance)\b/i;

/**
 * Two spellings of a clock time, in priority order: with a meridiem
 * ("1:30pm", "9 AM") and bare 24-hour-or-ambiguous ("17:00", "5:00"). The
 * bare form requires the colon so "15 minutes" and "2026" cannot match.
 */
const CLOCK =
  /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?\b|\b(\d{1,2}):(\d{2})\b/i;

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set([
  "st", "ste", "ave", "blvd", "rd", "dr", "mt", "ft", "hwy", "pkwy", "ln",
  "approx", "est", "no", "jr", "sr", "mr", "mrs", "ms", "inc", "co",
  "n", "s", "e", "w", "ne", "nw", "se", "sw", "a", "p", "am", "pm",
]);

type ClockTime = { hour: number; minute: number; meridiem: "AM" | "PM" | null };

/**
 * Scans free text (an email body, an ICS DESCRIPTION) for excursion logistics.
 * Returns only the fields it actually found — never a key with an empty value,
 * so a caller can spread the result over existing details without erasing them.
 */
export function parseActivityDetails(text: string | null | undefined): ActivityTextDetails {
  if (!text) return {};
  const found: ActivityTextDetails = {};

  for (const chunk of chunks(text.slice(0, MAX_SCAN_CHARS))) {
    // Return is tested first: "Approximate return time" also contains no
    // pickup label, but "drop-off" chunks read as departures to a loose
    // pickup regex, and the more specific label must win.
    const asReturn = chunk.match(RETURN_LABEL);
    if (asReturn) {
      const parts = timeAndPlace(chunk.slice(asReturn[0].length));
      if (parts.time && found.returnTime === undefined) found.returnTime = parts.time;
      if (parts.place && found.dropoffLocation === undefined) found.dropoffLocation = parts.place;
      continue;
    }

    const asPickup = chunk.match(PICKUP_LABEL);
    if (asPickup) {
      const parts = timeAndPlace(chunk.slice(asPickup[0].length));
      if (parts.time && found.pickupTime === undefined) found.pickupTime = parts.time;
      if (parts.place && found.pickupLocation === undefined) found.pickupLocation = parts.place;
      continue;
    }

    const asDuration = chunk.match(DURATION_LABEL);
    if (asDuration && found.duration === undefined) {
      const value = trimField(chunk.slice(asDuration[0].length));
      if (value && value.length <= MAX_DURATION_CHARS) found.duration = value;
      continue;
    }

    const early = chunk.match(ARRIVE_EARLY);
    if (early && found.arriveMinutesBefore === undefined) {
      const amount = Number(early[1]);
      const minutes = /^h/i.test(early[2]!) ? amount * 60 : amount;
      // A "24 hours in advance" cancellation policy is not a call time.
      if (Number.isInteger(minutes) && minutes > 0 && minutes <= 360) {
        found.arriveMinutesBefore = minutes;
      }
    }
  }

  // A bare "5:00" return after a 1:30 PM pickup is 5 PM, and rendering it as
  // "5:00" invites reading it as morning. Only inferred when the pickup fixes
  // the half of the day; otherwise the raw text stands.
  if (found.returnTime && found.pickupTime) {
    found.returnTime = disambiguate(found.returnTime, found.pickupTime);
  }
  return found;
}

/**
 * Fills the gaps in `details` from `text`, model-first: a value the extractor
 * already produced is never overwritten, because it read the whole message and
 * this reads one sentence at a time.
 *
 * Returns the same object identity-free — callers can hand it straight to
 * `parseDetails`.
 */
export function enrichActivityDetails(
  details: unknown,
  text: string | null | undefined,
): Record<string, unknown> {
  const base = asRecord(details);
  const scanned = parseActivityDetails(text);
  const merged: Record<string, unknown> = { ...base };
  for (const field of FIELDS) {
    const value = scanned[field];
    if (value === undefined) continue;
    const existing = merged[field];
    if (existing === undefined || existing === null || existing === "") {
      merged[field] = value;
    }
  }
  return merged;
}

/** True when the record carries at least one logistics field worth showing. */
export function hasActivityLogistics(details: unknown): boolean {
  const record = asRecord(details);
  return FIELDS.some((field) => {
    const value = record[field];
    return value !== undefined && value !== null && value !== "";
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** "Pickup location:", "Return time -" — a line that names its own field. */
const FIELD_LINE = /^\s*(?:[-*•>]\s*)?[A-Za-z][A-Za-z0-9 ./&'()-]{0,28}[:–—]\s/;

/**
 * Logical lines first, then sentences within each. Both steps matter: a
 * labelled email puts "Pickup: …" on its own line, and a prose one runs the
 * pickup, the arrival reminder and the return together in one paragraph.
 */
function chunks(text: string): string[] {
  return unwrap(text)
    .flatMap(splitSentences)
    .map((chunk) => chunk.replace(/[ \t]+/g, " ").trim())
    .filter((chunk) => chunk !== "");
}

/**
 * Undoes the hard wrapping every mail client applies at ~78 columns, which
 * would otherwise split "Please arrive at your / pickup location 15 minutes
 * before departure time." across two chunks and lose the call time entirely.
 *
 * A continuation is joined to the line above unless it starts a new field of
 * its own — without that check, a labelled block ("Pickup location: …" /
 * "Return time: …") would fuse into one line and the return's time would be
 * read as the pickup's.
 */
function unwrap(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const previous = lines[lines.length - 1];
    if (line === "") {
      // A blank line is a hard break: never join across it.
      if (previous !== undefined && previous !== "") lines.push("");
      continue;
    }
    if (previous === undefined || previous === "" || FIELD_LINE.test(raw)) {
      lines.push(line);
      continue;
    }
    lines[lines.length - 1] = `${previous} ${line}`;
  }
  return lines.filter((line) => line !== "");
}

function splitSentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  // A sentence ends at .!? followed by space and a capital/digit — unless the
  // word before the full stop is an abbreviation ("St. Mary Lodge" is one
  // place, not two sentences).
  // Iterated with matchAll rather than a RegExp-stepping loop: the raw-SQL
  // guard in tests/server/architecture.test.ts bans that method's spelling
  // outside the repository layer, matching the name rather than the receiver.
  const boundary = /[.!?]\s+(?=[A-Z0-9])/g;
  for (const match of line.matchAll(boundary)) {
    const index = match.index ?? 0;
    const before = line.slice(start, index);
    const lastWord = before.match(/([A-Za-z]+)$/)?.[1]?.toLowerCase();
    if (lastWord && ABBREVIATIONS.has(lastWord)) continue;
    out.push(line.slice(start, index + 1));
    start = index + match[0].length;
  }
  out.push(line.slice(start));
  return out;
}

/**
 * Pulls a clock time and a place out of the remainder of a labelled chunk.
 *
 * The place can sit either side of the time — "Pickup: 1:30pm at the West
 * Side Lot" and "Meeting point: Apgar Visitor Center at 9:00 AM" are both
 * common — so the text after the time is preferred and the text before it is
 * the fallback.
 */
function timeAndPlace(rest: string): { time?: string; place?: string } {
  const match = rest.match(CLOCK);
  if (!match) {
    const place = trimField(rest);
    return place && place.length <= MAX_LOCATION_CHARS ? { place } : {};
  }
  const clock = readClock(match);
  const at = match.index ?? 0;
  const after = trimField(rest.slice(at + match[0].length));
  const before = trimField(rest.slice(0, at));
  const place = pickPlace(after) ?? pickPlace(before);
  return {
    ...(clock ? { time: formatClock(clock) } : {}),
    ...(place ? { place } : {}),
  };
}

function pickPlace(candidate: string): string | undefined {
  if (candidate === "" || candidate.length > MAX_LOCATION_CHARS) return undefined;
  // A leftover fragment that is only punctuation, a number, or another time
  // is not a place.
  if (!/[A-Za-z]{2}/.test(candidate)) return undefined;
  return candidate;
}

/**
 * Strips the connective tissue between a label and its value: the separator
 * ("Pickup: …", "Pickup - …"), the qualifier the label did not swallow
 * ("Pickup **time**: …"), and a leading or trailing preposition left behind
 * when the time is cut out of the middle ("… Visitor Center **at** ").
 */
function trimField(raw: string): string {
  let value = raw.trim();
  let previous: string;
  do {
    previous = value;
    value = value
      .replace(/^[:–—\-,;>*|\s]+/, "")
      .replace(/^(?:time|location|point|place|address|is|will\s+be)\b\s*/i, "")
      .replace(/^(?:at|from|in|on|by|near|outside|to)\b\s*/i, "")
      .trim();
  } while (value !== previous);
  return value
    .replace(/[\s,;:.–—-]+$/, "")
    .replace(/\b(?:at|from|in|on|by|near|outside|to)$/i, "")
    .replace(/[\s,;:.–—-]+$/, "")
    .trim();
}

function readClock(match: RegExpMatchArray): ClockTime | null {
  // Alternation one: an explicit meridiem. Alternation two: bare H:MM.
  const meridiemHour = match[1];
  if (meridiemHour !== undefined) {
    const hour = Number(meridiemHour);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return { hour, minute, meridiem: /^p$/i.test(match[3]!) ? "PM" : "AM" };
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  // 13:00 and 00:30 are unambiguous 24-hour clock; 5:00 is not.
  if (hour === 0) return { hour: 12, minute, meridiem: "AM" };
  if (hour > 12) return { hour: hour - 12, minute, meridiem: "PM" };
  return { hour, minute, meridiem: null };
}

function formatClock(clock: ClockTime): string {
  const time = `${clock.hour}:${String(clock.minute).padStart(2, "0")}`;
  return clock.meridiem ? `${time} ${clock.meridiem}` : time;
}

/**
 * Resolves a meridiem-less return time against a known pickup: pick the
 * earliest reading that is not before the pickup. A tour that leaves at
 * 1:30 PM does not get back at 5 AM.
 */
function disambiguate(returnTime: string, pickupTime: string): string {
  if (/[AP]M$/.test(returnTime)) return returnTime;
  const pickup = parseFormatted(pickupTime);
  const back = parseFormatted(returnTime);
  if (!pickup || !back || pickup.meridiem === null) return returnTime;
  const pickupMinutes = minutesOf(pickup);
  for (const meridiem of ["AM", "PM"] as const) {
    const candidate: ClockTime = { ...back, meridiem };
    if (minutesOf(candidate) >= pickupMinutes) return formatClock(candidate);
  }
  return returnTime;
}

function parseFormatted(value: string): ClockTime | null {
  const match = value.match(/^(\d{1,2}):(\d{2})(?:\s+(AM|PM))?$/);
  if (!match) return null;
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    meridiem: (match[3] as "AM" | "PM" | undefined) ?? null,
  };
}

function minutesOf(clock: ClockTime): number {
  const base = clock.hour % 12;
  const hour = clock.meridiem === "PM" ? base + 12 : base;
  return hour * 60 + clock.minute;
}
