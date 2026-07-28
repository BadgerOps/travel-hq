import type { Context, Next } from "hono";
import type { AppEnv } from "./index.js";
import { ForbiddenError, NotFoundError } from "./repos/base.js";
import { TripAccessRepo } from "./repos/trip-access.js";

/**
 * Converts a trip-specific editor permission into the ordinary "adult"
 * repository capability for this request only. The account remains a
 * household viewer everywhere else.
 */
export async function authorizeTrip(c: Context<AppEnv>, next: Next, tripId: string): Promise<void> {
  const identity = c.get("identity");
  const access = await new TripAccessRepo(c.get("db"), identity).roleForTrip(tripId);
  if (!access) {
    // Do not disclose whether the trip exists but was not shared.
    throw new NotFoundError("Trip not found in this household");
  }
  if (access === "editor" || access === "viewer") {
    c.set("identity", {
      ...identity,
      role: access === "editor" ? "adult" : "viewer",
      tripRole: access,
    });
  }
  await next();
}

export async function authorizeBooking(c: Context<AppEnv>, next: Next, bookingId: string): Promise<void> {
  const repo = new TripAccessRepo(c.get("db"), c.get("identity"));
  const tripId = await repo.tripIdForBooking(bookingId);
  if (!tripId) throw new NotFoundError("Booking not found in this household");
  await authorizeTrip(c, next, tripId);
}

export async function authorizeChecklistItem(
  c: Context<AppEnv>,
  next: Next,
  itemId: string,
): Promise<void> {
  const repo = new TripAccessRepo(c.get("db"), c.get("identity"));
  const tripId = await repo.tripIdForChecklistItem(itemId);
  if (!tripId) throw new NotFoundError("Checklist item not found in this household");
  await authorizeTrip(c, next, tripId);
}

export async function requireHouseholdWriter(c: Context<AppEnv>, next: Next): Promise<void> {
  if (c.get("identity").role === "viewer") {
    throw new ForbiddenError("This account only has access to shared trips");
  }
  await next();
}
