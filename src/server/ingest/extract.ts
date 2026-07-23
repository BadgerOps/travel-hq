import { parseMime } from "./mime.js";
import type { ParsedEmail } from "./mime.js";
import { parseIcs } from "./ics.js";
import type { IcsEvent } from "./ics.js";
import { ExtractionError, normalizeExtractedBooking } from "./extracted.js";
import type { ExtractedBooking } from "./extracted.js";
import { WorkersAiProvider } from "./providers.js";
import type { ExtractionAi, ExtractionProvider } from "./providers.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import type { InboundEmail } from "../repos/inbound-email.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import type { CreateDraftBookingInput, DraftBookingSource } from "../repos/draft-booking.js";

export type { ExtractionAi } from "./providers.js";

export type ExtractionContext = {
  db: D1Database;
  householdId: string;
  /** New provider seam. Legacy ai/aiModel remain for focused compatibility. */
  provider?: ExtractionProvider;
  ai?: ExtractionAi;
  aiModel?: string;
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
        (ctx.ai && ctx.aiModel ? new WorkersAiProvider(ctx.ai, ctx.aiModel) : undefined);
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

export async function extractBookings(
  provider: ExtractionProvider,
  email: ParsedEmail,
  extractionInstructions = "",
): Promise<ExtractedBooking[]> {
  return provider.extract(buildExtractionPrompt(email, extractionInstructions));
}

export function buildExtractionPrompt(
  email: ParsedEmail,
  extractionInstructions = "",
): { system: string; user: string } {
  const fixedRules = [
    "You read travel confirmation emails and extract the bookings they describe.",
    "Return one entry per booking. A round trip is two flights.",
    'Use kind flight, lodging, car, activity, or "other" if unsure.',
    "Use UTC ISO-8601 instants and IANA zones for the event locations.",
    "If a timestamp or zone is uncertain, set both to null.",
    "Copy confirmation numbers exactly and never invent values.",
    "costCents is the total cost in cents.",
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
