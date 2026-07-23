import { z } from "zod";
import { BOOKING_KINDS, freeformDetails, parseDetails } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";

/**
 * Extraction produced nothing a draft can be made from: a response that is
 * not the schema's shape, a booking that fails validation, or an empty
 * booking list. The pipeline (extract.ts) catches this and marks the email
 * `failed` with the message — which is written for the owner to read (#8),
 * so keep messages short and concrete.
 */
export class ExtractionError extends Error {}

/**
 * What extraction produces per booking, whatever produced it (.ics or the
 * model). Deliberately the subset of a booking a parser can honestly know:
 * no tripId (a human picks the trip in #7) and no status (review decides).
 *
 * ALL-OR-NOTHING at the response level: validateExtracted THROWS on the
 * first booking that fails this schema rather than dropping it, because the
 * pipeline's contract (issue #6) is that a bad model response writes no
 * partial drafts. Within a valid booking, two fields degrade softly instead
 * of failing the response — see normalizeExtractedBooking.
 */
const extractedBookingSchema = z.object({
  kind: z.enum(BOOKING_KINDS),
  title: z.string().trim().min(1),
  location: z.string().nullish(),
  startsAt: z.string().nullish(),
  startsAtTz: z.string().nullish(),
  endsAt: z.string().nullish(),
  endsAtTz: z.string().nullish(),
  confirmationNumber: z.string().nullish(),
  // Validated as "a number" here; non-integers degrade to null in
  // normalizeExtractedBooking rather than failing the whole response —
  // rounding invented money and rejecting lost the booking.
  costCents: z.number().nullish(),
  details: z.unknown().optional(),
});

export type ExtractedBooking = z.infer<typeof extractedBookingSchema>;

/** The envelope shape the model is constrained to (EXTRACTED_JSON_SCHEMA). */
const responseSchema = z.object({ bookings: z.array(z.unknown()) });

/**
 * Validates and normalizes ONE extracted booking. Throws ExtractionError if
 * the base shape is wrong (that is a bad extraction, not a fixable field).
 * Two degradations are field-level, deliberate, and soft:
 *
 * - A timestamp missing its zone, unparseable, or in an unknown zone drops
 *   the PAIR to null rather than the booking: the title and confirmation
 *   number are still worth a reviewer's time, and a stored unparseable
 *   timestamp would brick the day view forever (see ItineraryRepo).
 * - Per-kind details that fail their schema (a "flight" with no carrier)
 *   degrade the booking to kind "other" with freeform details rather than
 *   dropping it. The model's full output is preserved on the draft
 *   (extracted_json), and the reviewer fixes the kind in one click in #7 —
 *   losing the whole email over one missing detail field serves nobody.
 */
export function normalizeExtractedBooking(raw: unknown): ExtractedBooking {
  const parsed = extractedBookingSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
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
    // The same per-kind Zod schemas the booking route enforces — the single
    // funnel that stops extraction from widening what can enter the system.
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
    ...(startOk ? {} : { startsAt: null, startsAtTz: null }),
    ...(endOk ? {} : { endsAt: null, endsAtTz: null }),
    costCents:
      value.costCents === undefined || value.costCents === null || !Number.isInteger(value.costCents)
        ? null
        : value.costCents,
    details,
  };
}

/**
 * Validates a whole model response against the extraction contract. Throws
 * ExtractionError — never returns a partial list — when the envelope is not
 * `{ bookings: [...] }`, when ANY booking fails the base schema, or when the
 * list is empty (an email the model read and found nothing in needs a human,
 * not a silent extracted-with-no-drafts state).
 */
export function validateExtracted(raw: unknown): ExtractedBooking[] {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExtractionError('The model response was not an object of the form { "bookings": [...] }');
  }
  const bookings = parsed.data.bookings.map(normalizeExtractedBooking);
  if (bookings.length === 0) {
    throw new ExtractionError("The model found no bookings in this email");
  }
  return bookings;
}

/**
 * The JSON Schema handed to Workers AI JSON Mode
 * (`response_format: { type: "json_schema", json_schema: ... }`) — the
 * single source of truth for the model contract. It mirrors the Zod schema
 * above; constrained decoding means the model cannot emit a shape outside
 * it, which is what makes a small model viable here at all. Zod still
 * validates the result — constrained decoding guarantees shape, not
 * correctness, and a fake AI binding in tests guarantees neither.
 *
 * STRICT-MODE DISCIPLINE: every key in `properties` MUST appear in
 * `required`. Schema-constrained decoders reject (or silently ignore — far
 * worse) a schema whose `required` omits any declared property when
 * `additionalProperties: false` is set. Optionality is expressed by the
 * `["string","null"]` unions, matching the Zod side's `.nullish()`, so
 * "I could not work this out" stays expressible as null. A test asserts
 * this recursively; keep it green.
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
          details: { type: "object", additionalProperties: true },
        },
      },
    },
  },
} as const;
