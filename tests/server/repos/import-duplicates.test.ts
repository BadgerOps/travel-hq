import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import { ImportReviewRepo } from "../../../src/server/repos/import-review.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { ConflictError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import type { CreateDraftBookingInput } from "../../../src/server/repos/draft-booking.js";
import type { CreateBookingInput } from "../../../src/server/repos/booking.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const TZ = "America/Los_Angeles";

function reviews() {
  return new ImportReviewRepo(env.DB, ctx, ring);
}
function bookings() {
  return new BookingRepo(env.DB, ctx, ring);
}

/** The flight as an already-accepted booking. */
function booking(over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    tripId: "t1",
    kind: "flight",
    title: "Delta 1423 SEA-JFK",
    startsAt: "2026-09-04T14:30:00.000Z",
    startsAtTz: TZ,
    details: { carrier: "Delta", flightNumber: "1423", originIata: "SEA", destinationIata: "JFK" },
    ...over,
  };
}

/** The same flight as a pending import. */
let ordinal = 0;
function draftInput(over: Partial<CreateDraftBookingInput> = {}): CreateDraftBookingInput {
  return {
    inboundEmailId: "mail-1",
    ordinal: ordinal++,
    kind: "flight",
    title: "Delta 1423 SEA-JFK",
    startsAt: "2026-09-04T14:30:00.000Z",
    startsAtTz: TZ,
    source: "ai",
    // Accepting a draft re-validates `extracted.details` against its kind, so
    // a fixture that is ever accepted needs real per-kind details.
    extracted: {
      details: { carrier: "Delta", flightNumber: "1423", originIata: "SEA", destinationIata: "JFK" },
    },
    ...over,
  };
}

/** The lodging counterpart, with details its kind's schema accepts. */
function lodgingDraft(over: Partial<CreateDraftBookingInput> = {}): CreateDraftBookingInput {
  return draftInput({
    kind: "lodging",
    startsAt: "2026-09-04T23:00:00.000Z",
    extracted: { details: { propertyName: "Hotel Kabuki" } },
    ...over,
  });
}

async function makeDrafts(...inputs: CreateDraftBookingInput[]): Promise<string[]> {
  const created = await new DraftBookingRepo(env.DB, ctx).createMany(inputs);
  // createMany returns every draft for the email, in ordinal order.
  return created.filter((d) => d.status === "pending").map((d) => d.id);
}

beforeEach(async () => {
  ordinal = 0;
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM booking_duplicate_dismissal");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,starts_on,ends_on,created_at) VALUES (?,?,?,?,?,?)")
    .bind("t1", "hh-a", "Tokyo", "2026-09-01", "2026-09-10", now).run();
  await new InboundEmailRepo(env.DB, ctx).create({
    from: "delta@example.com",
    to: "trips@example.com",
    subject: "Your itinerary",
    raw: "raw",
  }).then(async (email) => {
    // Fixed id so draftInput() can reference it without threading it around.
    await env.DB.prepare("UPDATE inbound_email SET id = 'mail-1' WHERE id = ?").bind(email.id).run();
  });
});

describe("ImportReviewRepo.listPending duplicate flags", () => {
  it("flags a pending draft that repeats a booking the household already has", async () => {
    await bookings().create(booking({ confirmationNumber: "HX7T2Q" }));
    await makeDrafts(draftInput({ confirmationNumber: "hx7-t2q", title: "DL1423" }));

    const [pending] = await reviews().listPending();
    expect(pending?.duplicates).toHaveLength(1);
    expect(pending?.duplicates[0]).toMatchObject({
      target: "booking",
      reason: "confirmation",
      confidence: "high",
      tripId: "t1",
      tripTitle: "Tokyo",
      title: "Delta 1423 SEA-JFK",
    });
    // The comparison decrypted the booking's confirmation number; the flag
    // must not carry it.
    expect(JSON.stringify(pending?.duplicates)).not.toContain("HX7T2Q");
  });

  it("flags two forwards of one email against each other, before either is a booking", async () => {
    const [a, b] = await makeDrafts(
      draftInput({ confirmationNumber: "HX7T2Q" }),
      draftInput({ confirmationNumber: "HX7T2Q", title: "DL 1423" }),
    );

    const pending = await reviews().listPending();
    const first = pending.find((p) => p.id === a);
    const second = pending.find((p) => p.id === b);
    expect(first?.duplicates[0]).toMatchObject({ target: "draft", id: b, tripId: null });
    expect(second?.duplicates[0]).toMatchObject({ target: "draft", id: a, tripId: null });
  });

  it("leaves an ordinary import unflagged", async () => {
    await bookings().create(booking({ confirmationNumber: "HX7T2Q" }));
    await makeDrafts(lodgingDraft({ title: "Hotel Kabuki", confirmationNumber: "8891204" }));
    expect((await reviews().listPending())[0]?.duplicates).toEqual([]);
  });

  it("ignores bookings on a cancelled trip", async () => {
    await bookings().create(booking({ confirmationNumber: "HX7T2Q" }));
    await env.DB.prepare("UPDATE trip SET status = 'cancelled' WHERE id = 't1'").run();
    await makeDrafts(draftInput({ confirmationNumber: "HX7T2Q" }));
    expect((await reviews().listPending())[0]?.duplicates).toEqual([]);
  });

  it("reports a weak match without claiming certainty", async () => {
    await bookings().create(
      booking({
        kind: "lodging",
        title: "Hotel Kabuki",
        location: "1625 Post St",
        startsAt: "2026-09-04T23:00:00.000Z",
        details: { propertyName: "Hotel Kabuki" },
      }),
    );
    await makeDrafts(lodgingDraft({ title: "Kabuki, room 2", location: "1625 Post St." }));
    expect((await reviews().listPending())[0]?.duplicates[0]).toMatchObject({
      reason: "same-slot",
      confidence: "medium",
    });
  });
});

describe("ImportReviewRepo.acceptIntoTrip duplicate guard", () => {
  it("refuses to import a draft that repeats a booking already on the trip", async () => {
    await bookings().create(booking({ confirmationNumber: "HX7T2Q" }));
    const [draftId] = await makeDrafts(draftInput({ confirmationNumber: "HX7T2Q" }));

    await expect(reviews().acceptIntoTrip([draftId!], "t1")).rejects.toThrow(ConflictError);
    // Nothing was written: the draft is still reviewable and the trip still
    // has exactly the one booking.
    expect((await bookings().listByTrip("t1")).length).toBe(1);
    expect((await reviews().listPending()).length).toBe(1);
  });

  it("names the trip and the count in the refusal", async () => {
    await bookings().create(booking({ confirmationNumber: "HX7T2Q" }));
    const [draftId] = await makeDrafts(draftInput({ confirmationNumber: "HX7T2Q" }));
    await expect(reviews().acceptIntoTrip([draftId!], "t1")).rejects.toThrow(
      /1 of these imports looks like a booking already on Tokyo/,
    );
  });

  it("imports it anyway when the reviewer says so", async () => {
    await bookings().create(booking({ confirmationNumber: "HX7T2Q" }));
    const [draftId] = await makeDrafts(draftInput({ confirmationNumber: "HX7T2Q" }));

    const result = await reviews().acceptIntoTrip([draftId!], "t1", true);
    expect(result.acceptedDraftIds).toEqual([draftId]);
    expect((await bookings().listByTrip("t1")).length).toBe(2);
  });

  it("refuses a batch that repeats itself, counting only the redundant copies", async () => {
    const ids = await makeDrafts(
      draftInput({ confirmationNumber: "HX7T2Q" }),
      draftInput({ confirmationNumber: "HX7T2Q" }),
      draftInput({ confirmationNumber: "HX7T2Q" }),
    );
    // Three copies of one flight: two are redundant, not three.
    await expect(reviews().acceptIntoTrip(ids, "t1")).rejects.toThrow(
      /2 of these imports look like bookings already in this selection/,
    );
  });

  it("does not block on a weak match, which is as often two real rooms", async () => {
    await bookings().create(
      booking({
        kind: "lodging",
        title: "Hotel Kabuki",
        location: "1625 Post St",
        startsAt: "2026-09-04T23:00:00.000Z",
        details: { propertyName: "Hotel Kabuki" },
      }),
    );
    const [draftId] = await makeDrafts(
      lodgingDraft({ title: "Kabuki, room 2", location: "1625 Post St." }),
    );
    await expect(reviews().acceptIntoTrip([draftId!], "t1")).resolves.toMatchObject({
      acceptedDraftIds: [draftId],
    });
  });

  it("does not block on a booking that lives on a different trip", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
      .bind("t2", "hh-a", "Kyoto", now).run();
    await bookings().create(booking({ tripId: "t2", confirmationNumber: "HX7T2Q" }));
    const [draftId] = await makeDrafts(draftInput({ confirmationNumber: "HX7T2Q" }));

    // The queue still flags it — the reviewer is told — but accepting into a
    // trip that does not hold the original is not a duplicate of that trip.
    expect((await reviews().listPending())[0]?.duplicates).toHaveLength(1);
    await expect(reviews().acceptIntoTrip([draftId!], "t1")).resolves.toBeTruthy();
  });
});

describe("ImportReviewRepo.createTripFromDrafts duplicate guard", () => {
  it("refuses a selection that repeats itself", async () => {
    const ids = await makeDrafts(
      draftInput({ confirmationNumber: "HX7T2Q" }),
      draftInput({ confirmationNumber: "HX7T2Q" }),
    );
    await expect(reviews().createTripFromDrafts({ draftIds: ids, title: "Tokyo again" }))
      .rejects.toThrow(ConflictError);
    // The refusal happens before the trip insert, so no half-built trip.
    const trips = await env.DB.prepare("SELECT COUNT(*) AS n FROM trip").first<{ n: number }>();
    expect(trips?.n).toBe(1);
  });

  it("creates the trip anyway when the reviewer says so", async () => {
    const ids = await makeDrafts(
      draftInput({ confirmationNumber: "HX7T2Q" }),
      draftInput({ confirmationNumber: "HX7T2Q" }),
    );
    const result = await reviews().createTripFromDrafts({
      draftIds: ids,
      title: "Tokyo again",
      allowDuplicates: true,
    });
    expect(result.acceptedDraftIds).toHaveLength(2);
  });

  it("does not consult other trips' bookings, since a new trip has none", async () => {
    await bookings().create(booking({ confirmationNumber: "HX7T2Q" }));
    const [draftId] = await makeDrafts(draftInput({ confirmationNumber: "HX7T2Q" }));
    await expect(
      reviews().createTripFromDrafts({ draftIds: [draftId!], title: "Second Tokyo" }),
    ).resolves.toBeTruthy();
  });
});
