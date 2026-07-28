import { Hono } from "hono";
import { z } from "zod";
import { BookingRepo, BOOKING_STATUSES } from "../repos/booking.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import { ForbiddenError, NotFoundError } from "../repos/base.js";
import { parseMime } from "../ingest/mime.js";
import type { AppEnv } from "../index.js";

const setStatusSchema = z.object({ status: z.enum(BOOKING_STATUSES) });

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
