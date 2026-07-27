import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError, ValidationError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

async function seed(): Promise<string> {
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
  return "t1";
}

beforeEach(seed);

describe("BookingRepo", () => {
  it("creates a booking and masks the confirmation number in list output", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    await repo.create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} });
    const list = await repo.listByTrip("t1");
    expect(list[0]?.confirmationNumberMasked).toBe("••••X4T2");
    expect(JSON.stringify(list)).not.toContain("ABCDX4T2");
  });

  it("retains source-email provenance and enforces household scope", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO inbound_email (id, household_id, from_address, to_address, raw, status, received_at) VALUES (?,?,?,?,?,?,?)",
    ).bind("mail-a", "hh-a", "sender@example.com", "trips@example.com", "raw", "extracted", now).run();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind("hh-b", "B", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO inbound_email (id, household_id, from_address, to_address, raw, status, received_at) VALUES (?,?,?,?,?,?,?)",
    ).bind("mail-b", "hh-b", "sender@example.com", "trips@example.com", "raw", "extracted", now).run();

    const repo = new BookingRepo(env.DB, ctxA, ring);
    const booking = await repo.create({
      tripId: "t1",
      sourceInboundEmailId: "mail-a",
      kind: "other",
      title: "Hotel",
      details: {},
    });
    expect(booking.sourceInboundEmailId).toBe("mail-a");

    await expect(repo.create({
      tripId: "t1",
      sourceInboundEmailId: "mail-b",
      kind: "other",
      title: "Cross tenant",
      details: {},
    })).rejects.toThrow(NotFoundError);
  });

  it("reveals the confirmation number through revealConfirmation", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    const b = await repo.create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} });
    expect(await repo.revealConfirmation(b.id)).toBe("ABCDX4T2");
  });

  it("a viewer cannot reveal a confirmation number", async () => {
    const b = await new BookingRepo(env.DB, ctxA, ring).create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} });
    const viewer = new BookingRepo(env.DB, { ...ctxA, role: "viewer" }, ring);
    await expect(viewer.revealConfirmation(b.id)).rejects.toThrow(ForbiddenError);
  });

  it("rejects a masked confirmation number handed back as plaintext", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    await expect(repo.create({ tripId: "t1", kind: "other", title: "Hotel", confirmationNumber: "••••X4T2", details: {} })).rejects.toThrow(ValidationError);
  });

  it("rejects an unpaired timezone", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    await expect(repo.create({ tripId: "t1", kind: "other", title: "No tz", startsAt: "2026-10-10T02:00:00Z", details: {} })).rejects.toThrow(ValidationError);
  });

  it("listByTrip 404s for an unknown trip", async () => {
    await expect(new BookingRepo(env.DB, ctxA, ring).listByTrip("nope")).rejects.toThrow(NotFoundError);
  });

  it("assignPerson links the person to the booking and the trip, and setStatus updates", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    const b = await repo.create({ tripId: "t1", kind: "other", title: "Hotel", details: {} });
    await repo.assignPerson(b.id, "p-ava");
    await repo.setStatus(b.id, "booked");
    const list = await repo.listByTrip("t1");
    expect(list[0]?.personIds).toEqual(["p-ava"]);
    expect(list[0]?.status).toBe("booked");
  });

  it("unassignPerson removes only the booking link and keeps trip membership", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    const booking = await repo.create({
      tripId: "t1",
      kind: "other",
      title: "Hotel",
      details: {},
    });
    await repo.assignPerson(booking.id, "p-ava");
    await repo.unassignPerson(booking.id, "p-ava");

    expect((await repo.findById(booking.id))?.personIds).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT person_id FROM trip_person WHERE trip_id = ? AND person_id = ?",
      ).bind("t1", "p-ava").first(),
    ).toEqual({ person_id: "p-ava" });
  });

  it("maps travelers onto multiple bookings from the batched join lookup", async () => {
    const repo = new BookingRepo(env.DB, ctxA, ring);
    const first = await repo.create({
      tripId: "t1", kind: "other", title: "Hotel", details: {},
    });
    const second = await repo.create({
      tripId: "t1", kind: "other", title: "Dinner", details: {},
    });
    await repo.assignPerson(first.id, "p-ava");

    const list = await repo.listByTrip("t1");
    expect(
      Object.fromEntries(list.map((booking) => [booking.title, booking.personIds])),
    ).toEqual({
      Hotel: ["p-ava"],
      Dinner: [],
    });
    expect(list.find((booking) => booking.id === second.id)?.personIds).toEqual([]);
  });
});
