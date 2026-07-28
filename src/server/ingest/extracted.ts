import { z } from "zod";
import { BOOKING_KINDS, freeformDetails, parseDetails } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";

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
  const startOk =
    !value.startsAt ||
    (!!value.startsAtTz && isValidTimestamp(value.startsAt) && isValidTimezone(value.startsAtTz));
  const endOk =
    !value.endsAt ||
    (!!value.endsAtTz && isValidTimestamp(value.endsAt) && isValidTimezone(value.endsAtTz));

  let kind: ExtractedBooking["kind"] = value.kind;
  let details: unknown;
  try {
    details = parseDetails(value.kind, value.details ?? {});
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
    travelerEmails: normalizeTravelerEmails(value.travelerEmails),
    ...(startOk ? {} : { startsAt: null, startsAtTz: null }),
    ...(endOk ? {} : { endsAt: null, endsAtTz: null }),
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
            description: "UTC ISO-8601 instant, e.g. 2026-10-09T15:40:00.000Z",
          },
          startsAtTz: {
            type: ["string", "null"],
            description: "IANA zone for startsAt, e.g. America/Boise. Required if startsAt is set.",
          },
          endsAt: { type: ["string", "null"] },
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
