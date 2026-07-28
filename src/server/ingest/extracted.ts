import { z } from "zod";
import { BOOKING_KINDS, freeformDetails, parseDetails } from "../schemas/booking-kinds.js";
import {
  isValidTimestamp,
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
  const endsAt = normalizeInstant(value.endsAt, value.endsAtTz);

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
    travelerEmails: normalizeTravelerEmails(value.travelerEmails),
    costCents:
      value.costCents === undefined || value.costCents === null || !Number.isInteger(value.costCents)
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
              "lodging: propertyName, address, roomType, nights. " +
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

function normalizeInstant(
  value: string | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (!value || !timeZone || !isValidTimezone(timeZone)) return null;
  if (isValidTimestamp(value)) return new Date(value).toISOString();
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
  return /\b(?:rv park|campground|camp site|campsite|koa|hotel|motel|lodge|lodging|resort|hostel|vacation rental)\b/
      .test(haystack)
    ? "lodging"
    : value.kind;
}

function detailsForKind(
  kind: ExtractedBooking["kind"],
  value: z.infer<typeof extractedBookingSchema>,
): unknown {
  const details =
    value.details !== null && typeof value.details === "object" && !Array.isArray(value.details)
      ? value.details as Record<string, unknown>
      : {};
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
