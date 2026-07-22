import { Hono } from "hono";
import { z } from "zod";
import { TripRepo } from "../repos/trip.js";
import { BookingRepo } from "../repos/booking.js";
import { PersonRepo } from "../repos/person.js";
import { RollupRepo } from "../repos/rollup.js";
import { BOOKING_KINDS } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";
import type { AppEnv } from "../index.js";

const createTripSchema = z.object({
  title: z.string().min(1),
  destination: z.string().optional(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  notes: z.string().optional(),
});

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

trips.get("/:tripId/bookings/:bookingId/reveal", async (c) => {
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

trips.get("/:tripId/travelers", async (c) => {
  const identity = c.get("identity");
  const db = c.get("db");
  // Both calls are household-scoped by TenantRepo, so a cross-household
  // tripId simply yields no person ids -- it cannot leak a foreign roster.
  const ids = new Set(await new TripRepo(db, identity).travelers(c.req.param("tripId")));
  const people = await new PersonRepo(db, identity, c.get("ring")).list();
  return c.json(people.filter((p) => ids.has(p.id)));
});
