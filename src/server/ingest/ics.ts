/**
 * A minimal RFC 5545 VEVENT reader for the ingest extractor (#6). Reads
 * SUMMARY, LOCATION, DESCRIPTION, and DTSTART/DTEND with their TZID — the
 * whole of what a draft booking needs — because .ics is the one source in a
 * confirmation email that states a real IANA zone per endpoint, which is
 * exactly the pair `booking` stores and the day view depends on. No
 * dependency, same reasoning as mime.ts.
 *
 * Spelling note: regexes here go through `str.match(re)`, never the
 * RegExp-side method — see mime.ts for why (the architecture test bans that
 * substring under src/server/ outside repos/, db/, and auth.ts).
 */
export type IcsEvent = {
  summary: string | null;
  location: string | null;
  description: string | null;
  startsAt: string;
  startsAtTz: string;
  endsAt: string | null;
  endsAtTz: string | null;
};

/** The offset `timeZone` was on at `instant`, in milliseconds. */
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
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return (
    Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second")) -
    instant
  );
}

/**
 * `20261009T094000` in a named zone -> a UTC instant. Two passes settle a
 * guess that lands on the wrong side of a DST transition. Throws for an
 * unparseable value or unknown zone; the caller turns that into "skip this
 * event" rather than "store a value that bricks the day view".
 */
function toUtc(value: string, timeZone: string): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) throw new RangeError(`Unparseable iCalendar date-time: ${value}`);
  const [, y, mo, d, h, mi, s] = m as unknown as string[];

  if (timeZone === "UTC") {
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    ).toISOString();
  }

  // Throws for an unrecognised zone.
  new Intl.DateTimeFormat("en-US", { timeZone });

  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let instant = naive - offsetAt(naive, timeZone);
  instant = naive - offsetAt(instant, timeZone);
  return new Date(instant).toISOString();
}

/** RFC 5545 line unfolding: a leading space or tab continues the line above. */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

type Prop = { name: string; params: Record<string, string>; value: string };

function parseProp(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq !== -1) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/"/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value: line.slice(colon + 1) };
}

/**
 * Reads every VEVENT out of an iCalendar text. An event whose DTSTART will
 * not parse (bad value, unknown zone) is DROPPED, not emitted with a bad
 * value: a stored unparseable timestamp throws inside ItineraryRepo on every
 * future read of that trip's day view, permanently. A missing event a human
 * retypes is a far smaller problem. A DTEND that fails alone degrades to
 * null rather than taking the event with it.
 */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> & { rawStart?: Prop; rawEnd?: Prop } = {};
  let inEvent = false;

  for (const line of unfold(text)) {
    const prop = parseProp(line);
    if (prop === null) continue;

    if (prop.name === "BEGIN" && prop.value === "VEVENT") {
      inEvent = true;
      current = {};
      continue;
    }
    if (prop.name === "END" && prop.value === "VEVENT") {
      inEvent = false;
      const start = current.rawStart;
      if (!start) continue;
      try {
        const startTz = start.params.TZID ?? "UTC";
        const end = current.rawEnd;
        let endsAt: string | null = null;
        let endsAtTz: string | null = null;
        if (end) {
          try {
            endsAtTz = end.params.TZID ?? "UTC";
            endsAt = toUtc(end.value, endsAtTz);
          } catch {
            endsAt = null;
            endsAtTz = null;
          }
        }
        events.push({
          summary: current.summary ?? null,
          location: current.location ?? null,
          description: current.description ?? null,
          startsAt: toUtc(start.value, startTz),
          startsAtTz: startTz,
          endsAt,
          endsAtTz,
        });
      } catch {
        // Unparseable DTSTART or unknown zone: drop the event.
      }
      continue;
    }
    if (!inEvent) continue;

    // Unescape RFC 5545 text escapes in the free-text fields.
    const unescaped = prop.value.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, "\n");
    if (prop.name === "SUMMARY") current.summary = unescaped.trim();
    else if (prop.name === "LOCATION") current.location = unescaped.trim();
    else if (prop.name === "DESCRIPTION") current.description = unescaped.trim();
    else if (prop.name === "DTSTART") current.rawStart = prop;
    else if (prop.name === "DTEND") current.rawEnd = prop;
  }

  return events;
}
