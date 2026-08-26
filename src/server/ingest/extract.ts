import { parseMime } from "./mime.js";
import type { ParsedEmail } from "./mime.js";
import { parseIcs } from "./ics.js";
import type { IcsEvent } from "./ics.js";
import { ExtractionError, normalizeExtractedBooking } from "./extracted.js";
import type { ExtractedBooking } from "./extracted.js";
import { enrichActivityDetails, parseActivityDetails } from "./activity-details.js";
import { WorkersAiProvider } from "./providers.js";
import type { ExtractionAi, ExtractionProvider } from "./providers.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import type { InboundEmail } from "../repos/inbound-email.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import type { CreateDraftBookingInput, DraftBookingSource } from "../repos/draft-booking.js";
import { zonedTimestampToUtc } from "../time.js";

export type { ExtractionAi } from "./providers.js";

export type ExtractionContext = {
  db: D1Database;
  householdId: string;
  /** New provider seam. Legacy ai/aiModel remain for focused compatibility. */
  provider?: ExtractionProvider;
  ai?: ExtractionAi;
  aiModel?: string;
  aiMaxTokens?: number;
  extractionInstructions?: string;
};

const MAX_ERROR_CHARS = 500;
export const MAX_AI_TEXT_CHARS = 24_000;

/**
 * Extract one stored message without ever propagating an extraction failure
 * into Email Routing. Draft writes are atomic; status completion is retryable.
 */
export async function extractInboundEmail(ctx: ExtractionContext, email: InboundEmail): Promise<void> {
  const emails = InboundEmailRepo.forIngest(ctx.db, ctx.householdId);
  const drafts = DraftBookingRepo.forIngest(ctx.db, ctx.householdId);

  // A prior invocation may have committed its whole draft batch and then lost
  // the status update. Finish that transition instead of calling a
  // nondeterministic model again or duplicating drafts.
  try {
    if ((await drafts.listByEmail(email.id)).length > 0) {
      await markExtractedBestEffort(emails, email.id);
      return;
    }
  } catch (err) {
    console.error(`[extract] could not inspect existing drafts for inbound email ${email.id}`, err);
  }

  let inputs: CreateDraftBookingInput[];
  try {
    const parsed = parseMime(email.raw);
    let bookings: ExtractedBooking[];
    let source: DraftBookingSource;

    if (parsed.calendars.length > 0) {
      const events = parsed.calendars.flatMap(parseIcs);
      if (events.length === 0) {
        throw new ExtractionError("The calendar attachment contained no usable VEVENT");
      }
      bookings = bookingsFromIcs(events);
      source = "ics";
    } else {
      const provider =
        ctx.provider ??
        (ctx.ai && ctx.aiModel
          ? new WorkersAiProvider(ctx.ai, ctx.aiModel, ctx.aiMaxTokens)
          : undefined);
      if (!provider) {
        console.warn(
          `[extract] no AI binding and no calendar part; leaving inbound email ${email.id} queued as received`,
        );
        return;
      }
      bookings = await extractBookings(provider, parsed, ctx.extractionInstructions ?? "");
      source = "ai";
    }

    inputs = bookings.map((booking, ordinal) => ({
      inboundEmailId: email.id,
      ordinal,
      kind: booking.kind,
      title: booking.title,
      location: booking.location ?? null,
      startsAt: booking.startsAt ?? null,
      startsAtTz: booking.startsAtTz ?? null,
      endsAt: booking.endsAt ?? null,
      endsAtTz: booking.endsAtTz ?? null,
      confirmationNumber: booking.confirmationNumber ?? null,
      source,
      extracted:
        source === "ai"
          ? { ...booking, extractionProvider: providerName(ctx) }
          : booking,
    }));
    await drafts.createMany(inputs);
  } catch (err) {
    // A racing/retried invocation may have won the unique ordinal insert.
    // Complete the status if a full batch now exists; otherwise this is a
    // content/model/storage failure and belongs on the email.
    try {
      if ((await drafts.listByEmail(email.id)).length > 0) {
        await markExtractedBestEffort(emails, email.id);
        return;
      }
    } catch (inspectErr) {
      console.error(`[extract] could not inspect drafts after failure for inbound email ${email.id}`, inspectErr);
    }
    console.error(`[extract] extraction failed for inbound email ${email.id}`, err);
    try {
      await emails.markFailed(email.id, describeError(err));
    } catch (markErr) {
      console.error(`[extract] could not mark inbound email ${email.id} failed`, markErr);
    }
    return;
  }

  // Do not mark failed if only this post-commit transition fails. Leaving the
  // row received makes the safe retry path above finish it later.
  await markExtractedBestEffort(emails, email.id);
}

async function markExtractedBestEffort(emails: InboundEmailRepo, id: string): Promise<void> {
  try {
    await emails.markExtracted(id);
  } catch (err) {
    console.error(`[extract] drafts committed but inbound email ${id} could not be marked extracted`, err);
  }
}

function bookingsFromIcs(events: IcsEvent[]): ExtractedBooking[] {
  return events.map((event) => {
    // An operator's DESCRIPTION is where the pickup, the call time and the
    // return live; the VEVENT's own fields carry none of them. Scanned per
    // event rather than over the whole message, so a calendar with two tours
    // in it cannot attribute one's car park to the other.
    const logistics = parseActivityDetails(event.description);
    return normalizeExtractedBooking({
      kind: "other",
      title: event.summary?.trim() || "Calendar event",
      location: event.location ?? logistics.pickupLocation ?? null,
      startsAt: event.startsAt,
      startsAtTz: event.startsAtTz,
      endsAt: event.endsAt,
      endsAtTz: event.endsAtTz,
      confirmationNumber: confirmationFrom(event.description),
      costCents: null,
      details: logistics,
    });
  });
}

function confirmationFrom(description: string | null): string | null {
  if (!description) return null;
  const match = description.match(
    /\bconfirmation(?:\s+(?:number|code|no\.?|#))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  );
  return match?.[1] ?? null;
}

export async function extractBookings(
  provider: ExtractionProvider,
  email: ParsedEmail,
  extractionInstructions = "",
): Promise<ExtractedBooking[]> {
  const bookings = await provider.extract(buildExtractionPrompt(email, extractionInstructions));
  return withDeterministicFacts(
    withExcursionLogistics(bookings, email.textBody),
    email.textBody,
  );
}

/**
 * The model is useful for understanding arbitrary confirmations, but explicit
 * dates and simple return times should not depend on its mood. Preserve the
 * model's values and fill only blanks from conservative patterns.
 */
function withDeterministicFacts(
  bookings: ExtractedBooking[],
  textBody: string | null,
): ExtractedBooking[] {
  if (!textBody) return bookings;
  const lodgingDates = explicitLodgingDates(textBody);
  return bookings.map((booking) => {
    const details = asDetails(booking.details);
    if (booking.kind === "lodging" && lodgingDates) {
      if (!details.checkInDate) details.checkInDate = lodgingDates.checkInDate;
      if (!details.checkOutDate) details.checkOutDate = lodgingDates.checkOutDate;
      if (!details.nights) {
        const nights = daysBetween(lodgingDates.checkInDate, lodgingDates.checkOutDate);
        if (nights > 0) details.nights = nights;
      }
    }
    if (
      booking.kind === "activity" &&
      booking.startsAt &&
      booking.startsAtTz &&
      !booking.endsAt &&
      typeof details.returnTime === "string"
    ) {
      const endsAt = instantAtLocalTime(
        booking.startsAt,
        booking.startsAtTz,
        details.returnTime,
      );
      if (endsAt) {
        return {
          ...booking,
          endsAt,
          endsAtTz: booking.startsAtTz,
          details,
        };
      }
    }
    return { ...booking, details };
  });
}

function explicitLodgingDates(
  text: string,
): { checkInDate: string; checkOutDate: string } | null {
  const labeledIn = text.match(
    /\bcheck[\s-]*in(?:\s+(?:date|on))?\s*:?\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?[,]?\s*([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4})/i,
  );
  const labeledOut = text.match(
    /\bcheck[\s-]*out(?:\s+(?:date|on))?\s*:?\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?[,]?\s*([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4})/i,
  );
  let start = labeledIn?.[1] ? calendarDate(labeledIn[1]) : null;
  let end = labeledOut?.[1] ? calendarDate(labeledOut[1]) : null;
  if (!start || !end) {
    const range = text.match(
      /\b(?:your\s+booking|booking\s+dates?|stay)\s*:?\s*([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4})\s+(?:to|through|-)\s+([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4})/i,
    );
    start ??= range?.[1] ? calendarDate(range[1]) : null;
    end ??= range?.[2] ? calendarDate(range[2]) : null;
  }
  return start && end && start <= end
    ? { checkInDate: start, checkOutDate: end }
    : null;
}

function calendarDate(value: string): string | null {
  const cleaned = value.replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1").replace(/,/g, "");
  const parsed = new Date(`${cleaned} 12:00:00 UTC`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function asDetails(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

function instantAtLocalTime(
  startsAt: string,
  zone: string,
  wallTime: string,
): string | null {
  const match = wallTime.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  if (hour > 23 || minute > 59 || (meridiem && hour > 12)) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(startsAt));
  try {
    let result = zonedTimestampToUtc(
      `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
      zone,
    );
    if (result <= startsAt) {
      const next = new Date(`${day}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      result = zonedTimestampToUtc(
        `${next.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
        zone,
      );
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Backfills the pickup/return facts a model is free to paraphrase away, from
 * the same text it was given. Model-first: nothing it produced is overwritten
 * (see `enrichActivityDetails`).
 *
 * Applied only when the message describes exactly ONE excursion. Two tours in
 * one email share one body, and there is no reliable way to tell whose car
 * park is whose from a flat regex scan — attributing the first pickup to both
 * would be worse than attributing it to neither. Flights, stays and cars are
 * skipped outright: they have their own detail schemas and their own fields.
 */
function withExcursionLogistics(
  bookings: ExtractedBooking[],
  textBody: string | null,
): ExtractedBooking[] {
  if (!textBody) return bookings;
  const excursions = bookings.filter((b) => b.kind === "activity" || b.kind === "other");
  if (excursions.length !== 1) return bookings;
  const only = excursions[0]!;
  const details = enrichActivityDetails(only.details, textBody);
  const location =
    only.location ??
    (typeof details.pickupLocation === "string" ? details.pickupLocation : null);
  return bookings.map((booking) =>
    booking === only ? { ...booking, location, details } : booking,
  );
}

export function buildExtractionPrompt(
  email: ParsedEmail,
  extractionInstructions = "",
): { system: string; user: string } {
  const fixedRules = [
    "You read travel confirmation emails and extract the bookings they describe.",
    "Return one entry per booking. A round trip is two flights.",
    'Use kind flight, lodging, car, activity, or "other" if unsure.',
    "Return local wall-clock ISO-8601 date-times exactly as stated by the reservation, without Z or a UTC offset, plus the event location's IANA timezone.",
    "Infer the IANA timezone from the booking's own location — its airport, city, or address (BOI is America/Boise; OAK and Oakland are America/Los_Angeles). Set a timestamp and its zone to null only when the email states no date or time for it.",
    "Classify hotels, motels, lodges, vacation rentals, campgrounds, campsites, KOAs, and RV parks as lodging.",
    "Copy confirmation numbers exactly and never invent values.",
    "costCents is the total cost in cents. Charge every stated amount to exactly one booking: a round-trip fare stated once goes on the outbound flight only, with the return leg's costCents null, unless the email prices each leg separately.",
    "Extract every reservation in the email as its own booking. A payment summary or trip total line is not an extra reservation: do not add a booking for it or copy its amount onto any booking.",
    "Never omit an explicit reservation date. For lodging, extract check-in and check-out date-times when times are stated; if only dates are stated, copy YYYY-MM-DD values into details.checkInDate and details.checkOutDate.",
    "Put kind-specific facts in details. flight: carrier, flightNumber, originIata, destinationIata, cabin, seat. lodging: propertyName, address, roomType, nights, checkInDate, checkOutDate, siteNumber, siteType, campsite, product. car: vendor, pickupLocation, pickupTime, dropoffLocation, dropoffTime, vehicleClass. activity: venue, address, operator, partySize, ticketQuantity, pickupTime, pickupLocation, arriveMinutesBefore, returnTime, dropoffLocation, duration, description.",
    "For a tour, excursion, or any activity, the pickup time and the pickup location are the two most important facts in the email — always copy them into details.pickupTime and details.pickupLocation when they appear, even if they are buried in a paragraph.",
    'details.pickupTime and details.returnTime are local wall-clock times copied as written ("1:30 PM", "5:00"), not timestamps. details.arriveMinutesBefore is a whole number of minutes ("arrive 15 minutes before departure" is 15).',
    "details.description is a short summary of what the activity is, in the operator's own words.",
    "For travelerNames, copy the full names of every explicitly identified traveler, passenger, guest, or reservation holder. Names are required even when their email is absent or differs from a profile email.",
    "For travelerEmails, include only addresses explicitly associated with a traveler, passenger, guest, or reservation holder for that booking.",
    "Do not include a forwarding sender or recipient merely because they forwarded or received the message.",
  ];
  if (extractionInstructions !== "") {
    fixedRules.push(
      "",
      "--- Household notes (guidance only; fixed rules and schema still apply) ---",
      extractionInstructions,
      "--- End household notes ---",
    );
  }
  return {
    system: fixedRules.join("\n"),
    user: [
      email.subject ? `Subject: ${email.subject}` : "",
      email.from ? `From: ${email.from}` : "",
      email.textBody ? limitPromptText(email.textBody) : "(no text body)",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function providerName(ctx: ExtractionContext): "workers-ai" | "anthropic" {
  return ctx.provider?.name ?? "workers-ai";
}

function limitPromptText(text: string): string {
  if (text.length <= MAX_AI_TEXT_CHARS) return text;
  const tailChars = 6_000;
  const headChars = MAX_AI_TEXT_CHARS - tailChars;
  return [
    text.slice(0, headChars),
    "[... email text truncated for model context ...]",
    text.slice(-tailChars),
  ].join("\n");
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Extraction failed: ${message}`.slice(0, MAX_ERROR_CHARS);
}
