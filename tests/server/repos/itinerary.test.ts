import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { ItineraryRepo } from "../../../src/server/repos/itinerary.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
});

describe("ItineraryRepo", () => {
  it("groups a booking under its own local date", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    // 2026-10-10T02:00Z is 2026-10-09 19:00 in America/Los_Angeles.
    await bookings.create({ tripId: "t1", kind: "other", title: "Dinner", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "America/Los_Angeles", details: {} });
    const days = await new ItineraryRepo(env.DB, ctxA, ring).forTrip("t1");
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe("2026-10-09");
  });

  it("forPerson only includes bookings the person is on", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    const b = await bookings.create({ tripId: "t1", kind: "other", title: "Dinner", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "America/Los_Angeles", details: {} });
    await bookings.assignPerson(b.id, "p-ava");
    const mine = await new ItineraryRepo(env.DB, ctxA, ring).forPerson("t1", "p-ava");
    expect(mine).toHaveLength(1);
  });

  it("retains traveler assignments while grouping multiple bookings", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    const first = await bookings.create({
      tripId: "t1", kind: "other", title: "Dinner",
      startsAt: "2026-10-10T02:00:00Z", startsAtTz: "America/Los_Angeles",
      details: {},
    });
    await bookings.create({
      tripId: "t1", kind: "other", title: "Brunch",
      startsAt: "2026-10-10T17:00:00Z", startsAtTz: "America/Los_Angeles",
      details: {},
    });
    await bookings.assignPerson(first.id, "p-ava");

    const days = await new ItineraryRepo(env.DB, ctxA, ring).forTrip("t1");
    expect(days.flatMap((day) => day.bookings).map((booking) => [
      booking.title,
      booking.personIds,
    ])).toEqual([
      ["Dinner", ["p-ava"]],
      ["Brunch", []],
    ]);
  });

  it("shows a date-only lodging booking on every day of the stay", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    await bookings.create({
      tripId: "t1",
      kind: "lodging",
      title: "East Glacier KOA",
      details: {
        propertyName: "East Glacier KOA",
        checkInDate: "2026-08-05",
        checkOutDate: "2026-08-09",
      },
    });

    const days = await new ItineraryRepo(env.DB, ctxA, ring).forTrip("t1");
    expect(days.map((day) => [
      day.date,
      day.bookings[0]?.itineraryPosition,
    ])).toEqual([
      ["2026-08-05", "start"],
      ["2026-08-06", "ongoing"],
      ["2026-08-07", "ongoing"],
      ["2026-08-08", "ongoing"],
      ["2026-08-09", "end"],
    ]);
  });

  it("forTrip 404s for an unknown trip", async () => {
    await expect(new ItineraryRepo(env.DB, ctxA, ring).forTrip("nope")).rejects.toThrow(NotFoundError);
  });

  it("forPerson 404s for a person outside the household", async () => {
    await expect(new ItineraryRepo(env.DB, ctxA, ring).forPerson("t1", "nope")).rejects.toThrow(NotFoundError);
  });
});
