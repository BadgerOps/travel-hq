import { z } from "zod";
import { BOOKING_KINDS, freeformDetails, parseDetails } from "../schemas/booking-kinds.js";
import {
  isValidInstant,
  isValidTimezone,
  zonedTimestampToUtc,
} from "../time.js";

export class ExtractionError extends Error {}

const extractedBookingSchema = z.object({
  kind: z.enum(BOOKING_KINDS),
  title: z.string().trim().min(1),
  location: z.string().nullish(),
  startsAt: z.string().nullish(),
  startsAtTz: z.string().nullish(),
  endsAt: z.string().nullish(),
  endsAtTz: z.string().nullish(),
  confirmationNumber: z.string().nullish(),
  costCents: z.number().nullish(),
  travelerNames: z.array(z.string()).max(50).optional(),
  travelerEmails: z.array(z.string()).max(50).optional(),
  details: z.unknown().optional(),
});

export type ExtractedBooking = z.infer<typeof extractedBookingSchema>;
const responseSchema = z.object({ bookings: z.array(z.unknown()) });

/**
 * Normalize fields that are useful but unsafe to persist as emitted. Invalid
 * timestamp/zone pairs are dropped together; invalid kind-specific details
 * degrade to `other`. Invalid base shapes still reject the whole response.
 */
export function normalizeExtractedBooking(raw: unknown): ExtractedBooking {
  const parsed = extractedBookingSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    throw new ExtractionError(`Extracted booking failed validation${where}: ${issue?.message ?? "invalid"}`);
  }
  const value = parsed.data;
  const startsAt = normalizeInstant(value.startsAt, value.startsAtTz);
  const normalizedEndsAt = normalizeInstant(value.endsAt, value.endsAtTz);
  // An end before its start is the extractor misreading a return leg or
  // carrying yesterday's date onto the arrival, never a fact about the
  // reservation. Dropped here, at the funnel, so the inverted pair never
  // becomes a draft: the review queue has no way to edit a draft's times, so a
  // draft that no write path will accept is a draft the reviewer can only
  // dismiss. The start is the half worth keeping — it is what the day view
  // groups on.
  const endsAt =
    startsAt !== null &&
    normalizedEndsAt !== null &&
    Date.parse(normalizedEndsAt) < Date.parse(startsAt)
      ? null
      : normalizedEndsAt;

  let kind: ExtractedBooking["kind"] = inferredKind(value);
  let details: unknown;
  try {
    details = parseDetails(kind, detailsForKind(kind, value));
  } catch {
    kind = "other";
    try {
      details = freeformDetails.parse(value.details ?? {});
    } catch {
      details = {};
    }
  }

  return {
    ...value,
    kind,
    startsAt,
    startsAtTz: startsAt ? value.startsAtTz : null,
    endsAt,
    endsAtTz: endsAt ? value.endsAtTz : null,
    travelerNames: normalizeTravelerNames(value.travelerNames),
    travelerEmails: normalizeTravelerEmails(value.travelerEmails),
    // Negative joins non-integer and absent in the "not a usable cost" bucket:
    // a minus sign here is the model reading a refund, a credit, or a discount
    // line as the reservation total, and the repositories reject negative
    // amounts outright (see assertNonNegativeAmount in repos/validation.ts for
    // why spend is not a signed ledger). Dropping it at the funnel keeps the
    // booking importable with no price rather than unimportable with a wrong
    // one.
    costCents:
      value.costCents === undefined ||
      value.costCents === null ||
      !Number.isInteger(value.costCents) ||
      value.costCents < 0
        ? null
        : value.costCents,
    details,
  };
}

export function validateExtracted(raw: unknown): ExtractedBooking[] {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExtractionError('The model response was not an object of the form { "bookings": [...] }');
  }
  const bookings = parsed.data.bookings.map(normalizeExtractedBooking);
  if (bookings.length === 0) throw new ExtractionError("The model found no bookings in this email");
  return bookings;
}

/**
 * Single schema contract for Workers AI constrained JSON output. Every
 * declared property is required; unknown values are represented by null.
 */
export const EXTRACTED_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bookings"],
  properties: {
    bookings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "title",
          "location",
          "startsAt",
          "startsAtTz",
          "endsAt",
          "endsAtTz",
          "confirmationNumber",
          "costCents",
          "travelerNames",
          "travelerEmails",
          "details",
        ],
        properties: {
          kind: { type: "string", enum: [...BOOKING_KINDS] },
          title: { type: "string" },
          location: { type: ["string", "null"] },
          startsAt: {
            type: ["string", "null"],
            description:
              "Local ISO-8601 wall time as stated by the reservation, without Z or an offset, e.g. 2026-10-09T09:40:00",
          },
          startsAtTz: {
            type: ["string", "null"],
            description: "IANA zone for startsAt, e.g. America/Boise. Required if startsAt is set.",
          },
          endsAt: {
            type: ["string", "null"],
            description:
              "Local ISO-8601 wall time as stated by the reservation, without Z or an offset",
          },
          endsAtTz: { type: ["string", "null"] },
          confirmationNumber: { type: ["string", "null"] },
          costCents: { type: ["integer", "null"], description: "Total cost in cents" },
          travelerNames: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            description:
              "Full names explicitly identified as travelers, guests, passengers, or reservation holders",
          },
          travelerEmails: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            description:
              "Email addresses explicitly associated with a traveler, passenger, guest, or reservation holder for this booking",
          },
          details: {
            type: "object",
            additionalProperties: true,
            description:
              "Kind-specific facts. flight: carrier, flightNumber, originIata, destinationIata, cabin, seat. " +
              "lodging: propertyName, address, roomType, nights, checkInDate, checkOutDate. " +
              "car: vendor, pickupLocation, pickupTime, dropoffLocation, dropoffTime, vehicleClass. " +
              "activity: venue, address, operator, partySize, pickupTime, pickupLocation, " +
              "arriveMinutesBefore (whole minutes), returnTime, dropoffLocation, duration, description. " +
              'pickupTime/returnTime are local wall-clock times copied as written ("1:30 PM").',
          },
        },
      },
    },
  },
} as const;

function normalizeTravelerEmails(values: string[] | undefined): string[] {
  const emails = new Set<string>();
  for (const value of values ?? []) {
    const email = value.trim().toLowerCase();
    if (z.email().safeParse(email).success) emails.add(email);
  }
  return [...emails];
}

function normalizeTravelerNames(values: string[] | undefined): string[] {
  const names = new Set<string>();
  for (const value of values ?? []) {
    const name = value.replace(/\s+/g, " ").trim();
    if (name !== "") names.add(name);
  }
  return [...names];
}

/**
 * Canonicalizes whatever the model emitted into the one form the repositories
 * accept: a UTC instant with an explicit `Z`.
 *
 * Both branches end in `toISOString()`, which is what keeps this funnel
 * compatible with the tightened `isValidInstant` — the models are asked (see
 * EXTRACTED_JSON_SCHEMA) for a local wall time with no offset, which takes the
 * `zonedTimestampToUtc` branch and comes back canonical, and an offset-bearing
 * instant emitted anyway is re-emitted as UTC rather than stored as written.
 * Nothing downstream ever sees the model's own spelling, so tightening the
 * validator cannot start rejecting extractions that used to import.
 *
 * A value neither branch can make sense of becomes `null` — an absent time on
 * a draft the reviewer can still see and accept, rather than an extraction
 * error that discards the whole booking.
 */
function normalizeInstant(
  value: string | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (!value || !timeZone || !isValidTimezone(timeZone)) return null;
  if (isValidInstant(value)) return new Date(value).toISOString();
  try {
    return zonedTimestampToUtc(value, timeZone);
  } catch {
    return null;
  }
}

function inferredKind(value: z.infer<typeof extractedBookingSchema>): ExtractedBooking["kind"] {
  if (value.kind !== "other") return value.kind;
  const haystack = [
    value.title,
    value.location ?? "",
    JSON.stringify(value.details ?? {}),
  ].join(" ").toLowerCase();
  if (
    /\b(?:rv park|campground|camp site|campsite|koa|hotel|motel|lodge|lodging|resort|hostel|vacation rental)\b/
      .test(haystack)
  ) {
    return "lodging";
  }
  if (
    /\b(?:tour|excursion|cruise|boat|hike|guided|guide|admission|ticket|attraction|museum|show)\b/
      .test(haystack)
  ) {
    return "activity";
  }
  return value.kind;
}

function detailsForKind(
  kind: ExtractedBooking["kind"],
  value: z.infer<typeof extractedBookingSchema>,
): unknown {
  const details =
    value.details !== null && typeof value.details === "object" && !Array.isArray(value.details)
      ? Object.fromEntries(
          Object.entries(value.details as Record<string, unknown>)
            // Constrained model output commonly emits null for optional known
            // fields. Zod's optional() means absent, not null; dropping nulls
            // keeps one empty address from degrading a clearly named RV park
            // back to "other".
            .filter(([, detail]) => detail !== null && detail !== undefined),
        )
      : {};
  if (kind === "activity") {
    for (const key of ["pickupLocation", "dropoffLocation"] as const) {
      const location = details[key];
      if (
        typeof location === "string" &&
        /\b(?:polic(?:y|ies)|terms|cancellations?|refunds?|reservation\(s\)|following applies)\b/i
          .test(location)
      ) {
        delete details[key];
      }
    }
  }
  if (kind === "lodging") {
    return {
      propertyName:
        typeof details.propertyName === "string" && details.propertyName.trim() !== ""
          ? details.propertyName
          : value.title,
      ...details,
    };
  }
  return details;
}
