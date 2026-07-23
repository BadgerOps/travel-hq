import { parseMime } from "./mime.js";
import type { ParsedEmail } from "./mime.js";
import { parseIcs } from "./ics.js";
import type { IcsEvent } from "./ics.js";
import { EXTRACTED_JSON_SCHEMA, ExtractionError, normalizeExtractedBooking, validateExtracted } from "./extracted.js";
import type { ExtractedBooking } from "./extracted.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import type { InboundEmail } from "../repos/inbound-email.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import type { CreateDraftBookingInput, DraftBookingSource } from "../repos/draft-booking.js";
import { logEvent, errorMessage } from "../logging.js";

/**
 * The slice of the Workers AI binding extraction uses, spelled structurally
 * so tests inject `{ run: async () => ... }` and never touch a real model.
 * The real `Ai` binding (@cloudflare/workers-types) satisfies this shape.
 */
export type ExtractionAi = {
  run(
    model: string,
    inputs: {
      messages: { role: "system" | "user"; content: string }[];
      response_format: { type: "json_schema"; json_schema: unknown };
    },
  ): Promise<unknown>;
};

export type ExtractionContext = {
  db: D1Database;
  /**
   * Absent only where the [ai] binding is not bound (a stripped-down test
   * env — wrangler.toml binds it everywhere deployable). Without it the
   * model fallback cannot run: a mail with no calendar part is LEFT IN
   * `received` (still queued, extractable after a redeploy) rather than
   * failed for what is a deployment gap, not a property of the email.
   */
  ai: ExtractionAi | undefined;
  householdId: string;
  /** The Workers AI model id, from household_settings (#5). */
  aiModel: string;
};

/** Keep stored reasons short and single-purpose; #8 renders them verbatim. */
const MAX_ERROR_CHARS = 500;

/**
 * Extracts draft bookings from ONE stored `received` email (issue #6),
 * inline after ingest stores it. NEVER throws — the fail-soft contract of
 * the email() handler extends through here:
 *
 * 1. `.ics`-first: a calendar attachment is structured and states a real
 *    IANA zone per endpoint, so it is authoritative and the model is never
 *    consulted. Every VEVENT becomes one draft.
 * 2. Workers AI fallback: no usable calendar part → the model reads the
 *    message under JSON Mode, constrained to EXTRACTED_JSON_SCHEMA, with the
 *    model id from household settings.
 * 3. Drafts are written all-or-nothing (DraftBookingRepo.createMany is one
 *    D1 batch) and only after the WHOLE response validated — a malformed or
 *    empty response writes no partial drafts. Then received → extracted.
 *    Any error instead marks received → failed with a readable reason.
 *
 * Drafts are written before markExtracted, not after: if the transition
 * itself failed, an `extracted` email with zero drafts would lie to the
 * review UI, while a `received` email with drafts is merely surprising.
 */
export async function extractInboundEmail(ctx: ExtractionContext, email: InboundEmail): Promise<void> {
  const emails = InboundEmailRepo.forIngest(ctx.db, ctx.householdId);
  const drafts = DraftBookingRepo.forIngest(ctx.db, ctx.householdId);

  try {
    const parsed = parseMime(email.raw);

    let bookings: ExtractedBooking[];
    let source: DraftBookingSource;
    const events = parsed.calendars.flatMap((text) => parseIcs(text));
    if (events.length > 0) {
      bookings = bookingsFromIcs(events);
      source = "ics";
    } else {
      if (!ctx.ai) {
        logEvent("email_ingest", {
          outcome: "left_queued",
          householdId: ctx.householdId,
          emailId: email.id,
          reason: "no AI binding and no calendar part; the row stays received",
        });
        return;
      }
      bookings = await runModel(ctx.ai, ctx.aiModel, parsed);
      source = "ai";
    }

    const inputs: CreateDraftBookingInput[] = bookings.map((booking) => ({
      inboundEmailId: email.id,
      kind: booking.kind,
      title: booking.title,
      location: booking.location ?? null,
      startsAt: booking.startsAt ?? null,
      startsAtTz: booking.startsAtTz ?? null,
      endsAt: booking.endsAt ?? null,
      endsAtTz: booking.endsAtTz ?? null,
      confirmationNumber: booking.confirmationNumber ?? null,
      source,
      extracted: booking,
    }));

    await drafts.createMany(inputs);
    await emails.markExtracted(email.id);
    // The one terminal outcome line for a message that made it all the way
    // (#8): ingest itself stays silent on the received→ path so each inbound
    // email logs exactly one outcome. Counts and ids only — never subjects,
    // addresses, or extracted values.
    logEvent("email_ingest", {
      outcome: "extracted",
      householdId: ctx.householdId,
      emailId: email.id,
      source,
      drafts: inputs.length,
    });
  } catch (err) {
    const reason = describeError(err);
    logEvent("email_ingest", {
      outcome: "extraction_failed",
      householdId: ctx.householdId,
      emailId: email.id,
      reason,
    });
    try {
      await emails.markFailed(email.id, reason);
    } catch (markErr) {
      // Best-effort by contract: the email row simply stays `received`.
      logEvent("email_ingest_error", {
        householdId: ctx.householdId,
        emailId: email.id,
        reason: `could not mark the row failed: ${errorMessage(markErr)}`,
      });
    }
  }
}

/**
 * VEVENTs → validated bookings. Kind is genuinely unknown from a VEVENT — a
 * calendar invite does not say "this is a flight" — so drafts arrive as
 * `other` and the reviewer reclassifies in one click (#7); guessing from the
 * summary text would be the model's job, done badly, with no model.
 * Runs through the same normalization funnel as model output.
 */
function bookingsFromIcs(events: IcsEvent[]): ExtractedBooking[] {
  return events.map((event) =>
    normalizeExtractedBooking({
      kind: "other",
      title: event.summary && event.summary.trim() !== "" ? event.summary : "Calendar event",
      location: event.location,
      startsAt: event.startsAt,
      startsAtTz: event.startsAtTz,
      endsAt: event.endsAt,
      endsAtTz: event.endsAtTz,
      confirmationNumber: confirmationFrom(event.description),
      details: {},
    }),
  );
}

/**
 * Best-effort confirmation number from a VEVENT's DESCRIPTION — airlines and
 * hotels commonly write "Confirmation number: ABC123" there. Absence is
 * fine; inventing one is not, so the match is deliberately narrow.
 */
function confirmationFrom(description: string | null): string | null {
  if (!description) return null;
  const match = description.match(/\bconfirmation(?:\s+(?:number|code|no\.?|#))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  return match?.[1] ?? null;
}

/**
 * The Workers AI JSON-Mode call. The schema constrains decoding; Zod
 * (validateExtracted) still validates the result, because constrained
 * decoding guarantees shape, not correctness — and a stubbed binding in
 * tests guarantees neither.
 */
async function runModel(ai: ExtractionAi, model: string, email: ParsedEmail): Promise<ExtractedBooking[]> {
  const prompt = buildExtractionPrompt(email);
  const result = await ai.run(model, {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    response_format: { type: "json_schema", json_schema: EXTRACTED_JSON_SCHEMA },
  });
  return validateExtracted(modelPayload(result));
}

/**
 * Unwraps `{ response }` from an Ai.run result. Under JSON Mode the response
 * arrives as the decoded object; some models return the JSON as a string —
 * both are accepted, anything else is a malformed response and fails the
 * email (never partial drafts).
 */
function modelPayload(result: unknown): unknown {
  if (result !== null && typeof result === "object" && "response" in result) {
    const response = (result as { response: unknown }).response;
    if (typeof response === "string") {
      try {
        return JSON.parse(response) as unknown;
      } catch {
        throw new ExtractionError("The model response was not valid JSON");
      }
    }
    if (response !== null && response !== undefined) return response;
  }
  throw new ExtractionError("The model returned no response");
}

/**
 * One prompt for the one model path. Written for a small model: short,
 * concrete, and leaning on the constrained JSON schema to carry the shape
 * rather than describing the shape in prose.
 */
export function buildExtractionPrompt(email: ParsedEmail): { system: string; user: string } {
  return {
    system: [
      "You read travel confirmation emails and extract the bookings they describe.",
      "",
      "Rules:",
      "- Return one entry per booking. A round trip is two flights, not one.",
      '- kind is one of: flight, lodging, car, activity, other. Use "other" if unsure.',
      "- startsAt and endsAt are UTC ISO-8601 instants. Convert from the local time in the email.",
      "- startsAtTz and endsAtTz are IANA zone names for the LOCATION OF THE EVENT",
      "  (a departure uses the departure airport's zone, an arrival the arrival airport's).",
      "- If you cannot work out the zone, set both the timestamp and the zone to null.",
      "  A booking with no time is useful; a booking with the wrong time is not.",
      "- costCents is the total in cents: $612.40 is 61240.",
      "- Copy the confirmation number exactly. Do not invent one.",
      "- details carries kind-specific fields: flight needs carrier, flightNumber,",
      "  originIata, destinationIata; lodging needs propertyName; car needs vendor.",
      "- Never guess a value to fill a field. Null is a correct answer.",
    ].join("\n"),
    user: [
      email.subject ? `Subject: ${email.subject}` : "",
      email.from ? `From: ${email.from}` : "",
      "",
      email.textBody ?? "(no text body)",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  };
}

function describeError(err: unknown): string {
  return `Extraction failed: ${errorMessage(err)}`.slice(0, MAX_ERROR_CHARS);
}
