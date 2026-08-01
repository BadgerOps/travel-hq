import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { DuplicateRepo } from "../../../src/server/repos/duplicates.js";
import { ImportReviewRepo } from "../../../src/server/repos/import-review.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import type { CreateBookingInput } from "../../../src/server/repos/booking.js";

/**
 * The keyring the rows were written with, and the one the app has after a
 * rotation dropped the old key. Reading `retired` data with `current` is the
 * production shape of "this envelope cannot be opened" — the case that used to
 * turn the whole duplicates card, and the entire import review queue, into a
 * 500 because one row would not decrypt.
 */
const retired = new Keyring("server-v0", { "server-v0": crypto.getRandomValues(new Uint8Array(32)) });
const current = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });

const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const TZ = "America/Los_Angeles";

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

/** Writes a confirmation the current keyring cannot open. */
async function makeUnreadable(bookingId: string, stored: string) {
  await env.DB.prepare("UPDATE booking SET confirmation_number = ? WHERE id = ?")
    .bind(stored, bookingId).run();
}

beforeEach(async () => {
  for (const table of [
    "booking_duplicate_dismissal", "draft_booking", "inbound_email", "booking_person",
    "booking", "trip_person", "person", "trip", "household",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,starts_on,ends_on,created_at) VALUES (?,?,?,?,?,?)")
    .bind("t1", "hh-a", "Tokyo", "2026-09-01", "2026-09-30", now).run();
});

describe("a booking whose confirmation cannot be decrypted", () => {
  it("does not fail the trip's duplicate scan", async () => {
    // Written under the retired key, read back under the current one.
    const stale = await new BookingRepo(env.DB, ctx, retired)
      .create(flight({ title: "Ferry to Miyajima", startsAt: "2026-09-02T01:00:00.000Z", confirmationNumber: "OLD-1" }));

    const repo = new DuplicateRepo(env.DB, ctx, current);
    await expect(repo.forTrip("t1")).resolves.toEqual([]);
    expect(stale.id).toBeTruthy();
  });

  it("still reports duplicate groups that do not involve the unreadable row", async () => {
    const bookings = new BookingRepo(env.DB, ctx, current);
    await bookings.create(flight({ confirmationNumber: "HX7T2Q" }));
    await bookings.create(flight({ title: "DL 1423", confirmationNumber: "hx7t-2q" }));
    // An unrelated row on the same trip that no longer opens. Before the fix
    // this one row took the other two down with it.
    const stale = await bookings.create(flight({
      title: "Ferry to Miyajima",
      startsAt: "2026-09-09T01:00:00.000Z",
      confirmationNumber: "OLD-1",
    }));
    await makeUnreadable(stale.id, "v1.server-v0.AAAA.BBBB");

    const groups = await new DuplicateRepo(env.DB, ctx, current).forTrip("t1");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.bookings.map((b) => b.title).sort())
      .toEqual(["DL 1423", "Delta 1423 SEA-JFK"]);
  });

  it("tolerates a legacy plaintext confirmation, not just a foreign envelope", async () => {
    const bookings = new BookingRepo(env.DB, ctx, current);
    await bookings.create(flight({ confirmationNumber: "HX7T2Q" }));
    await bookings.create(flight({ title: "DL 1423", confirmationNumber: "hx7t-2q" }));
    const legacy = await bookings.create(flight({
      title: "Ferry to Miyajima",
      startsAt: "2026-09-09T01:00:00.000Z",
      confirmationNumber: "OLD-1",
    }));
    // A value written before envelope encryption existed: no version prefix.
    await makeUnreadable(legacy.id, "WBR-4821");

    const groups = await new DuplicateRepo(env.DB, ctx, current).forTrip("t1");
    expect(groups).toHaveLength(1);
  });

  it("contributes no confirmation signal, so it cannot match on ciphertext", async () => {
    const bookings = new BookingRepo(env.DB, ctx, current);
    const a = await bookings.create(flight({ title: "Ferry to Miyajima", startsAt: "2026-09-02T01:00:00.000Z" }));
    const b = await bookings.create(flight({ kind: "lodging", title: "Ryokan Kurashiki", startsAt: "2026-09-20T05:00:00.000Z", details: { propertyName: "Ryokan Kurashiki" } }));
    // Two unrelated bookings carrying the identical unreadable blob. If the
    // matcher ever compared raw stored values it would call these a duplicate.
    await makeUnreadable(a.id, "v1.server-v0.SAME.BLOB");
    await makeUnreadable(b.id, "v1.server-v0.SAME.BLOB");

    await expect(new DuplicateRepo(env.DB, ctx, current).forTrip("t1")).resolves.toEqual([]);
  });

  it("answers the duplicates endpoint 200, not 500", async () => {
    // The user-visible symptom: one unreadable row turned the whole trip's
    // duplicates card into an Internal error.
    const bookings = new BookingRepo(env.DB, ctx, current);
    await bookings.create(flight({ confirmationNumber: "HX7T2Q" }));
    const stale = await bookings.create(flight({
      title: "Ferry to Miyajima",
      startsAt: "2026-09-09T01:00:00.000Z",
      confirmationNumber: "OLD-1",
    }));
    await makeUnreadable(stale.id, "v1.server-v0.AAAA.BBBB");

    const identity: Identity = { userId: "u1", email: "owner@example.com", householdId: "hh-a", role: "owner" };
    const app = createApp({
      verify: (async () => identity) as (req: Request, e: AppBindings) => Promise<Identity>,
      ring: current,
    });
    const res = await app.request("/api/trips/t1/duplicates", {}, { DB: env.DB } as unknown as AppBindings);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groups: [] });
  });

  it("does not fail the import review queue", async () => {
    const bookings = new BookingRepo(env.DB, ctx, current);
    const stale = await bookings.create(flight({ confirmationNumber: "HX7T2Q" }));
    await makeUnreadable(stale.id, "v1.server-v0.AAAA.BBBB");

    const email = await new InboundEmailRepo(env.DB, ctx, current).create({
      from: "confirmations@delta.example",
      to: "trips@example.foo",
      subject: "Your itinerary",
      raw: "",
    });
    await new DraftBookingRepo(env.DB, ctx).createMany([{
      inboundEmailId: email.id,
      ordinal: 0,
      kind: "flight",
      title: "Delta 1423 SEA-JFK",
      startsAt: "2026-09-04T14:30:00.000Z",
      startsAtTz: TZ,
      endsAt: null,
      endsAtTz: null,
      location: null,
      confirmationNumber: "HX7T2Q",
      source: "ai",
      extracted: { details: { carrier: "Delta", flightNumber: "1423", originIata: "sea", destinationIata: "jfk" } },
    }]);

    const pending = await new ImportReviewRepo(env.DB, ctx, current).listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe("Delta 1423 SEA-JFK");
  });
});
