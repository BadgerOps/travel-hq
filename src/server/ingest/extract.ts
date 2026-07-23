import { parseMime } from "./mime.js";
import type { ParsedEmail } from "./mime.js";
import { parseIcs } from "./ics.js";
import type { IcsEvent } from "./ics.js";
import {
  EXTRACTED_JSON_SCHEMA,
  ExtractionError,
  normalizeExtractedBooking,
  validateExtracted,
} from "./extracted.js";
import type { ExtractedBooking } from "./extracted.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import type { InboundEmail } from "../repos/inbound-email.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import type { CreateDraftBookingInput, DraftBookingSource } from "../repos/draft-booking.js";

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
  ai: ExtractionAi | undefined;
  householdId: string;
  aiModel: string;
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
      if (!ctx.ai) {
        console.warn(
          `[extract] no AI binding and no calendar part; leaving inbound email ${email.id} queued as received`,
        );
        return;
      }
      bookings = await runModel(ctx.ai, ctx.aiModel, parsed);
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
      extracted: booking,
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
  return events.map((event) =>
    normalizeExtractedBooking({
      kind: "other",
      title: event.summary?.trim() || "Calendar event",
      location: event.location,
      startsAt: event.startsAt,
      startsAtTz: event.startsAtTz,
      endsAt: event.endsAt,
      endsAtTz: event.endsAtTz,
      confirmationNumber: confirmationFrom(event.description),
      costCents: null,
      details: {},
    }),
  );
}

function confirmationFrom(description: string | null): string | null {
  if (!description) return null;
  const match = description.match(
    /\bconfirmation(?:\s+(?:number|code|no\.?|#))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  );
  return match?.[1] ?? null;
}

async function runModel(
  ai: ExtractionAi,
  model: string,
  email: ParsedEmail,
): Promise<ExtractedBooking[]> {
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

export function buildExtractionPrompt(email: ParsedEmail): { system: string; user: string } {
  return {
    system: [
      "You read travel confirmation emails and extract the bookings they describe.",
      "Return one entry per booking. A round trip is two flights.",
      'Use kind flight, lodging, car, activity, or "other" if unsure.',
      "Use UTC ISO-8601 instants and IANA zones for the event locations.",
      "If a timestamp or zone is uncertain, set both to null.",
      "Copy confirmation numbers exactly and never invent values.",
      "costCents is the total cost in cents.",
    ].join("\n"),
    user: [
      email.subject ? `Subject: ${email.subject}` : "",
      email.from ? `From: ${email.from}` : "",
      email.textBody ? limitPromptText(email.textBody) : "(no text body)",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
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
