import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { PersonRepo, DOCUMENT_FIELDS } from "../repos/person.js";
import type { DocumentField, UpdatePersonInput } from "../repos/person.js";
import { AuditRepo } from "../repos/audit.js";
import { isValidCalendarDate } from "../time.js";
import type { AppEnv } from "../index.js";
import { isJsonAction } from "./request.js";

/**
 * Mirrors `assertCalendarDate` in repos/validation.ts, which is the actual
 * enforcement point for both of this route's date fields. Worth stating twice:
 * `passportExpiry` is compared against a trip's `starts_on` to raise the
 * "passport expires before this trip" warning, and that comparison is silently
 * meaningless — not loud, meaningless — unless both sides are exact
 * YYYY-MM-DD.
 */
const calendarDateSchema = z
  .string()
  .refine(isValidCalendarDate, { message: "must be a well-formed YYYY-MM-DD date" });

const createPersonSchema = z.object({
  displayName: z.string().min(1),
  dob: calendarDateSchema.optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  notes: z.string().optional(),
  passportNumber: z.string().optional(),
  passportExpiry: calendarDateSchema.optional(),
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
    dob: calendarDateSchema.nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    phone: z.string().trim().min(1).max(40).nullable().optional(),
    notes: z.string().nullable().optional(),
    passportExpiry: calendarDateSchema.nullable().optional(),
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

/**
 * "Which traveler am I?" -- the person row linked to the signed-in account.
 *
 * 204 NO CONTENT WHEN THERE IS NONE, and this is the interesting part.
 * `ensureCurrentUser` used to create a row on demand, so this endpoint could
 * not fail to answer; it no longer creates, because an owner pre-seeding a
 * person row is what constitutes household membership and a trip guest
 * (provisioned as a `viewer` by TripAccessRepo.invite) must not get a passport
 * field out of merely signing in. See PersonRepo.ensureCurrentUser.
 *
 * A 204 rather than `200 {"person": null}` because "no profile" is genuinely
 * the absence of a resource rather than a resource whose contents are empty,
 * and because api/client.ts already turns a 204 into `undefined` for every
 * caller -- the two existing ones (BookingDetailDialog, TravelersTab) need to
 * handle absence either way, and this makes it impossible for them not to.
 *
 * Both verbs answer identically. GET is the honest spelling now that nothing
 * is created; POST is kept because it is what the shipped client calls, and
 * breaking a client that is already in someone's browser cache to rename a
 * verb is not a trade worth making.
 */
async function currentPerson(c: Context<AppEnv>) {
  const identity = c.get("identity");
  const repo = new PersonRepo(c.get("db"), identity, c.get("ring"));
  const person = await repo.ensureCurrentUser(identity.email);
  return person ? c.json(person) : c.body(null, 204);
}

people.get("/me", currentPerson);
people.post("/me", currentPerson);

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

// Revealing plaintext is an audited action, not a safe/idempotent resource
// read. POST prevents link scanners, prefetchers, and speculative navigation
// from triggering it; the API-wide no-store middleware prevents retention of
// the response.
people.post("/:id/reveal/:field", async (c) => {
  if (!isJsonAction(c.req.raw)) {
    return c.json({ error: "Reveal actions require application/json" }, 415);
  }
  const field = c.req.param("field");
  if (!DOCUMENT_FIELDS.includes(field as DocumentField)) {
    // A client-supplied field outside the allowlist is genuine bad input —
    // handled here, directly, as its own 400. (revealDocument() would also
    // reject it, but as a TenantScopeError/500: a caller inside our own code
    // that skipped this check would be the bug at that point, not the client.)
    return c.json({ error: `"${field}" is not a revealable document field` }, 400);
  }

  const identity = c.get("identity");
  const db = c.get("db");
  const personId = c.req.param("id");
  const repo = new PersonRepo(db, identity, c.get("ring"));
  // A denied reveal (ForbiddenError, I3) or an unknown/cross-household person
  // id (NotFoundError, I5) throw here and are mapped by app.onError before
  // anything below ever runs -- a denied or nonexistent reveal is not a
  // reveal to record.
  //
  // `selfService` comes back from the repo rather than being worked out here:
  // it is the repo that saw `person.user_id`, and the audit row has to record
  // which kind of reveal this was at the moment it happened. A route cannot
  // invent the flag, which is what makes it safe for AuditRepo to treat it as
  // authorization for a viewer's own audit row.
  const { value, selfService } = await repo.revealDocument(personId, field as DocumentField);

  // The durable half of the audit trail (issue #8): an owner-readable row
  // naming WHICH person's WHICH document was unmasked, by whom and when --
  // never the document number. No trip id: a person is household-scoped and
  // has no trip parent. Not wrapped in a try/catch on purpose; see the
  // matching comment on the booking reveal in routes/trips.ts for why an
  // unauditable reveal must fail rather than succeed quietly.
  const entry = await new AuditRepo(db, identity).recordReveal({
    event: "document_reveal",
    subjectType: "person",
    subjectId: personId,
    field,
    selfService,
  });

  // The ephemeral half, correlated to the row by auditId and to the request by
  // the logger's requestId. `field` is the NAME of the field, which is the
  // whole point of the entry; the value it held never appears.
  c.get("logger").info("document_reveal", {
    auditId: entry.id,
    personId,
    field,
    selfService,
    householdId: identity.householdId,
    userId: identity.userId,
  });

  return c.json({ value });
});
