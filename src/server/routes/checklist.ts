import { Hono } from "hono";
import { z } from "zod";
import { ChecklistRepo } from "../repos/checklist.js";
import { isValidCalendarDate } from "../time.js";
import type { AppEnv } from "../index.js";
import { authorizeTrip } from "../trip-authorization.js";

const createSchema = z.object({
  tripId: z.string().min(1),
  label: z.string().min(1),
  personId: z.string().optional(),
  // Mirrors ChecklistRepo.create's own assertCalendarDate. A due date is sorted
  // on and compared against today to render the urgency badge, neither of which
  // survives a free-text date -- and this column has no update path, so a bad
  // value written here can only be deleted, never corrected.
  dueOn: z
    .string()
    .refine(isValidCalendarDate, { message: "dueOn must be a well-formed YYYY-MM-DD date" })
    .optional(),
});

const doneSchema = z.object({ done: z.boolean() });

export const checklist = new Hono<AppEnv>();

checklist.get("/", async (c) => {
  const tripId = c.req.query("tripId");
  if (tripId) {
    // The trip id lives in the query string, so the path-based trip
    // authorization middleware cannot resolve it.
    await authorizeTrip(c, async () => {}, tripId);
  }
  const repo = new ChecklistRepo(c.get("db"), c.get("identity"));
  return c.json(tripId ? await repo.listByTrip(tripId) : await repo.listAll());
});

checklist.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // A JSON.parse-level SyntaxError, not a domain error -- mapError() does
    // not recognize it and its generic fallback would answer 500 for what is
    // plainly a malformed request. Handled here, directly, without echoing
    // the parser's own message. This early return is the ONE thing routes
    // handle locally; everything else belongs to app.onError.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid checklist item", details: parsed.error.issues }, 400);
  }
  // This trip id lives in JSON rather than the URL, so the app-wide
  // trip-scoped middleware cannot resolve it.
  await authorizeTrip(c, async () => {}, parsed.data.tripId);
  // No try/catch. An unknown trip/person (NotFoundError, 404) or a viewer
  // role (ForbiddenError, 403) throws here and createApp's app.onError maps
  // it through mapError() -- the single status-mapping decision in the
  // codebase. A local `catch (err) => c.json({ error: String(err) }, 400)`
  // would forward an internal message over HTTP *and* flatten 403/404 into
  // 400. Match routes/trips.ts exactly.
  const repo = new ChecklistRepo(c.get("db"), c.get("identity"));
  return c.json(await repo.create(parsed.data), 201);
});

checklist.put("/:id/done", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = doneSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Expected { done: boolean }" }, 400);
  // An unknown/cross-household item id throws NotFoundError -> 404 via
  // app.onError; a viewer throws ForbiddenError -> 403.
  await new ChecklistRepo(c.get("db"), c.get("identity")).setDone(c.req.param("id"), parsed.data.done);
  return c.body(null, 204);
});
