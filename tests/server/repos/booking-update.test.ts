import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError, ValidationError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const viewer: HouseholdContext = { householdId: "hh-a", userId: "u2", role: "viewer" };
const otherHousehold: HouseholdContext = { householdId: "hh-b", userId: "u3", role: "owner" };

async function seed(): Promise<void> {
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind(id, id, now)
      .run();
  }
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
    .bind("t1", "hh-a", "Glacier", now)
    .run();
}

beforeEach(seed);

function repoFor(ctx: HouseholdContext): BookingRepo {
  return new BookingRepo(env.DB, ctx, ring);
}

/** The excursion this feature exists for: a tour with pickup logistics. */
async function excursion(): Promise<string> {
  const created = await repoFor(owner).create({
    tripId: "t1",
    kind: "activity",
    title: "Going-to-the-Sun Road Red Bus tour",
    startsAt: "2026-10-09T19:30:00.000Z",
    startsAtTz: "America/Denver",
    details: { pickupTime: "1:30 PM", pickupLocation: "Quarter Circle/West Side Parking Lot" },
  });
  return created.id;
}

describe("BookingRepo.update", () => {
  it("patches only the keys it is given", async () => {
    const id = await excursion();
    const updated = await repoFor(owner).update(id, { title: "Red Bus tour (afternoon)" });

    expect(updated.title).toBe("Red Bus tour (afternoon)");
    // Everything else is untouched — that is what makes an absent key mean
    // "leave it alone" rather than "clear it".
    expect(updated.startsAt).toBe("2026-10-09T19:30:00.000Z");
    expect(updated.startsAtTz).toBe("America/Denver");
    expect(updated.details).toEqual({
      pickupTime: "1:30 PM",
      pickupLocation: "Quarter Circle/West Side Parking Lot",
    });
  });

  it("edits the pickup time, location and return details of an excursion", async () => {
    const id = await excursion();
    const updated = await repoFor(owner).update(id, {
      location: "West Glacier, MT",
      details: {
        pickupTime: "1:30 PM",
        pickupLocation: "Quarter Circle/West Side Parking Lot",
        arriveMinutesBefore: 15,
        returnTime: "5:00 PM",
      },
    });

    expect(updated.location).toBe("West Glacier, MT");
    expect(updated.details).toEqual({
      pickupTime: "1:30 PM",
      pickupLocation: "Quarter Circle/West Side Parking Lot",
      arriveMinutesBefore: 15,
      returnTime: "5:00 PM",
    });
  });

  it("replaces details wholesale rather than merging them", async () => {
    // A merge would make it impossible to remove a key the extractor got
    // wrong, which is half of why editing exists.
    const id = await excursion();
    const updated = await repoFor(owner).update(id, { details: { pickupTime: "2:00 PM" } });
    expect(updated.details).toEqual({ pickupTime: "2:00 PM" });
  });

  it("clears a nullable field when sent null, and leaves it when absent", async () => {
    const id = await excursion();
    const cleared = await repoFor(owner).update(id, { startsAt: null, startsAtTz: null });
    expect(cleared.startsAt).toBeNull();
    expect(cleared.startsAtTz).toBeNull();

    const untouched = await repoFor(owner).update(cleared.id, { title: "Still here" });
    expect(untouched.startsAt).toBeNull();
  });

  it("rejects a patch that leaves a timestamp without its zone", async () => {
    // The stored startsAt survives this patch, so dropping only the zone is
    // exactly as broken as posting an unzoned timestamp — and it is the shape
    // a partial patch makes reachable for the first time.
    const id = await excursion();
    await expect(repoFor(owner).update(id, { startsAtTz: null })).rejects.toThrow(ValidationError);
    expect((await repoFor(owner).findById(id))?.startsAtTz).toBe("America/Denver");
  });

  it("rejects an unparseable timestamp and an unknown zone", async () => {
    const id = await excursion();
    await expect(
      repoFor(owner).update(id, { startsAt: "not a date", startsAtTz: "America/Denver" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repoFor(owner).update(id, { startsAt: "2026-10-09T19:30:00.000Z", startsAtTz: "Mars/Olympus" }),
    ).rejects.toThrow(ValidationError);
  });

  it("validates details against the effective kind", async () => {
    const id = await excursion();
    // A flight needs a carrier, a number and two IATA codes.
    await expect(repoFor(owner).update(id, { kind: "flight" })).rejects.toThrow(ValidationError);

    const flight = await repoFor(owner).update(id, {
      kind: "flight",
      details: {
        carrier: "Alaska",
        flightNumber: "AS 401",
        originIata: "fca",
        destinationIata: "sea",
      },
    });
    expect(flight.kind).toBe("flight");
    // The per-kind schema still normalises, exactly as it does on create.
    expect(flight.details).toMatchObject({ originIata: "FCA", destinationIata: "SEA" });
  });

  it("rejects a kind outside BOOKING_KINDS", async () => {
    const id = await excursion();
    await expect(
      repoFor(owner).update(id, { kind: "helicopter", details: {} }),
    ).rejects.toThrow(ValidationError);
  });

  it("re-encrypts a new confirmation number and refuses a masked one", async () => {
    const id = await excursion();
    const updated = await repoFor(owner).update(id, { confirmationNumber: "REDBUS88" });
    expect(updated.confirmationNumberMasked).toBe("••••US88");
    expect(await repoFor(owner).revealConfirmation(id)).toBe("REDBUS88");

    // An edit form that PUTs back what it was shown must fail loudly rather
    // than encrypting the bullets over the real code.
    await expect(
      repoFor(owner).update(id, { confirmationNumber: "••••US88" }),
    ).rejects.toThrow(ValidationError);
    expect(await repoFor(owner).revealConfirmation(id)).toBe("REDBUS88");

    const cleared = await repoFor(owner).update(id, { confirmationNumber: null });
    expect(cleared.confirmationNumberMasked).toBeNull();
  });

  it("moves a booking through its statuses", async () => {
    const id = await excursion();
    expect((await repoFor(owner).update(id, { status: "booked" })).status).toBe("booked");
    await expect(
      repoFor(owner).update(id, { status: "gone" as never }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an empty title", async () => {
    const id = await excursion();
    await expect(repoFor(owner).update(id, { title: "   " })).rejects.toThrow(ValidationError);
  });

  it("is 404 for an unknown id and for another household's booking", async () => {
    const id = await excursion();
    await expect(repoFor(owner).update("nope", { title: "x" })).rejects.toThrow(NotFoundError);
    await expect(repoFor(otherHousehold).update(id, { title: "x" })).rejects.toThrow(NotFoundError);
    expect((await repoFor(owner).findById(id))?.title).toBe("Going-to-the-Sun Road Red Bus tour");
  });

  it("is 403 for a viewer", async () => {
    const id = await excursion();
    await expect(repoFor(viewer).update(id, { title: "x" })).rejects.toThrow(ForbiddenError);
  });
});
