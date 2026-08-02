import { z } from "zod";

const iata = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase());

export const flightDetails = z.object({
  carrier: z.string().min(1),
  flightNumber: z.string().min(1),
  originIata: iata,
  destinationIata: iata,
  cabin: z.string().optional(),
  seat: z.string().optional(),
}).passthrough();

export const lodgingDetails = z.object({
  propertyName: z.string().min(1),
  address: z.string().optional(),
  roomType: z.string().optional(),
  nights: z.number().int().positive().optional(),
  /** Date-only fallbacks when a confirmation states the stay dates but not a clock time. */
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).passthrough();

export const carDetails = z.object({
  vendor: z.string().min(1),
  pickupLocation: z.string().optional(),
  pickupTime: z.string().optional(),
  dropoffLocation: z.string().optional(),
  dropoffTime: z.string().optional(),
  vehicleClass: z.string().optional(),
}).passthrough();

/**
 * An excursion is not a restaurant booking: what the family needs on the
 * morning of a Red Bus tour is the pickup time, the car park it leaves from,
 * how early to be standing there, and roughly when they are back — none of
 * which fit `venue`/`address`.
 *
 * These are strings, not timestamps, on purpose. "Approximate return time:
 * 5:00" is an operator's estimate printed in local wall-clock time with no
 * date and often no meridiem; promoting it to an instant would mean inventing
 * a date and a zone, and `endsAt` is where a real one belongs. They are
 * displayed verbatim (see the client's ExcursionLogistics) and never fed to
 * the itinerary.
 *
 * `pickupTime`/`pickupLocation` are named to match `carDetails`, so the same
 * "where do I collect the thing" idea reads the same way in both.
 */
export const activityDetails = z.object({
  venue: z.string().optional(),
  address: z.string().optional(),
  partySize: z.number().int().positive().optional(),
  operator: z.string().optional(),
  pickupTime: z.string().optional(),
  pickupLocation: z.string().optional(),
  /** "Please arrive 15 minutes before departure" -> 15. */
  arriveMinutesBefore: z.number().int().nonnegative().max(720).optional(),
  returnTime: z.string().optional(),
  dropoffLocation: z.string().optional(),
  duration: z.string().optional(),
  description: z.string().optional(),
  notes: z.string().optional(),
}).passthrough();

/** Anything not modeled yet. The escape hatch that makes the JSON column worth having. */
export const freeformDetails = z.record(z.string(), z.unknown());

const SCHEMAS = {
  flight: flightDetails,
  lodging: lodgingDetails,
  car: carDetails,
  activity: activityDetails,
} as const;

export const BOOKING_KINDS = ["flight", "lodging", "car", "activity", "other"] as const;

export type BookingKind = (typeof BOOKING_KINDS)[number];

/**
 * Written out rather than derived from `Object.keys(SCHEMAS)`, because
 * `Object.keys` is typed `string[]` and erases the literals before `as const`
 * can preserve them — which silently degrades every `z.enum(BOOKING_KINDS)`
 * to `z.enum(string[])`, inferring `kind: string`.
 *
 * The cost of writing it out is that this list and SCHEMAS could drift. The
 * line below makes that a typecheck failure: every key of SCHEMAS must be a
 * BookingKind. (The reverse does not hold and must not — `other` is the
 * freeform escape hatch and deliberately has no per-kind schema.)
 */
const _schemasAreKinds: Record<keyof typeof SCHEMAS, BookingKind> = {
  flight: "flight",
  lodging: "lodging",
  car: "car",
  activity: "activity",
};
void _schemasAreKinds;

/**
 * The `details` an imported draft is committed with — the extractor's record
 * plus the one repair the import path has always made for it.
 *
 * `lodgingDetails.propertyName` is required, and a confirmation email that
 * says "St. Mary / East Glacier KOA Holiday" in its subject and nowhere else
 * frequently produces a draft whose title is the property and whose details
 * are not. Refusing the import over that would be absurd, so the title stands
 * in — spread FIRST so a propertyName the extractor (or a reviewer) did supply
 * always wins.
 *
 * It lives in this module, beside the schemas it feeds, because two callers
 * now need to agree about it: `ImportReviewRepo` applies it at commit time,
 * and `DraftBookingRepo.update` applies it when validating an edited draft. If
 * the edit validated the raw record while the commit validated the repaired
 * one, a lodging edit that only changed the check-out date would be rejected
 * for a missing propertyName the accept was about to supply anyway.
 */
export function importedDetails(kind: string, title: string, value: unknown): unknown {
  const details =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (kind !== "lodging") return details;
  return {
    propertyName:
      typeof details.propertyName === "string" && details.propertyName.trim() !== ""
        ? details.propertyName
        : title,
    ...details,
  };
}

export function parseDetails(kind: string, details: unknown): unknown {
  const schema = SCHEMAS[kind as keyof typeof SCHEMAS];
  return schema ? schema.parse(withoutNullOptionals(details)) : freeformDetails.parse(details);
}

/**
 * Constrained extractors and older imports often represented an absent
 * optional value as null. Our kind schemas use optional fields, where absence
 * is valid but null is not. Normalize those top-level null placeholders away
 * before validation; a required null is still rejected because removing it
 * leaves the required field missing.
 */
function withoutNullOptionals(details: unknown): unknown {
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return details;
  }
  return Object.fromEntries(
    Object.entries(details as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined),
  );
}
