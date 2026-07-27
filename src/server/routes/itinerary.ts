import { Hono } from "hono";
import { ItineraryRepo } from "../repos/itinerary.js";
import { BookingRepo } from "../repos/booking.js";
import type { AppEnv } from "../index.js";

export const itinerary = new Hono<AppEnv>();

itinerary.get("/trips/:tripId/itinerary", async (c) => {
  const repo = new ItineraryRepo(c.get("db"), c.get("identity"), c.get("ring"));
  const tripId = c.req.param("tripId");
  const personId = c.req.query("personId");
  return c.json(personId ? await repo.forPerson(tripId, personId) : await repo.forTrip(tripId));
});

itinerary.put("/bookings/:bookingId/people/:personId", async (c) => {
  // Unknown booking/person in this household (NotFoundError, 404) or a
  // viewer role (ForbiddenError, 403) throw here and are mapped by
  // app.onError.
  await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).assignPerson(
    c.req.param("bookingId"),
    c.req.param("personId"),
  );
  return c.body(null, 204);
});

itinerary.delete("/bookings/:bookingId/people/:personId", async (c) => {
  await new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).unassignPerson(
    c.req.param("bookingId"),
    c.req.param("personId"),
  );
  return c.body(null, 204);
});
