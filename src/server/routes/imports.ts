import { Hono } from "hono";
import type { AppEnv } from "../index.js";
import { normalizeExtractedBooking } from "../ingest/extracted.js";
import type { ExtractedBooking } from "../ingest/extracted.js";
import { extractInboundEmail } from "../ingest/extract.js";
import { resolveExtractionProvider } from "../ingest/providers.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import { HouseholdSettingsRepo } from "../repos/household-settings.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import type { InboundEmailStatus } from "../repos/inbound-email.js";

export const MAX_IMPORT_PDF_BYTES = 10 * 1024 * 1024;
const MAX_CONVERTED_TEXT_CHARS = 250_000;
const FILE_IMPORT_ADDRESS = "file-import@travel-hq.invalid";

export type FileImportResult = {
  inboundEmailId: string;
  status: Extract<InboundEmailStatus, "received" | "extracted" | "failed">;
  error: string | null;
  bookings: ExtractedBooking[];
};

export const imports = new Hono<AppEnv>();

imports.post("/file", async (c) => {
  let body: FormData;
  try {
    body = await c.req.formData();
  } catch {
    return c.json({ error: "Expected a multipart form upload" }, 400);
  }

  const file = body.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Choose a PDF file to import" }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: "The PDF file is empty" }, 400);
  }
  if (file.size > MAX_IMPORT_PDF_BYTES) {
    return c.json({ error: "PDF files must be 10 MiB or smaller" }, 413);
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return c.json({ error: "Only PDF files can be imported" }, 415);
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

  let converted: Awaited<ReturnType<Ai["toMarkdown"]>>;
  try {
    converted = await c.env.AI.toMarkdown(
      { name: file.name, blob: file },
      { conversionOptions: { pdf: { metadata: false } } },
    );
  } catch (err) {
    console.error(`[import] PDF conversion failed for household ${identity.householdId}`, err);
    return c.json({ error: "The PDF could not be converted to text" }, 502);
  }
  if (Array.isArray(converted) || converted.format === "error") {
    const detail = Array.isArray(converted) ? "unexpected conversion response" : converted.error;
    console.error(`[import] PDF conversion rejected for household ${identity.householdId}: ${detail}`);
    return c.json({ error: "The PDF could not be converted to text" }, 422);
  }

  const text = converted.data.trim();
  if (text === "") {
    return c.json({ error: "The PDF did not contain readable text" }, 422);
  }
  if (text.length > MAX_CONVERTED_TEXT_CHARS) {
    return c.json({ error: "The converted PDF is too long to import" }, 413);
  }

  const subject = `File import: ${safeHeader(file.name)}`;
  const to = configured.forwardAddress ?? FILE_IMPORT_ADDRESS;
  const raw = [
    `From: Travel HQ File Import <${FILE_IMPORT_ADDRESS}>`,
    `To: ${safeHeader(to)}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");

  const emails = new InboundEmailRepo(c.get("db"), identity);
  const email = await emails.create({
    from: FILE_IMPORT_ADDRESS,
    to,
    subject,
    raw,
  });
  await extractInboundEmail(
    {
      db: c.get("db"),
      householdId: identity.householdId,
      provider,
      extractionInstructions: configured.extractionInstructions,
    },
    email,
  );

  const finished = await emails.findById(email.id);
  if (!finished) throw new Error("Imported PDF disappeared immediately after extraction");
  const drafts = await new DraftBookingRepo(c.get("db"), identity).listByEmail(email.id);
  const result: FileImportResult = {
    inboundEmailId: email.id,
    status:
      finished.status === "rejected"
        ? "failed"
        : finished.status,
    error: finished.error,
    bookings: drafts.map((draft) => normalizeExtractedBooking(draft.extracted)),
  };
  return c.json(result);
});

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 180);
}
