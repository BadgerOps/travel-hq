import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../index.js";
import { normalizeExtractedBooking } from "../ingest/extracted.js";
import type { ExtractedBooking } from "../ingest/extracted.js";
import { extractInboundEmail } from "../ingest/extract.js";
import { resolveExtractionProvider } from "../ingest/providers.js";
import type { ExtractionProvider } from "../ingest/providers.js";
import { parseMime } from "../ingest/mime.js";
import { MAX_RAW_BYTES } from "../ingest.js";
import { ForbiddenError, NotFoundError } from "../repos/base.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import { HouseholdSettingsRepo } from "../repos/household-settings.js";
import { InboundEmailRepo, rawUnavailableReason } from "../repos/inbound-email.js";
import type { InboundEmail, InboundEmailStatus } from "../repos/inbound-email.js";
import { ImportReviewRepo } from "../repos/import-review.js";
import type { CreateTripFromDraftsInput } from "../repos/import-review.js";
import { isValidCalendarDate } from "../time.js";

export const MAX_IMPORT_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_EML_BYTES = MAX_RAW_BYTES;
const MAX_CONVERTED_TEXT_CHARS = 250_000;
const FILE_IMPORT_ADDRESS = "file-import@travel-hq.invalid";
type ImportFileKind = "pdf" | "eml";

export type FileImportResult = {
  inboundEmailId: string;
  status: Extract<InboundEmailStatus, "received" | "extracted" | "failed">;
  error: string | null;
  bookings: ExtractedBooking[];
};

export const imports = new Hono<AppEnv>();

/**
 * Age out this household's expired raw mail, best-effort.
 *
 * This Worker has no cron trigger, so the purge has to ride along on paths
 * that already run. Import review is the natural second host after ingest:
 * accepting or dismissing a draft is precisely the moment the reviewer is
 * finished with the message it came from, and it is already a write by a
 * household member. Failures are logged and swallowed — a sweep that could
 * fail the accept it is attached to would trade a real user action for a
 * housekeeping chore.
 */
async function sweepExpiredRaw(emails: InboundEmailRepo): Promise<void> {
  try {
    const purged = await emails.purgeExpiredRaw();
    if (purged.length > 0) {
      console.info(`[import] purged raw from ${purged.length} expired inbound email(s)`);
    }
  } catch (err) {
    console.error("[import] retention sweep failed", err);
  }
}

const draftIdsSchema = z.array(z.string().min(1)).min(1).max(100);
// `allowDuplicates` must be sent deliberately on the retry, never defaulted:
// the 409 it answers exists because silently importing a second copy is what
// filled the trip with duplicates to begin with.
const acceptSchema = z.object({
  draftIds: draftIdsSchema,
  tripId: z.string().min(1),
  allowDuplicates: z.boolean().optional(),
}).strict();
const dismissSchema = z.object({ draftIds: draftIdsSchema }).strict();
const createTripFromDraftsSchema = z.object({
  draftIds: draftIdsSchema,
  title: z.string().trim().min(1),
  destination: z.string().trim().optional(),
  startsOn: z.string().refine(isValidCalendarDate).optional(),
  endsOn: z.string().refine(isValidCalendarDate).optional(),
  allowDuplicates: z.boolean().optional(),
}).strict().refine(
  (value) => !value.startsOn || !value.endsOn || value.startsOn <= value.endsOn,
  { message: "startsOn must be on or before endsOn", path: ["endsOn"] },
);

imports.get("/pending", async (c) =>
  c.json(
    await new ImportReviewRepo(
      c.get("db"),
      c.get("identity"),
      c.get("ring"),
    ).listPending(),
  ),
);

imports.post("/accept", async (c) => {
  const parsed = acceptSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) {
    return c.json({ error: "Invalid import acceptance", details: parsed.error.issues }, 400);
  }
  // A draft that repeats a booking already on the trip throws ConflictError
  // (409) here, which app.onError surfaces with its message so the reviewer
  // can retry with allowDuplicates.
  const result = await new ImportReviewRepo(c.get("db"), c.get("identity"), c.get("ring"))
    .acceptIntoTrip(
      parsed.data.draftIds,
      parsed.data.tripId,
      parsed.data.allowDuplicates ?? false,
    );
  // After the accept, never before: the sweep must not be able to delete the
  // message a failing accept would want re-read.
  await sweepExpiredRaw(new InboundEmailRepo(c.get("db"), c.get("identity"), c.get("ring")));
  return c.json(result);
});

imports.post("/create-trip", async (c) => {
  const parsed = createTripFromDraftsSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) {
    return c.json({ error: "Invalid imported trip", details: parsed.error.issues }, 400);
  }
  const created = await new ImportReviewRepo(c.get("db"), c.get("identity"), c.get("ring"))
    .createTripFromDrafts(parsed.data satisfies CreateTripFromDraftsInput);
  await sweepExpiredRaw(new InboundEmailRepo(c.get("db"), c.get("identity"), c.get("ring")));
  return c.json(created, 201);
});

imports.post("/dismiss", async (c) => {
  const parsed = dismissSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) {
    return c.json({ error: "Invalid import dismissal", details: parsed.error.issues }, 400);
  }
  const dismissedDraftIds = await new ImportReviewRepo(
    c.get("db"),
    c.get("identity"),
    c.get("ring"),
  ).dismiss(parsed.data.draftIds);
  await sweepExpiredRaw(new InboundEmailRepo(c.get("db"), c.get("identity"), c.get("ring")));
  return c.json({ dismissedDraftIds });
});

imports.post("/file", async (c) => {
  let body: FormData;
  try {
    body = await c.req.formData();
  } catch {
    return c.json({ error: "Expected a multipart form upload" }, 400);
  }

  const file = body.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Choose a PDF or EML file to import" }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: "The selected file is empty" }, 400);
  }
  const kind = importFileKind(file);
  if (!kind) {
    return c.json({ error: "Only PDF and EML files can be imported" }, 415);
  }
  const maxBytes = kind === "pdf" ? MAX_IMPORT_PDF_BYTES : MAX_IMPORT_EML_BYTES;
  if (file.size > maxBytes) {
    return c.json({
      error:
        kind === "pdf"
          ? "PDF files must be 10 MiB or smaller"
          : "EML files must be 1 MB or smaller",
    }, 413);
  }

  const identity = c.get("identity");
  const settingsRepo = new HouseholdSettingsRepo(c.get("db"), identity, c.get("ring"));
  const configured = await settingsRepo.getIngestSettings();
  const provider = await resolveExtractionProvider({
    settings: configured,
    ai: c.env.AI,
    ring: c.get("ring"),
    anthropicClientFactory: c.get("anthropicClientFactory"),
    logContext: `file import for household ${identity.householdId}`,
  });
  if (!provider) {
    return c.json({ error: "The configured extraction provider is unavailable" }, 503);
  }

  const to = configured.forwardAddress ?? FILE_IMPORT_ADDRESS;
  const prepared =
    kind === "pdf"
      ? await preparePdf(c.env.AI, file, identity.householdId, to)
      : await prepareEml(file, identity.householdId);
  if ("error" in prepared) return c.json({ error: prepared.error }, prepared.status);

  // With the ring: an uploaded PDF or .eml is the same class of document as a
  // forwarded confirmation and is sealed at rest identically.
  const emails = new InboundEmailRepo(c.get("db"), identity, c.get("ring"));
  const email = await emails.create({
    from: prepared.value.from,
    to,
    subject: prepared.value.subject,
    raw: prepared.value.raw,
  });
  const result = await runExtraction(c, emails, email, provider, configured.extractionInstructions);
  // The other opportunistic host for the sweep: importing a file is a write
  // by a household member, on the same table the retention policy governs.
  await sweepExpiredRaw(emails);
  return c.json(result);
});

/**
 * Re-run extraction over a message this household has already stored.
 *
 * This is the endpoint the retention window exists to serve: an extraction
 * that produced nothing useful is worth another attempt (with a different
 * model, or after a parser fix), and that attempt needs the original message.
 * Once the window has passed, raw is gone and no amount of retrying will
 * bring it back — so this answers 410 Gone with the reason in plain words
 * rather than quietly re-extracting an empty string and reporting "no
 * bookings found", which would look like a model failure and invite the user
 * to keep pressing the button.
 *
 * Idempotent by construction: extractInboundEmail() short-circuits when the
 * email already has drafts, so a second call returns the same drafts instead
 * of a second copy of them.
 */
imports.post("/:inboundEmailId/reextract", async (c) => {
  const identity = c.get("identity");
  if (identity.role === "viewer") {
    throw new ForbiddenError("Viewers may not re-run extraction");
  }
  const emails = new InboundEmailRepo(c.get("db"), identity, c.get("ring"));
  const email = await emails.findById(c.req.param("inboundEmailId"));
  if (!email) throw new NotFoundError("Inbound email not found in this household");

  const unavailable = rawUnavailableReason(email);
  if (unavailable) {
    // 410, not 404: the row is right here, and the client asked for something
    // that used to exist and deliberately does not any more.
    return c.json({ error: `${unavailable} Extraction cannot be re-run.` }, 410);
  }

  const configured = await new HouseholdSettingsRepo(
    c.get("db"),
    identity,
    c.get("ring"),
  ).getIngestSettings();
  const provider = await resolveExtractionProvider({
    settings: configured,
    ai: c.env.AI,
    ring: c.get("ring"),
    anthropicClientFactory: c.get("anthropicClientFactory"),
    logContext: `re-extraction of inbound email ${email.id}`,
  });
  if (!provider) {
    return c.json({ error: "The configured extraction provider is unavailable" }, 503);
  }

  return c.json(
    await runExtraction(c, emails, email, provider, configured.extractionInstructions),
  );
});

/**
 * Extract one stored email and report what came of it. Shared by the file
 * import and the re-extraction endpoint so the two cannot disagree about how
 * a `rejected` row is reported or which drafts count as the answer.
 */
async function runExtraction(
  c: Context<AppEnv>,
  emails: InboundEmailRepo,
  email: InboundEmail,
  provider: ExtractionProvider,
  extractionInstructions: string,
): Promise<FileImportResult> {
  const identity = c.get("identity");
  await extractInboundEmail(
    {
      db: c.get("db"),
      householdId: identity.householdId,
      provider,
      extractionInstructions,
    },
    email,
  );

  const finished = await emails.findById(email.id);
  if (!finished) throw new Error("Imported file disappeared immediately after extraction");
  const drafts = await new DraftBookingRepo(c.get("db"), identity).listByEmail(email.id);
  return {
    inboundEmailId: email.id,
    status:
      finished.status === "rejected"
        ? "failed"
        : finished.status,
    error: finished.error,
    bookings: drafts.map((draft) => normalizeExtractedBooking(draft.extracted)),
  };
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 180);
}

function importFileKind(file: File): ImportFileKind | undefined {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type === "message/rfc822" || name.endsWith(".eml")) return "eml";
  return undefined;
}

type PreparedImport = {
  from: string;
  subject: string;
  raw: string;
};

type PreparationResult =
  | { value: PreparedImport }
  | { error: string; status: 413 | 422 | 502 };

async function preparePdf(
  ai: Ai,
  file: File,
  householdId: string,
  to: string,
): Promise<PreparationResult> {
  let converted: Awaited<ReturnType<Ai["toMarkdown"]>>;
  try {
    converted = await ai.toMarkdown(
      { name: file.name, blob: file },
      { conversionOptions: { pdf: { metadata: false } } },
    );
  } catch (err) {
    console.error(`[import] PDF conversion failed for household ${householdId}`, err);
    return { error: "The PDF could not be converted to text", status: 502 };
  }
  if (Array.isArray(converted) || converted.format === "error") {
    const detail = Array.isArray(converted) ? "unexpected conversion response" : converted.error;
    console.error(`[import] PDF conversion rejected for household ${householdId}: ${detail}`);
    return { error: "The PDF could not be converted to text", status: 422 };
  }

  const text = converted.data.trim();
  if (text === "") {
    return { error: "The PDF did not contain readable text", status: 422 };
  }
  if (text.length > MAX_CONVERTED_TEXT_CHARS) {
    return { error: "The converted PDF is too long to import", status: 413 };
  }

  const subject = `File import: ${safeHeader(file.name)}`;
  return {
    value: {
      from: FILE_IMPORT_ADDRESS,
      subject,
      raw: [
        `From: Travel HQ File Import <${FILE_IMPORT_ADDRESS}>`,
        `To: ${safeHeader(to)}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
      ].join("\r\n"),
    },
  };
}

async function prepareEml(file: File, householdId: string): Promise<PreparationResult> {
  try {
    const raw = await file.text();
    const parsed = parseMime(raw);
    const from = parsed.from?.trim();
    const subject = parsed.subject?.trim();
    return {
      value: {
        from: safeHeader(from || FILE_IMPORT_ADDRESS),
        subject: safeHeader(subject || `File import: ${file.name}`),
        raw,
      },
    };
  } catch (err) {
    console.error(`[import] EML parsing failed for household ${householdId}`, err);
    return { error: "The EML file could not be read", status: 422 };
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
