import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { DuplicateRepo } from "../../../src/server/repos/duplicates.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import type { CreateBookingInput } from "../../../src/server/repos/booking.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

const TZ = "America/Los_Angeles";

function bookings() {
  return new BookingRepo(env.DB, ctx, ring);
}
function duplicates(role: HouseholdContext["role"] = "owner") {
  return new DuplicateRepo(env.DB, { ...ctx, role }, ring);
}

/** A flight, imported. Override whatever the case is actually about. */
function flight(over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    tripId: "t1",
    kind: "flight",
    title: "Delta 1423 SEA-JFK",
    startsAt: "2026-09-04T14:30:00.000Z",
    startsAtTz: TZ,
    details: { carrier: "Delta", flightNumber: "1423", originIata: "sea", destinationIata: "jfk" },
    ...over,
  };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking_duplicate_dismissal");
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip_person");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Tokyo", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-sam", "hh-a", "Sam", now).run();
});

describe("DuplicateRepo.forTrip", () => {
  it("groups two imports of one flight and never returns the plaintext it matched on", async () => {
    await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    await bookings().create(flight({ title: "DL 1423", confirmationNumber: "hx7t-2q" }));

    const groups = await duplicates().forTrip("t1");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe("confirmation");
    expect(groups[0]?.bookings).toHaveLength(2);
    // The comparison decrypts; the response must not carry the result.
    expect(JSON.stringify(groups)).not.toContain("HX7T2Q");
    expect(groups[0]?.bookings[0]?.confirmationNumberMasked).toBe("••••7T2Q");
  });

  it("suggests keeping the most complete booking", async () => {
    const sparse = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    const full = await bookings().create(
      flight({
        confirmationNumber: "HX7T2Q",
        location: "SEA",
        endsAt: "2026-09-04T22:45:00.000Z",
        endsAtTz: "America/New_York",
        costCents: 41_200,
      }),
    );
    await bookings().assignPerson(full.id, "p-ava");

    const groups = await duplicates().forTrip("t1");
    expect(groups[0]?.suggestedKeepId).toBe(full.id);
    expect(groups[0]?.suggestedKeepId).not.toBe(sparse.id);
  });

  it("ignores cancelled bookings, so a rebooking is not reported as a duplicate", async () => {
    const old = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    await bookings().setStatus(old.id, "cancelled");
    await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));

    expect(await duplicates().forTrip("t1")).toEqual([]);
  });

  it("does not reach across trips or households", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t2", "hh-a", "Kyoto", now).run();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
    await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t-b", "hh-b", "Theirs", now).run();

    await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    await bookings().create(flight({ tripId: "t2", confirmationNumber: "HX7T2Q" }));

    expect(await duplicates().forTrip("t1")).toEqual([]);
    await expect(duplicates().forTrip("t-b")).rejects.toThrow(NotFoundError);
  });

  it("stops reporting a pair once it has been dismissed", async () => {
    const a = await bookings().create(flight({ kind: "lodging", title: "Hotel Kabuki", location: "1625 Post St", details: { propertyName: "Hotel Kabuki" } }));
    const b = await bookings().create(flight({ kind: "lodging", title: "Kabuki, room 2", location: "1625 Post St.", details: { propertyName: "Hotel Kabuki" } }));

    expect((await duplicates().forTrip("t1"))[0]?.reason).toBe("same-slot");
    await duplicates().dismiss("t1", [a.id, b.id]);
    expect(await duplicates().forTrip("t1")).toEqual([]);
  });

  it("dismissing twice, in either order, is idempotent", async () => {
    const a = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    const b = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    await duplicates().dismiss("t1", [a.id, b.id]);
    await duplicates().dismiss("t1", [b.id, a.id]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_duplicate_dismissal").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("rejects a dismissal naming a booking outside the trip", async () => {
    const a = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    await expect(duplicates().dismiss("t1", [a.id, "b-nope"])).rejects.toThrow(NotFoundError);
  });

  it("a viewer may see duplicates but not resolve them", async () => {
    const a = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    const b = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    expect(await duplicates("viewer").forTrip("t1")).toHaveLength(1);
    await expect(duplicates("viewer").dismiss("t1", [a.id, b.id])).rejects.toThrow(ForbiddenError);
    await expect(duplicates("viewer").merge("t1", a.id, [b.id])).rejects.toThrow(ForbiddenError);
  });
});

describe("DuplicateRepo.merge", () => {
  it("fills the keeper's blanks from the duplicate and deletes it", async () => {
    const keep = await bookings().create(flight({ title: "Delta 1423" }));
    const dup = await bookings().create(
      flight({
        title: "DL1423 SEA-JFK",
        location: "SEA",
        endsAt: "2026-09-04T22:45:00.000Z",
        endsAtTz: "America/New_York",
        confirmationNumber: "HX7T2Q",
        costCents: 41_200,
      }),
    );

    const merged = await duplicates().merge("t1", keep.id, [dup.id]);
    expect(merged.id).toBe(keep.id);
    // The keeper's own title stands; only the blanks were filled.
    expect(merged.title).toBe("Delta 1423");
    expect(merged.location).toBe("SEA");
    expect(merged.endsAt).toBe("2026-09-04T22:45:00.000Z");
    expect(merged.endsAtTz).toBe("America/New_York");
    expect(merged.confirmationNumberMasked).toBe("••••7T2Q");
    expect(merged.costCents).toBe(41_200);

    const list = await bookings().listByTrip("t1");
    expect(list.map((b) => b.id)).toEqual([keep.id]);
    // The moved confirmation number is still readable — it was copied as its
    // stored envelope, not re-encrypted or truncated to its mask.
    expect(await bookings().revealConfirmation(keep.id)).toBe("HX7T2Q");
  });

  it("never overwrites a value the keeper already had", async () => {
    const keep = await bookings().create(flight({ confirmationNumber: "HX7T2Q", costCents: 41_200, location: "SEA" }));
    const dup = await bookings().create(flight({ confirmationNumber: "HX7T2Q", costCents: 99_900, location: "Seattle-Tacoma" }));

    const merged = await duplicates().merge("t1", keep.id, [dup.id]);
    expect(merged.costCents).toBe(41_200);
    expect(merged.location).toBe("SEA");
    expect(await bookings().revealConfirmation(keep.id)).toBe("HX7T2Q");
  });

  it("takes a timestamp and its timezone from the same booking", async () => {
    // The keeper has no end at all; taking `ends_at` from one row and
    // `ends_at_tz` from another would render the arrival in the wrong place.
    const keep = await bookings().create(flight({}));
    const dup = await bookings().create(
      flight({ endsAt: "2026-09-04T22:45:00.000Z", endsAtTz: "America/New_York" }),
    );
    const merged = await duplicates().merge("t1", keep.id, [dup.id]);
    expect(merged.endsAt).toBe("2026-09-04T22:45:00.000Z");
    expect(merged.endsAtTz).toBe("America/New_York");
  });

  it("unions the travelers of every merged booking", async () => {
    const keep = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    const dup = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    await bookings().assignPerson(keep.id, "p-ava");
    await bookings().assignPerson(dup.id, "p-sam");

    const merged = await duplicates().merge("t1", keep.id, [dup.id]);
    expect([...merged.personIds].sort()).toEqual(["p-ava", "p-sam"]);
  });

  it("keeps the strongest status in the group", async () => {
    const keep = await bookings().create(flight({ confirmationNumber: "HX7T2Q", status: "draft" }));
    const dup = await bookings().create(flight({ confirmationNumber: "HX7T2Q", status: "booked" }));
    expect((await duplicates().merge("t1", keep.id, [dup.id])).status).toBe("booked");
  });

  it("fills missing per-kind details and keeps the result valid for the kind", async () => {
    const keep = await bookings().create(
      flight({ details: { carrier: "Delta", flightNumber: "1423", originIata: "SEA", destinationIata: "JFK" } }),
    );
    const dup = await bookings().create(
      flight({
        confirmationNumber: "HX7T2Q",
        details: { carrier: "Delta", flightNumber: "1423", originIata: "SEA", destinationIata: "JFK", seat: "14C", cabin: "Main" },
      }),
    );
    const merged = await duplicates().merge("t1", keep.id, [dup.id]);
    expect(merged.details).toMatchObject({ seat: "14C", cabin: "Main", carrier: "Delta" });
  });

  it("re-points an accepted import draft at the survivor instead of orphaning it", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO inbound_email (id,household_id,from_address,to_address,raw,status,received_at) VALUES (?,?,?,?,?,?,?)",
    ).bind("mail-1", "hh-a", "delta@example.com", "trips@example.com", "raw", "extracted", now).run();

    const keep = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    const dup = await bookings().create(flight({ confirmationNumber: "HX7T2Q", sourceInboundEmailId: "mail-1" }));
    await env.DB.prepare(
      `INSERT INTO draft_booking (id,household_id,inbound_email_id,ordinal,kind,title,source,status,booking_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind("d1", "hh-a", "mail-1", 0, "flight", "Delta 1423", "ai", "accepted", dup.id, now).run();

    const merged = await duplicates().merge("t1", keep.id, [dup.id]);
    const draft = await env.DB.prepare("SELECT booking_id FROM draft_booking WHERE id = ?").bind("d1").first<{ booking_id: string }>();
    expect(draft?.booking_id).toBe(keep.id);
    // Provenance moves with it: the keeper had no source email of its own.
    expect(merged.sourceInboundEmailId).toBe("mail-1");
  });

  it("retires the dismissals of a booking it deletes", async () => {
    const keep = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    const dup = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    await duplicates().dismiss("t1", [keep.id, dup.id]);
    await duplicates().merge("t1", keep.id, [dup.id]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_duplicate_dismissal").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("collapses three duplicates in one call", async () => {
    const keep = await bookings().create(flight({ confirmationNumber: "HX7T2Q" }));
    const b = await bookings().create(flight({ confirmationNumber: "HX7T2Q", location: "SEA" }));
    const c = await bookings().create(flight({ confirmationNumber: "HX7T2Q", costCents: 41_200 }));

    const merged = await duplicates().merge("t1", keep.id, [b.id, c.id]);
    expect(merged.location).toBe("SEA");
    expect(merged.costCents).toBe(41_200);
    expect((await bookings().listByTrip("t1")).map((x) => x.id)).toEqual([keep.id]);
  });

  it("refuses a merge across kinds, an empty merge list, and ids outside the trip", async () => {
    const keep = await bookings().create(flight({}));
    const hotel = await bookings().create(
      flight({ kind: "lodging", title: "Hotel Kabuki", details: { propertyName: "Hotel Kabuki" } }),
    );
    await expect(duplicates().merge("t1", keep.id, [hotel.id])).rejects.toThrow(ValidationError);
    await expect(duplicates().merge("t1", keep.id, [keep.id])).rejects.toThrow(ValidationError);
    await expect(duplicates().merge("t1", keep.id, ["b-nope"])).rejects.toThrow(NotFoundError);
    // Nothing was deleted by any of the three refusals.
    expect((await bookings().listByTrip("t1")).length).toBe(2);
  });
});
