import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { TripRepo } from "../../../src/server/repos/trip.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import { DELTA_BOOKINGS_90_DAYS } from "../../fixtures/delta-itinerary.js";

const identity: Identity = {
  userId: "u1",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ctx: HouseholdContext = identity;
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-b", "B", now).run();
});

function appAs(who: Identity = identity) {
  return createApp({ verify: async () => who, ring });
}

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
  db: D1Database = env.DB,
) {
  return app.request(path, init, { DB: db } as unknown as AppBindings);
}

function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  db: D1Database = env.DB,
) {
  return request(app, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, db);
}

/**
 * A D1 handle that runs `hook` immediately before the FIRST `batch()` and then
 * delegates everything unchanged.
 *
 * This is how the accept path's race gets tested without racing. The window
 * being simulated is real and narrow: `acceptIntoTrip` reads the drafts and
 * proves they are pending, then builds its INSERT/UPDATE statements (encrypting
 * confirmation numbers, matching travellers) and only then executes them as one
 * batch. Another reviewer accepting or dismissing the same draft inside that
 * window is exactly what the `SELECT title ... WHERE status = 'pending'`
 * subquery in `draftAcceptanceStatements` exists to catch.
 *
 * Intercepting `batch` rather than stubbing some internal is deliberate: it is
 * the one point that is unambiguously "statements built, nothing executed yet",
 * so the test does not encode any assumption about the order of awaits inside
 * the repository, and it stays honest if that order changes.
 */
function dbInterceptingFirstBatch(hook: () => Promise<void>): D1Database {
  let fired = false;
  return new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== "batch") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (statements: D1PreparedStatement[]) => {
        if (!fired) {
          fired = true;
          await hook();
        }
        return await target.batch(statements);
      };
    },
  }) as D1Database;
}

async function seedDelta(householdId = "hh-a") {
  const email = await InboundEmailRepo.forIngest(env.DB, householdId).create({
    from: "receipts@delta.example",
    to: "trips@example.com",
    subject: "Delta.com Trip Information",
    raw: "raw message",
  });
  return DraftBookingRepo.forIngest(env.DB, householdId).createMany(
    DELTA_BOOKINGS_90_DAYS.map((booking, ordinal) => ({
      inboundEmailId: email.id,
      ordinal,
      kind: booking.kind,
      title: booking.title,
      location: booking.location,
      startsAt: booking.startsAt,
      startsAtTz: booking.startsAtTz,
      endsAt: booking.endsAt,
      endsAtTz: booking.endsAtTz,
      confirmationNumber: booking.confirmationNumber,
      source: "ai" as const,
      extracted: booking,
    })),
  );
}

describe("import review routes", () => {
  it("suggests the one existing trip that contains each draft's local dates", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-30",
    });
    await seedDelta();

    const res = await request(appAs(), "/api/imports/pending");
    expect(res.status).toBe(200);
    const pending = await res.json() as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(3);
    expect(pending).toMatchObject(DELTA_BOOKINGS_90_DAYS.map((booking, index) => ({
      title: booking.title,
      // DL 162 departs on Oct 21 local Chicago time even though its UTC
      // instant is already Oct 22.
      localStartsOn: index < 2 ? "2026-10-21" : "2026-10-22",
      suggestedTrip: { id: trip.id, title: "Europe" },
      source: {
        from: "receipts@delta.example",
        subject: "Delta.com Trip Information",
      },
    })));
  });

  it("leaves an ambiguous date match unassigned", async () => {
    await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-20",
      endsOn: "2026-10-30",
    });
    await new TripRepo(env.DB, ctx).create({
      title: "Amsterdam",
      startsOn: "2026-10-21",
      endsOn: "2026-10-23",
    });
    await seedDelta();

    const pending = await (await request(appAs(), "/api/imports/pending")).json() as Array<{
      suggestedTrip: unknown;
    }>;
    expect(pending.every((draft) => draft.suggestedTrip === null)).toBe(true);
  });

  it("accepts selected drafts into an existing trip and preserves source provenance", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-30",
    });
    const drafts = await seedDelta();
    const selected = drafts.slice(0, 2).map((draft) => draft.id);

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: selected,
      tripId: trip.id,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      trip: { id: trip.id },
      acceptedDraftIds: selected,
    });

    const { results: bookings } = await env.DB.prepare(
      `SELECT trip_id, source_inbound_email_id, status, confirmation_number
         FROM booking ORDER BY starts_at`,
    ).all<{
      trip_id: string;
      source_inbound_email_id: string;
      status: string;
      confirmation_number: string;
    }>();
    expect(bookings).toHaveLength(2);
    expect(bookings.every((booking) =>
      booking.trip_id === trip.id &&
      booking.source_inbound_email_id === drafts[0]!.inboundEmailId &&
      booking.status === "booked" &&
      booking.confirmation_number !== "TRIP90"
    )).toBe(true);
    expect(
      (await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
        .map((draft) => draft.id),
    ).toEqual([drafts[2]!.id]);
  });

  it("links an imported booking by traveler name before a mismatched email", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO person (id, household_id, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("p-david", "hh-a", "David Apsley", "dapsley1@gmail.com", now).run();
    await env.DB.prepare(
      "INSERT INTO person (id, household_id, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("p-sol", "hh-a", "Sol", "sol@badgerops.net", now).run();
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Silverwood",
      startsOn: "2026-07-29",
      endsOn: "2026-07-30",
    });
    const email = await InboundEmailRepo.forIngest(env.DB, "hh-a").create({
      from: "sol@badgerops.net",
      to: "trips@example.com",
      subject: "Fwd: Your Silverwood RV Park Reservation",
      raw: [
        "From: sol <sol@badgerops.net>",
        "",
        "----- Original message -----",
        "From: David Apsley <dapsley1@gmail.com>",
      ].join("\r\n"),
    });
    const [draft] = await DraftBookingRepo.forIngest(env.DB, "hh-a").createMany([{
      inboundEmailId: email.id,
      ordinal: 0,
      kind: "lodging",
      title: "Silverwood RV Park",
      source: "ai",
      extracted: {
        details: { propertyName: "Silverwood RV Park" },
        travelerNames: ["David Apsley"],
        travelerEmails: ["david.apsley@work.example"],
      },
    }]);

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [draft!.id],
      tripId: trip.id,
    });
    expect(res.status).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT bp.person_id
           FROM booking_person bp
           JOIN booking b ON b.id = bp.booking_id`,
      ).first(),
    ).toEqual({ person_id: "p-david" });
    expect(
      await env.DB.prepare("SELECT person_id FROM trip_person WHERE trip_id = ?")
        .bind(trip.id).first(),
    ).toEqual({ person_id: "p-david" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM booking_person WHERE person_id = 'p-sol'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("allows a reviewer to manually assign an unmatched import to an existing trip", async () => {
    const selectedTrip = await new TripRepo(env.DB, ctx).create({
      title: "Too early",
      startsOn: "2026-10-01",
      endsOn: "2026-10-10",
    });
    const drafts = await seedDelta();

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [drafts[0]!.id],
      tripId: selectedTrip.id,
    });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking").first())
      .toEqual({ count: 1 });
    expect(await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
      .toHaveLength(2);
  });

  it("does not manually assign imports to a cancelled trip", async () => {
    const selectedTrip = await new TripRepo(env.DB, ctx).create({
      title: "Cancelled trip",
      startsOn: "2026-10-01",
      endsOn: "2026-10-30",
    });
    await new TripRepo(env.DB, ctx).update(selectedTrip.id, { status: "cancelled" });
    const drafts = await seedDelta();

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [drafts[0]!.id],
      tripId: selectedTrip.id,
    });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking").first())
      .toEqual({ count: 0 });
  });

  it("creates one dated trip and bookings atomically from multiple pending drafts", async () => {
    const drafts = await seedDelta();
    const res = await postJson(appAs(), "/api/imports/create-trip", {
      draftIds: drafts.map((draft) => draft.id),
      title: "Germany trip",
      destination: "Stuttgart",
    });
    expect(res.status).toBe(201);
    const result = await res.json() as {
      trip: { id: string; startsOn: string; endsOn: string };
      acceptedDraftIds: string[];
    };
    expect(result).toMatchObject({
      trip: {
        startsOn: "2026-10-21",
        endsOn: "2026-10-22",
      },
      acceptedDraftIds: drafts.map((draft) => draft.id),
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM booking WHERE trip_id = ?")
        .bind(result.trip.id).first(),
    ).toEqual({ count: 3 });
    expect(await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
      .toEqual([]);
  });

  it("rejects cross-household selections without creating a partial trip", async () => {
    const own = await seedDelta();
    const foreign = await seedDelta("hh-b");
    const res = await postJson(appAs(), "/api/imports/create-trip", {
      draftIds: [own[0]!.id, foreign[0]!.id],
      title: "Must not exist",
    });
    expect(res.status).toBe(404);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM trip WHERE household_id = 'hh-a'")
        .first(),
    ).toEqual({ count: 0 });
    expect(await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
      .toHaveLength(3);
  });

  it("dismisses pending drafts and blocks viewers from the review queue", async () => {
    const drafts = await seedDelta();
    const dismissed = await postJson(appAs(), "/api/imports/dismiss", {
      draftIds: [drafts[0]!.id],
    });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toEqual({ dismissedDraftIds: [drafts[0]!.id] });

    const viewer = appAs({ ...identity, role: "viewer" });
    expect((await request(viewer, "/api/imports/pending")).status).toBe(403);
    expect((await postJson(viewer, "/api/imports/accept", {
      draftIds: [drafts[1]!.id],
      tripId: "anything",
    })).status).toBe(403);
  });

  /**
   * "Leaves the pending queue" is the weaker half of what dismiss promises. A
   * hard DELETE would satisfy it just as well, and the audit trail — which
   * import was rejected, and when someone decided that — would be gone with no
   * test noticing. So this asserts on the ROW: still there, still this
   * household's, marked dismissed, stamped with when, and attached to no
   * booking.
   */
  it("keeps a dismissed draft on file rather than deleting it", async () => {
    const drafts = await seedDelta();
    const before = new Date().toISOString();

    expect((await postJson(appAs(), "/api/imports/dismiss", {
      draftIds: [drafts[0]!.id],
    })).status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT household_id, title, status, booking_id, resolved_at FROM draft_booking WHERE id = ?",
    ).bind(drafts[0]!.id).first<{
      household_id: string;
      title: string;
      status: string;
      booking_id: string | null;
      resolved_at: string | null;
    }>();
    expect(row).toMatchObject({
      household_id: "hh-a",
      title: drafts[0]!.title,
      status: "dismissed",
      booking_id: null,
    });
    expect(row!.resolved_at! >= before).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM draft_booking").first())
      .toEqual({ count: 3 });
  });

  /**
   * The already-resolved 400 the issue asked for, from both directions a draft
   * can leave the queue. Two reviewers open /import at the same time; one
   * accepts, the other's stale row is still on screen and they click it too.
   * The second click must be refused, and — the part worth pinning — refused
   * with the sentence that says WHY, since the client now shows a 400's
   * message verbatim (see client/lib/errors.ts).
   */
  it("refuses to review a draft that is already accepted or dismissed", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-30",
    });
    const drafts = await seedDelta();

    expect((await postJson(appAs(), "/api/imports/accept", {
      draftIds: [drafts[0]!.id],
      tripId: trip.id,
    })).status).toBe(200);
    expect((await postJson(appAs(), "/api/imports/dismiss", {
      draftIds: [drafts[1]!.id],
    })).status).toBe(200);

    const reaccepted = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [drafts[0]!.id],
      tripId: trip.id,
    });
    expect(reaccepted.status).toBe(400);
    expect(await reaccepted.json()).toEqual({ error: "Only pending imports can be reviewed" });

    const redismissed = await postJson(appAs(), "/api/imports/dismiss", {
      draftIds: [drafts[1]!.id],
    });
    expect(redismissed.status).toBe(400);
    expect(await redismissed.json()).toEqual({ error: "Only pending imports can be reviewed" });

    const intoNewTrip = await postJson(appAs(), "/api/imports/create-trip", {
      draftIds: [drafts[1]!.id, drafts[2]!.id],
      title: "Should not exist",
    });
    expect(intoNewTrip.status).toBe(400);

    // The refusals changed nothing: one booking from the one accept, and the
    // untouched draft still waiting.
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking").first())
      .toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM trip WHERE title = 'Should not exist'").first())
      .toEqual({ count: 0 });
    expect(
      (await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
        .map((draft) => draft.id),
    ).toEqual([drafts[2]!.id]);
  });

  /**
   * The transition failure, forced rather than hoped for.
   *
   * Issue #7 specified create-then-compensate: write the booking, mark the
   * draft accepted, and delete the booking again if that second step failed.
   * What shipped is stronger — both writes go out as ONE D1 batch, so there is
   * no window in which a booking exists without its draft resolved, and nothing
   * to compensate for. But "stronger" is a claim, and until now nothing made
   * the batch fail, so the rollback was never observed.
   *
   * This makes it fail the only way it can: the draft stops being pending after
   * prevalidation, so the INSERT's title subquery finds no row, returns NULL,
   * and violates booking.title NOT NULL. The whole batch must go — including
   * the OTHER draft in the same accept, which was perfectly valid. That is the
   * property the issue actually cared about: no orphaned booking, and a draft
   * you can simply retry.
   */
  it("rolls back the entire accept when a draft is resolved mid-batch", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-30",
    });
    const drafts = await seedDelta();
    const raced = drafts[0]!;
    const bystander = drafts[1]!;

    const db = dbInterceptingFirstBatch(async () => {
      await env.DB.prepare(
        "UPDATE draft_booking SET status = 'dismissed', resolved_at = ? WHERE id = ?",
      ).bind(new Date().toISOString(), raced.id).run();
    });

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [raced.id, bystander.id],
      tripId: trip.id,
    }, db);
    expect(res.status).toBe(500);
    // Contentless on purpose — a 500 says nothing about internals (mapError).
    expect(await res.json()).toEqual({ error: "Internal error" });

    // No orphan: not the racing draft's booking, and not the bystander's
    // either. Half a batch is the failure mode this design exists to prevent.
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking").first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking_person").first())
      .toEqual({ count: 0 });

    // The draft the other reviewer resolved keeps THEIR outcome; ours did not
    // half-apply on top of it.
    expect(
      await env.DB.prepare("SELECT status, booking_id FROM draft_booking WHERE id = ?")
        .bind(raced.id).first(),
    ).toEqual({ status: "dismissed", booking_id: null });

    // And the bystander is exactly where it was, so a plain retry is safe.
    expect(
      (await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
        .map((draft) => draft.id),
    ).toEqual([bystander.id, drafts[2]!.id]);

    const retry = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [bystander.id],
      tripId: trip.id,
    });
    expect(retry.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking").first())
      .toEqual({ count: 1 });
  });

  /**
   * Multi-booking emails must stay in extraction order — a round trip reads
   * outbound-then-return, not whichever row SQLite handed back first. Two
   * emails ingested in the same millisecond is the case that used to rely on
   * UUIDv7 ids happening to ascend; `ordinal` is what actually records the
   * answer, so the drafts here are deliberately inserted BACKWARDS.
   */
  it("orders a source's drafts by their extraction ordinal, not their insert order", async () => {
    const email = await InboundEmailRepo.forIngest(env.DB, "hh-a").create({
      from: "receipts@delta.example",
      to: "trips@example.com",
      subject: "Delta.com Trip Information",
      raw: "raw message",
    });
    const now = new Date().toISOString();
    // Every row shares one created_at — exactly the shape createMany produces
    // for one email — and the ids run BACKWARDS against the ordinal, so the
    // old `created_at, id` tiebreak returns them in exactly the wrong order.
    // (It looked right in production only because UUIDv7 ids happen to ascend
    // with insert order; that coincidence is what this test removes.)
    const rows = [
      { id: "d-z", ordinal: 0, title: "first" },
      { id: "d-m", ordinal: 1, title: "second" },
      { id: "d-a", ordinal: 2, title: "third" },
    ];
    for (const row of rows) {
      await env.DB.prepare(
        `INSERT INTO draft_booking
           (id, household_id, inbound_email_id, ordinal, kind, title, status, source, extracted_json, created_at)
         VALUES (?, 'hh-a', ?, ?, 'flight', ?, 'pending', 'ai', '{}', ?)`,
      ).bind(row.id, email.id, row.ordinal, row.title, now).run();
    }

    const pending = await (await request(appAs(), "/api/imports/pending")).json() as Array<{
      title: string;
    }>;
    expect(pending.map((draft) => draft.title)).toEqual(["first", "second", "third"]);
  });
});
