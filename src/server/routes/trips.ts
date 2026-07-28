import { Hono } from "hono";
import { z } from "zod";
import { TripRepo, TRIP_STATUSES } from "../repos/trip.js";
import type { UpdateTripInput } from "../repos/trip.js";
import { BookingRepo } from "../repos/booking.js";
import { DuplicateRepo } from "../repos/duplicates.js";
import { PersonRepo } from "../repos/person.js";
import { RollupRepo } from "../repos/rollup.js";
import { BOOKING_KINDS } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";
import { ForbiddenError, NotFoundError } from "../repos/base.js";
import type { AppEnv } from "../index.js";
import { isJsonAction } from "./request.js";

// A cover photo URL is rendered straight into an <img src> on the trip card,
// so only web-fetchable http(s) URLs or the app's own authenticated upload
// route may be stored — javascript:, data:, and every other scheme must fail
// here as a 400, not execute at render time.
// WHATWG URL parsing (not a substring check) is what defeats scheme-smuggling
// spellings like "jAvAsCrIpT:" or leading whitespace.
function isAllowedPhotoUrl(value: string): boolean {
  if (/^\/api\/trips\/[^/?#]+\/photo\?v=\d+$/.test(value)) return true;
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
  .refine(isAllowedPhotoUrl, {
    message: "photoUrl must be an http(s) URL or an uploaded trip photo",
  });

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
// `localDateOf()`) on every future read of that trip. `PUT /api/bookings/:id`
// can now repair such a row, but it enforces the same two checks, so the only
// way in remains a write that bypasses both -- keep them here.
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

// `.strict()` on both: a client that posts `bookingIds` to /merge (or
// `mergeIds` to /dismiss) has confused the two resolutions, and the two do
// opposite things — one deletes rows, the other only records a decision. A
// permissive schema would drop the misplaced key and then fail on the missing
// one, which reads as a validation quibble rather than the mistake it is.
const mergeDuplicatesSchema = z
  .object({
    keepId: z.string().min(1),
    mergeIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const dismissDuplicatesSchema = z
  .object({
    // Two ids is a pair; more is a group the human is declaring distinct in
    // one go, which the repo expands to every pair among them.
    bookingIds: z.array(z.string().min(1)).min(2),
  })
  .strict();

export const trips = new Hono<AppEnv>();

const MAX_TRIP_PHOTO_BYTES = 10 * 1024 * 1024;
const TRIP_PHOTO_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function tripPhotoKey(householdId: string, tripId: string): string {
  return `trip-covers/${householdId}/${tripId}`;
}

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

trips.get("/:tripId/photo", async (c) => {
  const identity = c.get("identity");
  const trip = await new TripRepo(c.get("db"), identity).findById(c.req.param("tripId"));
  if (!trip) throw new NotFoundError("Trip not found in this household");
  const object = await c.env.TRIP_PHOTOS.get(
    tripPhotoKey(identity.householdId, trip.id),
  );
  if (!object) throw new NotFoundError("Trip photo not found");
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      ETag: object.httpEtag,
    },
  });
});

trips.post("/:tripId/photo", async (c) => {
  const identity = c.get("identity");
  const repo = new TripRepo(c.get("db"), identity);
  const trip = await repo.findById(c.req.param("tripId"));
  if (!trip) throw new NotFoundError("Trip not found in this household");
  // Enforce write permission before reading a potentially large request body.
  if (identity.role === "viewer") {
    throw new ForbiddenError("Viewers may not change trip photos");
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return c.json({ error: "Expected a multipart photo upload" }, 400);
  }
  const photo = form.get("photo");
  if (!(photo instanceof File)) {
    return c.json({ error: "Choose an image to upload" }, 400);
  }
  if (!TRIP_PHOTO_TYPES.has(photo.type)) {
    return c.json({ error: "Trip photos must be JPEG, PNG, WebP, GIF, or AVIF" }, 400);
  }
  if (photo.size === 0 || photo.size > MAX_TRIP_PHOTO_BYTES) {
    return c.json({ error: "Trip photos must be between 1 byte and 10 MB" }, 400);
  }

  await c.env.TRIP_PHOTOS.put(
    tripPhotoKey(identity.householdId, trip.id),
    photo.stream(),
    { httpMetadata: { contentType: photo.type } },
  );
  return c.json(await repo.update(trip.id, {
    photoUrl: `/api/trips/${encodeURIComponent(trip.id)}/photo?v=${Date.now()}`,
  }));
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

// Read-only, and open to viewers for the same reason the booking list is: it
// returns exactly what GET /:tripId/bookings already returns, grouped. The
// confirmation numbers the matcher compares are decrypted inside the repo and
// never reach this response — see DuplicateRepo.forTrip.
trips.get("/:tripId/duplicates", async (c) =>
  c.json({
    groups: await new DuplicateRepo(c.get("db"), c.get("identity"), c.get("ring")).forTrip(
      c.req.param("tripId"),
    ),
  }),
);

trips.post("/:tripId/duplicates/merge", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = mergeDuplicatesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid merge", details: parsed.error.issues }, 400);
  }
  // Deleting the merged-away rows is the point, so the failure modes matter:
  // an id outside this trip (NotFoundError, 404), a cross-kind pair or an
  // empty merge list (ValidationError, 400), and a viewer (ForbiddenError,
  // 403) all throw before any statement runs, and the batch itself is atomic.
  return c.json(
    await new DuplicateRepo(c.get("db"), c.get("identity"), c.get("ring")).merge(
      c.req.param("tripId"),
      parsed.data.keepId,
      parsed.data.mergeIds,
    ),
  );
});

trips.post("/:tripId/duplicates/dismiss", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = dismissDuplicatesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid dismissal", details: parsed.error.issues }, 400);
  }
  await new DuplicateRepo(c.get("db"), c.get("identity"), c.get("ring")).dismiss(
    c.req.param("tripId"),
    parsed.data.bookingIds,
  );
  return c.body(null, 204);
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
