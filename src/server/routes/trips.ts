import { Hono } from "hono";
import { z } from "zod";
import { TripRepo, TRIP_STATUSES } from "../repos/trip.js";
import type { UpdateTripInput } from "../repos/trip.js";
import { BookingRepo } from "../repos/booking.js";
import { PersonRepo } from "../repos/person.js";
import { RollupRepo } from "../repos/rollup.js";
import { BOOKING_KINDS } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";
import { NotFoundError } from "../repos/base.js";
import type { AppEnv } from "../index.js";
import { isJsonAction } from "./request.js";

// A cover photo URL is rendered straight into an <img src> on the trip card,
// so only web-fetchable http(s) URLs may be stored — javascript:, data:, and
// every other scheme must fail here as a 400, not execute at render time.
// WHATWG URL parsing (not a substring check) is what defeats scheme-smuggling
// spellings like "jAvAsCrIpT:" or leading whitespace.
function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

const photoUrlSchema = z
  .string()
  .max(2048)
  .refine(isHttpUrl, { message: "photoUrl must be an http(s) URL" });

const createTripSchema = z.object({
  title: z.string().min(1),
  destination: z.string().optional(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  notes: z.string().optional(),
  photoUrl: photoUrlSchema.optional(),
});

/**
 * `.nullable().optional()` is the tri-state at the HTTP boundary, exactly as
 * updatePersonSchema established: the key may be absent (leave unchanged),
 * null (clear), or a value (replace). `title` and `status` are optional but
 * never null — a trip must keep a title, and "no status" is spelled
 * `planning`, not NULL.
 *
 * `.strict()` for the same reason as updatePersonSchema: an edit form that
 * PUTs back the whole object it was shown would otherwise send `id` (or a
 * misspelled key), which a permissive schema would silently drop, leaving
 * the operator believing they had edited a field they had not.
 *
 * Date well-formedness and the startsOn <= endsOn ordering are validated in
 * TripRepo.update — the ordering check must see the EFFECTIVE post-patch
 * pair, which only the repo (holding the stored row) can compute.
 */
const updateTripSchema = z
  .object({
    title: z.string().min(1).optional(),
    destination: z.string().nullable().optional(),
    startsOn: z.string().nullable().optional(),
    endsOn: z.string().nullable().optional(),
    status: z.enum(TRIP_STATUSES).optional(),
    notes: z.string().nullable().optional(),
    photoUrl: photoUrlSchema.nullable().optional(),
  })
  .strict();

// C1: a timestamp must be something `Date.parse` can understand, and a
// timezone must be something `Intl.DateTimeFormat` recognizes as an IANA
// zone identifier -- otherwise it passes validation as a bare non-empty
// string, gets stored as-is, and bricks `ItineraryRepo`'s day view (via
// `localDateOf()`) on every future read of that trip, permanently, since
// there is no PATCH/DELETE booking endpoint to fix it through the API.
// `isValidTimestamp`/`isValidTimezone` live in `../time.js`, shared with
// `repos/booking.ts` and `ingest/extracted.ts` -- see that module's doc
// comment for why the three must never drift apart.

const createBookingSchema = z
  .object({
    // M8: kind must be a known kind or the deliberate "other" freeform
    // escape hatch -- not an arbitrary string that silently falls back to
    // freeform validation in parseDetails().
    kind: z.enum(BOOKING_KINDS),
    title: z.string().min(1),
    location: z.string().optional(),
    startsAt: z
      .string()
      .refine(isValidTimestamp, { message: "startsAt must be a parseable timestamp" })
      .optional(),
    startsAtTz: z
      .string()
      .refine(isValidTimezone, { message: "startsAtTz must be a valid IANA timezone" })
      .optional(),
    endsAt: z
      .string()
      .refine(isValidTimestamp, { message: "endsAt must be a parseable timestamp" })
      .optional(),
    endsAtTz: z
      .string()
      .refine(isValidTimezone, { message: "endsAtTz must be a valid IANA timezone" })
      .optional(),
    confirmationNumber: z.string().optional(),
    costCents: z.number().int().optional(),
    pointsUsed: z.number().int().optional(),
    pointsProgram: z.string().optional(),
    status: z.enum(["draft", "planned", "booked", "cancelled"]).optional(),
    details: z.unknown(),
  })
  // Mirrors BookingRepo.create()'s assertTimezonePaired() at the API boundary,
  // so a malformed request fails as a genuine 400 (Zod, via mapError) before
  // it ever reaches the repo. The repo-level check stays too — belt and
  // braces for any non-HTTP caller — so this is deliberately redundant.
  .refine((v) => !v.startsAt || v.startsAtTz, {
    message: "startsAt requires startsAtTz (an IANA timezone)",
    path: ["startsAtTz"],
  })
  .refine((v) => !v.endsAt || v.endsAtTz, {
    message: "endsAt requires endsAtTz (an IANA timezone)",
    path: ["endsAtTz"],
  });

export const trips = new Hono<AppEnv>();

trips.get("/", async (c) => c.json(await new TripRepo(c.get("db"), c.get("identity")).list()));

trips.get("/:tripId", async (c) => {
  const trip = await new TripRepo(c.get("db"), c.get("identity"))
    .findById(c.req.param("tripId"));
  if (!trip) {
    // Match every other trip-specific route: unknown and cross-household IDs
    // are indistinguishable and both return 404 through app.onError.
    throw new NotFoundError("Trip not found in this household");
  }
  return c.json(trip);
});

trips.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createTripSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid trip", details: parsed.error.issues }, 400);
  }
  // A viewer role reaching requireWrite() throws ForbiddenError, which
  // createApp's app.onError maps via mapError() -- no local try/catch needed.
  return c.json(await new TripRepo(c.get("db"), c.get("identity")).create(parsed.data), 201);
});

trips.put("/:tripId", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateTripSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid trip", details: parsed.error.issues }, 400);
  }
  // NotFoundError (404), ForbiddenError (403), and the date-ordering
  // ValidationError (400) all reach app.onError, which is the single place
  // that decides status. No local try/catch.
  return c.json(
    await new TripRepo(c.get("db"), c.get("identity")).update(
      c.req.param("tripId"),
      parsed.data satisfies UpdateTripInput,
    ),
  );
});

trips.delete("/:tripId", async (c) => {
  // Hard delete; the schema's cascades remove bookings (and their
  // booking_person rows), checklist items, and trip_person rows. Unknown or
  // cross-household ids throw NotFoundError, a viewer ForbiddenError — both
  // mapped by app.onError.
  await new TripRepo(c.get("db"), c.get("identity")).delete(c.req.param("tripId"));
  return c.body(null, 204);
});

trips.get("/:tripId/bookings", async (c) =>
  // An unknown/cross-household tripId throws NotFoundError (I5), mapped by
  // app.onError.
  c.json(
    await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).listByTrip(
      c.req.param("tripId"),
    ),
  ),
);

trips.get("/:tripId/rollup", async (c) =>
  // An unknown/cross-household tripId throws NotFoundError, mapped to 404 by
  // app.onError -- same as the sibling /:tripId/bookings route. No local
  // try/catch.
  c.json(await new RollupRepo(c.get("db"), c.get("identity")).forTrip(c.req.param("tripId"))),
);

trips.post("/:tripId/bookings", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createBookingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid booking", details: parsed.error.issues }, 400);
  }
  const repo = new BookingRepo(c.get("db"), c.get("identity"), c.get("ring"));
  // Unknown trip (NotFoundError) and per-kind detail validation (ZodError,
  // from parseDetails) land in app.onError via mapError.
  return c.json(await repo.create({ ...parsed.data, tripId: c.req.param("tripId") }), 201);
});

// Revealing plaintext is an audited action, not a safe/idempotent resource
// read. POST prevents link scanners, prefetchers, and speculative navigation
// from triggering it; the API-wide no-store middleware prevents retention of
// the response.
trips.post("/:tripId/bookings/:bookingId/reveal", async (c) => {
  if (!isJsonAction(c.req.raw)) {
    return c.json({ error: "Reveal actions require application/json" }, 415);
  }
  const identity = c.get("identity");
  const repo = new BookingRepo(c.get("db"), identity, c.get("ring"));
  // A viewer role (ForbiddenError, I3) or an unknown/cross-household
  // bookingId (NotFoundError, I5) throw here and are mapped by app.onError
  // before the log line below ever runs -- a denied or nonexistent reveal is
  // not a reveal to log.
  const value = await repo.revealConfirmation(c.req.param("bookingId"));

  // The spec requires reveals to be logged.
  console.info(
    JSON.stringify({
      event: "confirmation_reveal",
      at: new Date().toISOString(),
      user: identity.email,
      household: identity.householdId,
      booking: c.req.param("bookingId"),
    }),
  );

  return c.json({ value });
});

trips.put("/:tripId/people/:personId", async (c) => {
  // Unknown trip/person in this household (NotFoundError, 404) or a viewer
  // role (ForbiddenError, 403) throw here and are mapped by app.onError.
  await new TripRepo(c.get("db"), c.get("identity")).addTraveler(
    c.req.param("tripId"),
    c.req.param("personId"),
  );
  return c.body(null, 204);
});

trips.delete("/:tripId/people/:personId", async (c) => {
  // The mirror of the PUT above. Unassigns only — the person comes off this
  // trip's bookings and its roster in one transaction; no booking is
  // cancelled or deleted. Idempotent for a person who is simply not on the
  // trip; 404 (NotFoundError) for a trip/person outside this household and
  // 403 (ForbiddenError) for a viewer, both mapped by app.onError.
  await new TripRepo(c.get("db"), c.get("identity")).removeTraveler(
    c.req.param("tripId"),
    c.req.param("personId"),
  );
  return c.body(null, 204);
});

trips.get("/:tripId/travelers", async (c) => {
  const identity = c.get("identity");
  const db = c.get("db");
  // Both calls are household-scoped by TenantRepo, so a cross-household
  // tripId simply yields no person ids -- it cannot leak a foreign roster.
  const ids = new Set(await new TripRepo(db, identity).travelers(c.req.param("tripId")));
  const people = await new PersonRepo(db, identity, c.get("ring")).list();
  return c.json(people.filter((p) => ids.has(p.id)));
});
