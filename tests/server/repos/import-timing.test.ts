import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ImportReviewRepo } from "../../../src/server/repos/import-review.js";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

/**
 * Issue #23, on the one write path that does not go through BookingRepo:
 * accepting an import builds its INSERTs by hand so trip, bookings and draft
 * resolution commit as a single D1 batch.
 *
 * Drafts written since `DraftBookingRepo.createMany` started validating them
 * already satisfy every rule here, so these fixtures are seeded with raw SQL
 * on purpose -- they are the rows a database populated before the rules
 * tightened would hold, and the question each test answers is "can the
 * reviewer still get this booking out of the queue?" rather than "is it
 * rejected?". The review queue has no way to edit a draft's times, so a 400
 * would leave the reviewer with nothing to do but dismiss.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

let ordinal = 0;

/** A draft row written straight to D1, bypassing every repository check. */
async function legacyDraft(over: {
  startsAt?: string | null;
  startsAtTz?: string | null;
  endsAt?: string | null;
  endsAtTz?: string | null;
  extracted?: unknown;
} = {}): Promise<string> {
  const id = `draft-${ordinal}`;
  await env.DB.prepare(
    `INSERT INTO draft_booking (
       id, household_id, inbound_email_id, ordinal, kind, title, location,
       starts_at, starts_at_tz, ends_at, ends_at_tz, confirmation_number,
       source, extracted_json, status, booking_id, created_at, resolved_at
     ) VALUES (?, 'hh-a', 'mail-1', ?, 'activity', 'Red Bus tour', NULL,
               ?, ?, ?, ?, NULL, 'ai', ?, 'pending', NULL, ?, NULL)`,
  )
    .bind(
      id,
      ordinal++,
      over.startsAt ?? null,
      over.startsAtTz ?? null,
      over.endsAt ?? null,
      over.endsAtTz ?? null,
      JSON.stringify(over.extracted ?? {}),
      new Date().toISOString(),
    )
    .run();
  return id;
}

async function acceptedBooking(draftId: string) {
  await new ImportReviewRepo(env.DB, ctx, ring).acceptIntoTrip([draftId], "t1");
  const bookings = await new BookingRepo(env.DB, ctx, ring).listByTrip("t1");
  return bookings[bookings.length - 1]!;
}

beforeEach(async () => {
  ordinal = 0;
  for (const table of [
    "draft_booking",
    "booking_person",
    "booking",
    "inbound_email",
    "trip_person",
    "person",
    "trip",
    "household",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", now)
    .run();
  await env.DB.prepare(
    "INSERT INTO trip (id,household_id,title,starts_on,ends_on,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("t1", "hh-a", "Glacier", "2026-10-01", "2026-10-30", now)
    .run();
  await env.DB.prepare(
    "INSERT INTO inbound_email (id,household_id,from_address,to_address,subject,raw,received_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("mail-1", "hh-a", "tours@example.com", "trips@example.com", "Your tour", "raw", now)
    .run();
});

describe("accepting an import", () => {
  it("writes a well-formed draft through unchanged", async () => {
    const draft = await legacyDraft({
      startsAt: "2026-10-09T19:30:00.000Z",
      startsAtTz: "America/Denver",
      endsAt: "2026-10-09T23:30:00.000Z",
      endsAtTz: "America/Denver",
    });
    const booking = await acceptedBooking(draft);
    expect(booking.startsAt).toBe("2026-10-09T19:30:00.000Z");
    expect(booking.endsAt).toBe("2026-10-09T23:30:00.000Z");
  });

  it("imports a legacy draft whose instant is ambiguous, without its time", async () => {
    const draft = await legacyDraft({
      startsAt: "2026-10-09T19:30:00", // no offset: a wall clock, not an instant
      startsAtTz: "America/Denver",
    });
    const booking = await acceptedBooking(draft);
    expect(booking.title).toBe("Red Bus tour");
    // The zone goes with the timestamp: a zone with nothing to zone is exactly
    // the unpaired state assertTimezonePaired exists to prevent.
    expect(booking.startsAt).toBeNull();
    expect(booking.startsAtTz).toBeNull();
  });

  it("imports a legacy draft that ends before it starts, keeping the start", async () => {
    const draft = await legacyDraft({
      startsAt: "2026-10-09T19:30:00.000Z",
      startsAtTz: "America/Denver",
      endsAt: "2026-10-09T18:30:00.000Z",
      endsAtTz: "America/Denver",
    });
    const booking = await acceptedBooking(draft);
    expect(booking.startsAt).toBe("2026-10-09T19:30:00.000Z");
    expect(booking.endsAt).toBeNull();
    expect(booking.endsAtTz).toBeNull();
  });

  it("imports a draft whose extracted cost is negative, without the cost", async () => {
    const draft = await legacyDraft({ extracted: { costCents: -12500 } });
    const booking = await acceptedBooking(draft);
    expect(booking.costCents).toBeNull();
  });

  it("keeps a whole, non-negative extracted cost", async () => {
    const draft = await legacyDraft({ extracted: { costCents: 12500 } });
    expect((await acceptedBooking(draft)).costCents).toBe(12500);
  });

  it("never lets a draft with a bad instant reach the queue in the first place", async () => {
    // The degradation above is a safety net for rows that predate this rule,
    // not a licence to create new ones.
    await expect(
      new DraftBookingRepo(env.DB, ctx).createMany([
        {
          inboundEmailId: "mail-1",
          ordinal: 99,
          kind: "activity",
          title: "Red Bus tour",
          startsAt: "2026-02-30T19:30:00Z",
          startsAtTz: "America/Denver",
          source: "ai",
        },
      ]),
    ).rejects.toThrow(ValidationError);
  });
});

describe("creating a trip from imports", () => {
  it("rejects an impossible or inverted trip range, as POST /api/trips does", async () => {
    const draft = await legacyDraft({
      startsAt: "2026-10-09T19:30:00.000Z",
      startsAtTz: "America/Denver",
    });
    const repo = new ImportReviewRepo(env.DB, ctx, ring);
    await expect(
      repo.createTripFromDrafts({ draftIds: [draft], title: "Glacier", startsOn: "2026-02-30" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.createTripFromDrafts({
        draftIds: [draft],
        title: "Glacier",
        startsOn: "2026-10-11",
        endsOn: "2026-10-09",
      }),
    ).rejects.toThrow(ValidationError);
  });
});
