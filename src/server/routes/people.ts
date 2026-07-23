import { Hono } from "hono";
import { z } from "zod";
import { PersonRepo, DOCUMENT_FIELDS } from "../repos/person.js";
import type { DocumentField, UpdatePersonInput } from "../repos/person.js";
import { RevealAuditRepo } from "../repos/reveal-audit.js";
import { logEvent } from "../logging.js";
import type { AppEnv } from "../index.js";

const createPersonSchema = z.object({
  displayName: z.string().min(1),
  dob: z.string().optional(),
  notes: z.string().optional(),
  passportNumber: z.string().optional(),
  passportExpiry: z.string().optional(),
  passportCountry: z.string().optional(),
  knownTravelerNumber: z.string().optional(),
  redressNumber: z.string().optional(),
});

/**
 * `.nullable().optional()` is the tri-state at the HTTP boundary: the key may
 * be absent (leave unchanged), null (clear), or a string (replace). Zod's
 * `safeParse` on an object schema drops nothing and adds nothing, so an
 * absent key stays absent in `parsed.data` and PersonRepo.update() sees
 * `undefined` -- which is exactly what it treats as "do not touch".
 *
 * `.strict()` matters here in a way it does not on the create schema: an edit
 * form that PUTs back the whole object it was shown would otherwise send
 * `passportNumberMasked`, which a permissive schema would silently drop,
 * leaving the operator believing they had edited a field they had not. A 400
 * naming the unknown key is the honest answer.
 */
const updatePersonSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    dob: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    passportExpiry: z.string().nullable().optional(),
    passportCountry: z.string().nullable().optional(),
    passportNumber: z.string().min(1).nullable().optional(),
    knownTravelerNumber: z.string().min(1).nullable().optional(),
    redressNumber: z.string().min(1).nullable().optional(),
  })
  .strict();

export const people = new Hono<AppEnv>();

people.get("/", async (c) => {
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(await repo.list());
});

people.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // A JSON.parse-level SyntaxError, not a repo error — mapError() doesn't
    // recognize it, and its generic 500 fallback would be the wrong status
    // for a client that simply sent malformed JSON. Handle it here, directly,
    // without echoing the parser's own message.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createPersonSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid person", details: parsed.error.issues }, 400);
  }
  // A viewer role reaching requireWrite() throws ForbiddenError, which
  // createApp's app.onError maps via mapError() -- no local try/catch needed.
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  return c.json(await repo.create(parsed.data), 201);
});

people.put("/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updatePersonSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid person", details: parsed.error.issues }, 400);
  }
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  // NotFoundError (404), ForbiddenError (403), and the masked-value
  // ValidationError (400) all reach app.onError, which is the single place
  // that decides status. No local try/catch.
  return c.json(await repo.update(c.req.param("id"), parsed.data satisfies UpdatePersonInput));
});

people.get("/:id/reveal/:field", async (c) => {
  const field = c.req.param("field");
  if (!DOCUMENT_FIELDS.includes(field as DocumentField)) {
    // A client-supplied field outside the allowlist is genuine bad input —
    // handled here, directly, as its own 400. (revealDocument() would also
    // reject it, but as a TenantScopeError/500: a caller inside our own code
    // that skipped this check would be the bug at that point, not the client.)
    return c.json({ error: `"${field}" is not a revealable document field` }, 400);
  }

  const identity = c.get("identity");
  const personId = c.req.param("id");
  const repo = new PersonRepo(c.get("db"), identity, c.get("ring"));
  // A viewer role (ForbiddenError, I3) or an unknown/cross-household person
  // id (NotFoundError, I5) throw here and are mapped by app.onError before
  // the audit write below ever runs -- a denied or nonexistent reveal is not
  // a reveal to record.
  const value = await repo.revealDocument(personId, field as DocumentField);

  // The spec requires document reveals to be logged; #8 makes that durable.
  // The audit row is written BEFORE the value is returned, so a failed write
  // (500 via app.onError) means the response never carries an unaudited
  // plaintext. Who-in-human-terms (the email) lives HERE, in the database,
  // where the owner-only /api/audit/reveals route serves it.
  await new RevealAuditRepo(c.get("db"), identity).record({
    userEmail: identity.email,
    personId,
    field: field as DocumentField,
  });

  // The structured log line carries ids and the outcome only -- userId, not
  // email: an address identifies a person and must not land in logs (#8).
  logEvent("document_reveal", {
    requestId: c.get("requestId"),
    userId: identity.userId,
    householdId: identity.householdId,
    personId,
    field,
  });

  return c.json({ value });
});
