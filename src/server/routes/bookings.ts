import { Hono } from "hono";
import { z } from "zod";
import { BookingRepo, BOOKING_STATUSES } from "../repos/booking.js";
import type { AppEnv } from "../index.js";

const setStatusSchema = z.object({ status: z.enum(BOOKING_STATUSES) });

export const bookings = new Hono<AppEnv>();

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
