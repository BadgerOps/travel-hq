import { Hono } from "hono";
import { z } from "zod";
import { CardRepo, PERK_KINDS, PERK_CADENCES } from "../repos/card.js";
import type { UpdateCardInput, UpdatePerkInput } from "../repos/card.js";
import type { AppEnv } from "../index.js";

const createCardSchema = z.object({
  name: z.string().min(1),
  issuer: z.string().optional(),
  pointsProgram: z.string().optional(),
  pointsBalance: z.number().int().nonnegative().optional(),
});

/**
 * `.nullable().optional()` is the tri-state at the HTTP boundary (absent =
 * leave, null = clear, value = set) and `.strict()` rejects unknown keys, the
 * same shape and reasoning as updatePersonSchema.
 */
const updateCardSchema = z
  .object({
    name: z.string().min(1).optional(),
    issuer: z.string().nullable().optional(),
    pointsProgram: z.string().nullable().optional(),
    pointsBalance: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

const createPerkSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(PERK_KINDS),
  valueCents: z.number().int().positive().optional(),
  multiplier: z.number().positive().optional(),
  category: z.string().min(1).optional(),
  cadence: z.enum(PERK_CADENCES),
  resetMonthDay: z.string().optional(),
});

const updatePerkSchema = z
  .object({
    name: z.string().min(1).optional(),
    kind: z.enum(PERK_KINDS).optional(),
    valueCents: z.number().int().positive().nullable().optional(),
    multiplier: z.number().positive().nullable().optional(),
    category: z.string().min(1).nullable().optional(),
    cadence: z.enum(PERK_CADENCES).optional(),
    resetMonthDay: z.string().nullable().optional(),
  })
  .strict();

const usedSchema = z.object({ used: z.boolean() });

export const cards = new Hono<AppEnv>();

cards.get("/", async (c) =>
  c.json(await new CardRepo(c.get("db"), c.get("identity")).listWithPerks()),
);

cards.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // A JSON.parse-level SyntaxError, not a domain error -- mapError() does
    // not recognize it and its generic fallback would answer 500 for what is
    // plainly a malformed request. This early return is the ONE thing routes
    // handle locally; everything else belongs to app.onError.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createCardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid card", details: parsed.error.issues }, 400);
  }
  // A viewer role reaching requireWrite() throws ForbiddenError, mapped by
  // createApp's app.onError via mapError() -- no local try/catch.
  return c.json(await new CardRepo(c.get("db"), c.get("identity")).createCard(parsed.data), 201);
});

cards.put("/:cardId", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateCardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid card", details: parsed.error.issues }, 400);
  }
  // NotFoundError (404), ForbiddenError (403), ValidationError (400) all
  // reach app.onError, the single status-mapping decision.
  return c.json(
    await new CardRepo(c.get("db"), c.get("identity")).updateCard(c.req.param("cardId"), parsed.data satisfies UpdateCardInput),
  );
});

cards.delete("/:cardId", async (c) => {
  await new CardRepo(c.get("db"), c.get("identity")).deleteCard(c.req.param("cardId"));
  return c.body(null, 204);
});

cards.post("/:cardId/perks", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createPerkSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid perk", details: parsed.error.issues }, 400);
  }
  // Cross-kind rules (a multiplier needs category and forbids valueCents,
  // credits need values, resetMonthDay is annual-only) live in the repo's
  // validatePerkShape -- ValidationError, 400 via mapError -- so non-HTTP
  // callers get exactly the same checks.
  return c.json(await new CardRepo(c.get("db"), c.get("identity")).createPerk(c.req.param("cardId"), parsed.data), 201);
});

cards.put("/:cardId/perks/:perkId", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updatePerkSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid perk", details: parsed.error.issues }, 400);
  }
  return c.json(
    await new CardRepo(c.get("db"), c.get("identity")).updatePerk(
      c.req.param("cardId"),
      c.req.param("perkId"),
      parsed.data satisfies UpdatePerkInput,
    ),
  );
});

cards.delete("/:cardId/perks/:perkId", async (c) => {
  await new CardRepo(c.get("db"), c.get("identity")).deletePerk(c.req.param("cardId"), c.req.param("perkId"));
  return c.body(null, 204);
});

cards.put("/:cardId/perks/:perkId/used", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = usedSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Expected { used: boolean }" }, 400);
  // An unknown/cross-household id throws NotFoundError -> 404; a viewer
  // throws ForbiddenError -> 403; a multiplier perk throws ValidationError
  // -> 400. All via app.onError.
  await new CardRepo(c.get("db"), c.get("identity")).setPerkUsed(c.req.param("cardId"), c.req.param("perkId"), parsed.data.used);
  return c.body(null, 204);
});
