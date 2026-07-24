import { Hono } from "hono";
import { z } from "zod";
import {
  AI_PROVIDERS,
  HouseholdSettingsRepo,
  MAX_EXTRACTION_INSTRUCTIONS_CHARS,
} from "../repos/household-settings.js";
import type { UpdateHouseholdSettingsInput } from "../repos/household-settings.js";
import type { AppEnv } from "../index.js";
import { MAX_AI_TEXT_CHARS, extractBookings } from "../ingest/extract.js";
import { resolveExtractionProvider } from "../ingest/providers.js";

/**
 * Same tri-state convention as the person update schema: an absent key means
 * "leave unchanged", `forwardAddress: null` clears the address. `.strict()`
 * so a client that PUTs back an object with a stray key gets a 400 naming it
 * rather than silently having the key dropped.
 */
const updateSettingsSchema = z
  .object({
    forwardAddress: z.string().min(1).nullable().optional(),
    senderAllowlist: z.array(z.string().min(1)).optional(),
    aiModel: z.string().min(1).optional(),
    aiProvider: z.enum(AI_PROVIDERS).optional(),
    anthropicModel: z.string().min(1).optional(),
    anthropicApiKey: z.string().min(1).nullable().optional(),
    extractionInstructions: z.string().max(MAX_EXTRACTION_INSTRUCTIONS_CHARS).optional(),
  })
  .strict();

const extractionTestSchema = z
  .object({
    subject: z.string().optional(),
    from: z.string().optional(),
    text: z.string().min(1).max(MAX_AI_TEXT_CHARS),
  })
  .strict();

export const settings = new Hono<AppEnv>();

// Owner/adult only in both directions: the repo throws ForbiddenError for a
// viewer on the GET as well as the PUT (see requireOwnerOrAdult in
// repos/household-settings.ts), and app.onError maps it to 403.
settings.get("/", async (c) =>
  c.json(
    await new HouseholdSettingsRepo(c.get("db"), c.get("identity"), c.get("ring")).getSettings(),
  ),
);

settings.put("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // A JSON.parse-level SyntaxError, not a domain error -- mapError() does
    // not recognize it and its generic fallback would answer 500 for what is
    // plainly a malformed request. Handled here, directly, without echoing
    // the parser's own message. Matches routes/people.ts and routes/checklist.ts.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid settings", details: parsed.error.issues }, 400);
  }
  // No try/catch: a viewer (ForbiddenError, 403) or a semantic problem the
  // schema can't see -- a malformed address, a forward address another
  // household already claimed (ValidationError, 400) -- throws here and
  // createApp's app.onError maps it through mapError(), the single
  // status-mapping decision in the codebase.
  const repo = new HouseholdSettingsRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(await repo.updateSettings(parsed.data satisfies UpdateHouseholdSettingsInput));
});

// Any household member may list the catalog -- it is public Cloudflare model
// metadata, not household data, so it skips the repo's owner/adult gate.
// Failures use the extraction-test soft-error envelope (200 + error field):
// the dropdown falls back to its built-in presets rather than surfacing a 5xx.
settings.get("/ai-models", async (c) => {
  try {
    return c.json({ models: await c.get("modelCatalog").list(c.env.AI) });
  } catch {
    return c.json({ models: [], error: "Workers AI is unavailable" });
  }
});

settings.post("/extraction-test", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = extractionTestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid extraction test", details: parsed.error.issues }, 400);
  }

  const repo = new HouseholdSettingsRepo(c.get("db"), c.get("identity"), c.get("ring"));
  const configured = await repo.getIngestSettings();
  const provider = await resolveExtractionProvider({
    settings: configured,
    ai: c.env.AI,
    ring: c.get("ring"),
    anthropicClientFactory: c.get("anthropicClientFactory"),
    logContext: "settings extraction test",
  });
  if (!provider) {
    return c.json({ error: "Workers AI is unavailable" });
  }

  try {
    const bookings = await extractBookings(
      provider,
      {
        subject: parsed.data.subject ?? "",
        from: parsed.data.from ?? "",
        textBody: parsed.data.text,
        calendars: [],
      },
      configured.extractionInstructions,
    );
    return c.json({ bookings });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) });
  }
});
