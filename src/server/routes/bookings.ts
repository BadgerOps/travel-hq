import { Hono } from "hono";
import { z } from "zod";
import { BookingRepo, BOOKING_STATUSES } from "../repos/booking.js";
import type { UpdateBookingInput } from "../repos/booking.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import { ForbiddenError, NotFoundError } from "../repos/base.js";
import { BOOKING_KINDS } from "../schemas/booking-kinds.js";
import { isValidInstant, isValidTimezone } from "../time.js";
import { parseMime } from "../ingest/mime.js";
import type { AppEnv } from "../index.js";

const setStatusSchema = z.object({ status: z.enum(BOOKING_STATUSES) });

/**
 * `.nullable().optional()` is the tri-state at the HTTP boundary, exactly as
 * updateTripSchema established: the key may be absent (leave unchanged), null
 * (clear), or a value (replace). `kind`, `title` and `status` are optional but
 * never null — a booking must keep all three.
 *
 * `.strict()` for the same reason as updateTripSchema: an edit form that PUTs
 * back the whole object it was shown would otherwise send `id`,
 * `personIds`, or `confirmationNumberMasked`, which a permissive schema would
 * silently drop — leaving the operator believing they had edited a field they
 * had not, and (for the masked confirmation number) silently discarding an
 * edit that must instead be a loud 400.
 *
 * The timestamp/zone PAIRING and the startsAt <= endsAt ORDERING are
 * deliberately not checked here, unlike createBookingSchema: a partial patch is
 * only valid against the stored row (clearing `startsAtTz` alone breaks a
 * booking whose `startsAt` this request never mentions, and moving `endsAt`
 * alone can invert a range against a `startsAt` this request never mentions
 * either), and only BookingRepo.update can see that row.
 */
const updateBookingSchema = z
  .object({
    kind: z.enum(BOOKING_KINDS).optional(),
    title: z.string().min(1).optional(),
    location: z.string().nullable().optional(),
    startsAt: z
      .string()
      .refine(isValidInstant, {
        message: "startsAt must be an ISO-8601 instant with an explicit offset or Z",
      })
      .nullable()
      .optional(),
    startsAtTz: z
      .string()
      .refine(isValidTimezone, { message: "startsAtTz must be a valid IANA timezone" })
      .nullable()
      .optional(),
    endsAt: z
      .string()
      .refine(isValidInstant, {
        message: "endsAt must be an ISO-8601 instant with an explicit offset or Z",
      })
      .nullable()
      .optional(),
    endsAtTz: z
      .string()
      .refine(isValidTimezone, { message: "endsAtTz must be a valid IANA timezone" })
      .nullable()
      .optional(),
    // `.min(1)`: an empty string is not a confirmation number. Clearing one is
    // spelled `null`, so "" can only be an accident.
    confirmationNumber: z.string().min(1).nullable().optional(),
    // `.nonnegative()`: spend and points usage are not a signed ledger — see
    // assertNonNegativeAmount in repos/validation.ts. `null` still clears.
    costCents: z.number().int().nonnegative().nullable().optional(),
    pointsUsed: z.number().int().nonnegative().nullable().optional(),
    pointsProgram: z.string().nullable().optional(),
    status: z.enum(BOOKING_STATUSES).optional(),
    // Replaced wholesale when present, and validated against the effective
    // kind by parseDetails inside the repo.
    details: z.unknown().optional(),
  })
  .strict();

export const bookings = new Hono<AppEnv>();

export type BookingSourceArtifact = {
  inboundEmailId: string;
  from: string;
  to: string;
  subject: string | null;
  receivedAt: string;
  textBody: string | null;
  calendars: string[];
};

bookings.get("/:bookingId/artifact", async (c) => {
  const identity = c.get("identity");
  if (identity.role === "viewer") {
    throw new ForbiddenError("Viewers may not access source email artifacts");
  }
  const booking = await new BookingRepo(
    c.get("db"),
    identity,
    c.get("ring"),
  ).findById(c.req.param("bookingId"));
  if (!booking) throw new NotFoundError("Booking not found in this household");
  if (!booking.sourceInboundEmailId) {
    return c.json({ artifact: null });
  }
  const email = await new InboundEmailRepo(c.get("db"), identity)
    .findById(booking.sourceInboundEmailId);
  if (!email) throw new NotFoundError("Source email not found in this household");
  const parsed = parseMime(email.raw);
  const artifact: BookingSourceArtifact = {
    inboundEmailId: email.id,
    from: email.from,
    to: email.to,
    subject: parsed.subject ?? email.subject,
    receivedAt: email.receivedAt,
    textBody: parsed.textBody,
    calendars: parsed.calendars,
  };
  return c.json({ artifact });
});

bookings.put("/:bookingId", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateBookingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid booking", details: parsed.error.issues }, 400);
  }
  // NotFoundError (404), ForbiddenError (403), the repo's ValidationErrors
  // (400 — unpaired timezone, masked confirmation number, details that do not
  // match the kind) and a ZodError from parseDetails all reach app.onError,
  // which is the single place that decides status. No local try/catch.
  return c.json(
    await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).update(
      c.req.param("bookingId"),
      parsed.data satisfies UpdateBookingInput,
    ),
  );
});

bookings.delete("/:bookingId", async (c) => {
  // Permanent, and deliberately not the same control as "cancel": the trip
  // page offers this only for a booking a human has identified as a duplicate
  // import. Unknown/cross-household ids (NotFoundError, 404) and a viewer role
  // (ForbiddenError, 403) reach app.onError.
  await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).delete(
    c.req.param("bookingId"),
  );
  return c.body(null, 204);
});

bookings.put("/:bookingId/status", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = setStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid status", details: parsed.error.issues }, 400);
  }
  // Unknown/cross-household booking (NotFoundError, 404) and a viewer role
  // (ForbiddenError, 403) both reach app.onError.
  await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).setStatus(
    c.req.param("bookingId"),
    parsed.data.status,
  );
  return c.body(null, 204);
});
