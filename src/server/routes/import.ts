import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../repos/base.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import type { DraftBooking } from "../repos/draft-booking.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import type { InboundEmail } from "../repos/inbound-email.js";
import { BookingRepo } from "../repos/booking.js";
import type { Booking } from "../repos/booking.js";
import { TripRepo } from "../repos/trip.js";
import type { Trip } from "../repos/trip.js";
import { PersonRepo } from "../repos/person.js";
import { BOOKING_KINDS, parseDetails } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";
import type { AppEnv } from "../index.js";

/**
 * The review queue's per-email metadata — deliberately NOT the whole
 * InboundEmail: `raw` is the full RFC 5322 message text and belongs behind
 * the explicit GET /api/import/emails/:emailId "view original" route, not
 * repeated per group in a list response.
 */
export type ImportQueueEmail = Pick<InboundEmail, "id" | "from" | "subject" | "receivedAt">;

/** One source email and its still-pending drafts — the queue's unit of review. */
export type ImportQueueGroup = {
  email: ImportQueueEmail;
  drafts: DraftBooking[];
};

/**
 * What POST /api/import/drafts/:draftId/accept answers: the now-accepted
 * draft, the booking created from it, and the trip it landed on (freshly
 * created when the request carried `newTrip`).
 */
export type AcceptDraftResult = {
  draft: DraftBooking;
  booking: Booking;
  trip: Trip;
};

/**
 * Same tri-state convention as UpdateDraftBookingInput (and the person/
 * settings update schemas): an absent key keeps the stored value, null
 * clears a nullable field. Pairing (a timestamp needs its zone) cannot be
 * fully checked here — either half may be stored rather than sent — so the
 * repo validates the MERGED result; these refinements only stop a value
 * that could never be valid. `.strict()` so a stray key 400s by name
 * instead of being silently dropped.
 */
const updateDraftSchema = z
  .object({
    kind: z.enum(BOOKING_KINDS).optional(),
    title: z.string().min(1).optional(),
    location: z.string().min(1).nullable().optional(),
    startsAt: z
      .string()
      .refine(isValidTimestamp, { message: "startsAt must be a parseable timestamp" })
      .nullable()
      .optional(),
    startsAtTz: z
      .string()
      .refine(isValidTimezone, { message: "startsAtTz must be a valid IANA timezone" })
      .nullable()
      .optional(),
    endsAt: z
      .string()
      .refine(isValidTimestamp, { message: "endsAt must be a parseable timestamp" })
      .nullable()
      .optional(),
    endsAtTz: z
      .string()
      .refine(isValidTimezone, { message: "endsAtTz must be a valid IANA timezone" })
      .nullable()
      .optional(),
    confirmationNumber: z.string().min(1).nullable().optional(),
  })
  .strict();

/** Mirrors createTripSchema in routes/trips.ts — TripRepo.create's shape. */
const newTripSchema = z
  .object({
    title: z.string().min(1),
    destination: z.string().min(1).optional(),
    startsOn: z.string().min(1).optional(),
    endsOn: z.string().min(1).optional(),
  })
  .strict();

/**
 * Discriminated accept target: an existing trip's id XOR the fields for a
 * new trip seeded from the draft. `personIds` optionally puts travellers on
 * the created booking, through the same assignPerson path (and therefore
 * the same booking_person + trip_person writes) manual entry uses.
 */
const acceptDraftSchema = z
  .object({
    tripId: z.string().min(1).optional(),
    newTrip: newTripSchema.optional(),
    personIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((v) => (v.tripId === undefined) !== (v.newTrip === undefined), {
    message: "Provide exactly one of tripId (an existing trip) or newTrip",
    path: ["tripId"],
  });

export type AcceptDraftInput = z.infer<typeof acceptDraftSchema>;

/**
 * The slice of a draft's extraction payload that has no draft column of its
 * own and rides along into the booking at accept. Parsed defensively —
 * `extracted` is opaque JSON and a payload this schema cannot read simply
 * contributes nothing, it must not block an accept.
 */
const extractedCarrySchema = z.object({
  costCents: z.number().int().nullish(),
  details: z.unknown().optional(),
});

function carriedExtras(draft: DraftBooking): { costCents: number | null; details: unknown } {
  const parsed = extractedCarrySchema.safeParse(draft.extracted ?? {});
  if (!parsed.success) return { costCents: null, details: {} };
  return {
    costCents: parsed.data.costCents ?? null,
    details: parsed.data.details ?? {},
  };
}

export const imports = new Hono<AppEnv>();

/**
 * The pending queue, grouped by source email: groups newest-email-first
 * (the review UI's reading order), drafts within a group in extraction
 * order. Readable by every role — review is a read until a button is
 * pressed.
 */
imports.get("/queue", async (c) => {
  const identity = c.get("identity");
  const db = c.get("db");

  // listByStatus("pending") is oldest-first, so within each group the
  // drafts stay in extraction order.
  const pending = await new DraftBookingRepo(db, identity).listByStatus("pending");
  const byEmail = new Map<string, DraftBooking[]>();
  for (const draft of pending) {
    const group = byEmail.get(draft.inboundEmailId);
    if (group) group.push(draft);
    else byEmail.set(draft.inboundEmailId, [draft]);
  }

  // list() is newest-first — that ordering IS the group order. Filtering
  // the household's own mailbox beats N findById round-trips at household
  // scale, and the mapping strips `raw` from what is a list response.
  const emails = await new InboundEmailRepo(db, identity).list();
  const groups: ImportQueueGroup[] = emails
    .filter((email) => byEmail.has(email.id))
    .map((email) => ({
      email: { id: email.id, from: email.from, subject: email.subject, receivedAt: email.receivedAt },
      drafts: byEmail.get(email.id)!,
    }));
  return c.json(groups);
});

/**
 * The full stored message for the queue's "view original" link — subject,
 * envelope addresses, and the raw text the drafts were extracted from.
 * Read-only, so viewers may see it too.
 */
imports.get("/emails/:emailId", async (c) => {
  const email = await new InboundEmailRepo(c.get("db"), c.get("identity")).findById(
    c.req.param("emailId"),
  );
  // findById resolves undefined for unknown AND cross-household ids alike
  // (the scoped query cannot tell them apart, by design); the thrown
  // NotFoundError funnels through app.onError like every other 404.
  if (!email) throw new NotFoundError("Inbound email not found in this household");
  return c.json(email);
});

/**
 * Edit-before-accept: every extracted field is a suggestion, not truth.
 * Pending-only, tri-state; the repo validates the merged result
 * (ValidationError 400), unknown/cross-household ids 404, viewers 403 —
 * all via app.onError.
 */
imports.put("/drafts/:draftId", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // A JSON.parse-level SyntaxError, not a domain error — handled here,
    // directly, matching routes/settings.ts and routes/people.ts.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateDraftSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid draft update", details: parsed.error.issues }, 400);
  }
  return c.json(
    await new DraftBookingRepo(c.get("db"), c.get("identity")).update(
      c.req.param("draftId"),
      parsed.data,
    ),
  );
});

/**
 * Accept a pending draft onto a trip: create the booking through the SAME
 * path manual entry uses (BookingRepo.create encrypts the confirmation
 * number; assignPerson writes booking_person AND trip_person), then mark
 * the draft accepted with the new booking's id. `newTrip` creates the trip
 * first, seeded by the client from the draft's dates/destination — this is
 * also how several emails join one trip: accept the first with newTrip,
 * the rest with that trip's id.
 */
imports.post("/drafts/:draftId/accept", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = acceptDraftSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid accept request", details: parsed.error.issues }, 400);
  }

  const identity = c.get("identity");
  const db = c.get("db");
  const ring = c.get("ring");
  const drafts = new DraftBookingRepo(db, identity);

  // Everything below is ordered validate-first, write-last, so a request
  // that is going to fail fails before it has created anything: the draft
  // must be pending (404/400), the extracted details must fit the draft's
  // kind (400), and every personId must exist in this household (404) —
  // only then is the trip created/resolved and the booking written.
  const draft = await drafts.requirePending(c.req.param("draftId"));

  const { costCents, details } = carriedExtras(draft);
  let parsedDetails: unknown;
  try {
    // The same per-kind funnel BookingRepo.create runs (kept there too,
    // belt and braces); run here so a reviewer who reclassified the kind
    // past what extraction captured gets a named, actionable 400 instead
    // of a bare ZodError.
    parsedDetails = parseDetails(draft.kind, details);
  } catch {
    throw new ValidationError(
      `The extracted details do not satisfy kind "${draft.kind}"; set a kind the details fit (or "other") before accepting`,
    );
  }

  if (parsed.data.personIds !== undefined && parsed.data.personIds.length > 0) {
    const people = await new PersonRepo(db, identity, ring).list();
    const known = new Set(people.map((p) => p.id));
    if (parsed.data.personIds.some((id) => !known.has(id))) {
      throw new NotFoundError("Person not found in this household");
    }
  }

  const trips = new TripRepo(db, identity);
  let trip: Trip;
  if (parsed.data.newTrip !== undefined) {
    // A viewer throws ForbiddenError inside create(), before any write.
    trip = await trips.create(parsed.data.newTrip);
  } else {
    const existing = await trips.findById(parsed.data.tripId!);
    if (!existing) throw new NotFoundError("Trip not found in this household");
    trip = existing;
  }

  const bookings = new BookingRepo(db, identity, ring);
  const booking = await bookings.create({
    tripId: trip.id,
    kind: draft.kind,
    title: draft.title,
    // A reviewed-and-accepted confirmation email is a real booking, not a
    // plan — the same default the booking dialog lands on.
    status: "booked",
    details: parsedDetails,
    ...(draft.location === null ? {} : { location: draft.location }),
    // The repo guarantees a stored timestamp is paired with its zone, so
    // the non-null assertions cannot fire in practice.
    ...(draft.startsAt === null ? {} : { startsAt: draft.startsAt, startsAtTz: draft.startsAtTz! }),
    ...(draft.endsAt === null ? {} : { endsAt: draft.endsAt, endsAtTz: draft.endsAtTz! }),
    ...(draft.confirmationNumber === null ? {} : { confirmationNumber: draft.confirmationNumber }),
    ...(costCents === null ? {} : { costCents }),
  });

  for (const personId of parsed.data.personIds ?? []) {
    await bookings.assignPerson(booking.id, personId);
  }

  const accepted = await drafts.markAccepted(draft.id, booking.id);
  return c.json({ draft: accepted, booking, trip } satisfies AcceptDraftResult, 201);
});

/**
 * pending → dismissed. The row is kept for audit (there is no delete on
 * DraftBookingRepo at all); it simply stops appearing in the queue.
 * NotFoundError 404, ValidationError 400 for an already-resolved draft,
 * ForbiddenError 403 for a viewer — all via app.onError.
 */
imports.post("/drafts/:draftId/dismiss", async (c) =>
  c.json(
    await new DraftBookingRepo(c.get("db"), c.get("identity")).markDismissed(
      c.req.param("draftId"),
    ),
  ),
);
