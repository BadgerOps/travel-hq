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
});

export const lodgingDetails = z.object({
  propertyName: z.string().min(1),
  address: z.string().optional(),
  roomType: z.string().optional(),
  nights: z.number().int().positive().optional(),
});

export const carDetails = z.object({
  vendor: z.string().min(1),
  pickupLocation: z.string().optional(),
  dropoffLocation: z.string().optional(),
  vehicleClass: z.string().optional(),
});

export const activityDetails = z.object({
  venue: z.string().optional(),
  address: z.string().optional(),
  partySize: z.number().int().positive().optional(),
});

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

export function parseDetails(kind: string, details: unknown): unknown {
  const schema = SCHEMAS[kind as keyof typeof SCHEMAS];
  return schema ? schema.parse(details) : freeformDetails.parse(details);
}
