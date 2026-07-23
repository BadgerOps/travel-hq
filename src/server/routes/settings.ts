import { Hono } from "hono";
import { z } from "zod";
import { HouseholdSettingsRepo } from "../repos/household-settings.js";
import type { UpdateHouseholdSettingsInput } from "../repos/household-settings.js";
import type { AppEnv } from "../index.js";

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
  })
  .strict();

export const settings = new Hono<AppEnv>();

// Owner/adult only in both directions: the repo throws ForbiddenError for a
// viewer on the GET as well as the PUT (see requireOwnerOrAdult in
// repos/household-settings.ts), and app.onError maps it to 403.
settings.get("/", async (c) =>
  c.json(await new HouseholdSettingsRepo(c.get("db"), c.get("identity")).getSettings()),
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
  const repo = new HouseholdSettingsRepo(c.get("db"), c.get("identity"));
  return c.json(await repo.updateSettings(parsed.data satisfies UpdateHouseholdSettingsInput));
});
