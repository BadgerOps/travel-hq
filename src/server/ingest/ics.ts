import { isValidTimezone } from "../time.js";

export type IcsEvent = {
  summary: string | null;
  location: string | null;
  description: string | null;
  startsAt: string;
  startsAtTz: string;
  endsAt: string | null;
  endsAtTz: string | null;
};

export class IcsParseError extends Error {}

/** Parses VEVENTs all-or-nothing so a malformed leg cannot vanish silently. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let block: string[] | null = null;

  for (const line of lines) {
    if (line.toUpperCase() === "BEGIN:VEVENT") {
      block = [];
    } else if (line.toUpperCase() === "END:VEVENT") {
      if (block) {
        const event = parseEvent(block);
        if (!event) throw new IcsParseError("A VEVENT had an invalid or missing date/time");
        events.push(event);
      }
      block = null;
    } else if (block) {
      block.push(line);
    }
  }
  if (block) throw new IcsParseError("A VEVENT was not terminated");
  return events;
}

function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseEvent(lines: string[]): IcsEvent | null {
  const properties = lines.map(parseProperty).filter((value) => value !== null);
  const first = (name: string) => properties.find((property) => property!.name === name);
  const start = first("DTSTART");
  if (!start) return null;

  const parsedStart = parseDate(start.value, start.params.TZID);
  if (!parsedStart) return null;
  const end = first("DTEND");
  const parsedEnd = end ? parseDate(end.value, end.params.TZID) : null;
  if (end && !parsedEnd) return null;

  return {
    summary: valueOf(first("SUMMARY")),
    location: valueOf(first("LOCATION")),
    description: valueOf(first("DESCRIPTION")),
    startsAt: parsedStart.at,
    startsAtTz: parsedStart.tz,
    endsAt: parsedEnd?.at ?? null,
    endsAtTz: parsedEnd?.tz ?? null,
  };
}

type Property = { name: string; params: Record<string, string>; value: string };

function parseProperty(line: string): Property | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const [rawName, ...rawParams] = line.slice(0, colon).split(";");
  if (!rawName) return null;
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const equals = raw.indexOf("=");
    if (equals > 0) params[raw.slice(0, equals).toUpperCase()] = raw.slice(equals + 1);
  }
  return {
    name: rawName.toUpperCase(),
    params,
    value: unescapeText(line.slice(colon + 1)),
  };
}

function valueOf(property: Property | undefined): string | null {
  const value = property?.value.trim();
  return value ? value : null;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseDate(value: string, timezone: string | undefined): { at: string; tz: string } | null {
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zulu] = match;
  if (zulu === "Z") {
    const at = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    return Number.isNaN(at.getTime()) ? null : { at: at.toISOString(), tz: "UTC" };
  }
  if (!timezone || !isValidTimezone(timezone)) return null;
  const at = zonedToUtc(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    timezone,
  );
  return at ? { at: at.toISOString(), tz: timezone } : null;
}

function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date | null {
  // Iterate the zone offset because Intl exposes formatted wall time rather
  // than a direct inverse conversion.
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const rendered = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    guess += desired - rendered;
  }
  const result = new Date(guess);
  if (Number.isNaN(result.getTime())) return null;
  const final = Object.fromEntries(formatter.formatToParts(result).map((p) => [p.type, p.value]));
  if (
    Number(final.year) !== year ||
    Number(final.month) !== month ||
    Number(final.day) !== day ||
    Number(final.hour) !== hour ||
    Number(final.minute) !== minute ||
    Number(final.second) !== second
  ) {
    // Invalid calendar dates and nonexistent DST wall times must not be
    // normalized into a different instant.
    return null;
  }
  return result;
}
