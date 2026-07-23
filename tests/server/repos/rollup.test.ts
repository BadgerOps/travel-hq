import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { CardRepo } from "../../../src/server/repos/card.js";
import { RollupRepo } from "../../../src/server/repos/rollup.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM card");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
});

describe("RollupRepo", () => {
  it("sums booked and planned but excludes draft from the total", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    await bookings.create({ tripId: "t1", kind: "other", title: "Booked", costCents: 20000, status: "booked", details: {} });
    await bookings.create({ tripId: "t1", kind: "other", title: "Planned", costCents: 5000, status: "planned", details: {} });
    await bookings.create({ tripId: "t1", kind: "other", title: "Draft", costCents: 50000, status: "draft", details: {} });
    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.totalCents).toBe(25000);
    expect(roll.draftCount).toBe(1);
  });

  it("aggregates points by program for booked/planned only; balance is null with no card portfolio", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    await bookings.create({ tripId: "t1", kind: "other", title: "P1", pointsUsed: 1000, pointsProgram: "UR", status: "booked", details: {} });
    await bookings.create({ tripId: "t1", kind: "other", title: "P2", pointsUsed: 500, pointsProgram: "UR", status: "planned", details: {} });
    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.points).toEqual([{ program: "UR", used: 1500, balance: null }]);
  });

  it("joins the household's card balance per program, summed across cards", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    await bookings.create({ tripId: "t1", kind: "other", title: "Flight", pointsUsed: 12_500, pointsProgram: "UR", status: "booked", details: {} });
    await bookings.create({ tripId: "t1", kind: "other", title: "Hotel", pointsUsed: 20_000, pointsProgram: "Bonvoy", status: "booked", details: {} });

    const cardsA = new CardRepo(env.DB, ctxA);
    await cardsA.createCard({ name: "Sapphire Reserve", pointsProgram: "UR", pointsBalance: 85_000 });
    await cardsA.createCard({ name: "Freedom", pointsProgram: "UR", pointsBalance: 15_000 });
    // A card with a program but no entered balance contributes nothing.
    await cardsA.createCard({ name: "Amex Gold", pointsProgram: "MR" });

    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.points).toEqual([
      { program: "Bonvoy", used: 20_000, balance: null },
      { program: "UR", used: 12_500, balance: 100_000 },
    ]);
  });

  it("never counts another household's card balances", async () => {
    const bookings = new BookingRepo(env.DB, ctxA, ring);
    await bookings.create({ tripId: "t1", kind: "other", title: "Flight", pointsUsed: 1000, pointsProgram: "UR", status: "booked", details: {} });
    await new CardRepo(env.DB, ctxB).createCard({ name: "Their CSR", pointsProgram: "UR", pointsBalance: 999_999 });

    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.points).toEqual([{ program: "UR", used: 1000, balance: null }]);
  });

  it("returns zeroes for a trip with no bookings", async () => {
    const roll = await new RollupRepo(env.DB, ctxA).forTrip("t1");
    expect(roll.totalCents).toBe(0);
    expect(roll.points).toEqual([]);
  });

  it("404s for an unknown trip", async () => {
    await expect(new RollupRepo(env.DB, ctxA).forTrip("nope")).rejects.toThrow(NotFoundError);
  });
});
