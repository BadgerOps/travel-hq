import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import type { CreateDraftBookingInput, DraftBooking } from "../../../src/server/repos/draft-booking.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const identity: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

const RAW_MARKER = "RAW-BODY-MARKER Delta 2214 BOI-STS";

function appAs(who: Identity) {
  return createApp({ verify: async () => who, ring });
}

let app: ReturnType<typeof createApp>;

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function postJson(a: ReturnType<typeof createApp>, path: string, body: BodyInit) {
  return request(a, path, { method: "POST", headers: { "content-type": "application/json" }, body });
}
function putJson(a: ReturnType<typeof createApp>, path: string, body: BodyInit) {
  return request(a, path, { method: "PUT", headers: { "content-type": "application/json" }, body });
}

function seedCtx(householdId: string): HouseholdContext {
  return { householdId, userId: "u-seed", role: "adult" };
}

async function makeEmail(
  householdId: string,
  over: Partial<{ from: string; subject: string | null; receivedAt: string }> = {},
) {
  const email = await new InboundEmailRepo(env.DB, seedCtx(householdId)).create({
    from: over.from ?? "delta@delta.com",
    to: "trips@badgerops.foo",
    subject: over.subject === undefined ? "Your flight receipt" : over.subject,
    raw: `Subject: Your flight receipt\r\n\r\n${RAW_MARKER}`,
  });
  if (over.receivedAt !== undefined) {
    await env.DB.prepare("UPDATE inbound_email SET received_at = ? WHERE id = ?")
      .bind(over.receivedAt, email.id)
      .run();
  }
  return email;
}

async function makeDraft(
  householdId: string,
  emailId: string,
  over: Partial<CreateDraftBookingInput> & { createdAt?: string } = {},
): Promise<DraftBooking> {
  const { createdAt, ...rest } = over;
  const [draft] = await new DraftBookingRepo(env.DB, seedCtx(householdId)).createMany([
    {
      inboundEmailId: emailId,
      kind: "other",
      title: "Delta 2214 BOI to STS",
      location: "Boise Airport",
      startsAt: "2026-10-09T15:40:00.000Z",
      startsAtTz: "America/Boise",
      endsAt: "2026-10-09T19:55:00.000Z",
      endsAtTz: "America/Los_Angeles",
      confirmationNumber: "D7WN88",
      source: "ai",
      extracted: { costCents: 61240, details: {} },
      ...rest,
    },
  ]);
  if (createdAt !== undefined) {
    await env.DB.prepare("UPDATE draft_booking SET created_at = ? WHERE id = ?")
      .bind(createdAt, draft!.id)
      .run();
  }
  return draft!;
}

async function makeTrip(title = "Guerneville"): Promise<string> {
  const res = await postJson(app, "/api/trips", JSON.stringify({ title }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

type QueueGroup = {
  email: { id: string; from: string; subject: string | null; receivedAt: string };
  drafts: DraftBooking[];
};

async function queue(a = app): Promise<QueueGroup[]> {
  const res = await request(a, "/api/import/queue");
  expect(res.status).toBe(200);
  return (await res.json()) as QueueGroup[];
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip_person");
  await env.DB.exec("DELETE FROM checklist_item");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", now).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", now).run();
  app = appAs(identity);
});

describe("GET /api/import/queue", () => {
  it("groups pending drafts by source email — groups newest-email-first, drafts in extraction order", async () => {
    const older = await makeEmail("hh-a", { subject: "Flights", receivedAt: "2026-07-01T10:00:00.000Z" });
    const newer = await makeEmail("hh-a", { subject: "Hotel", receivedAt: "2026-07-02T10:00:00.000Z" });
    const first = await makeDraft("hh-a", older.id, { title: "Outbound", createdAt: "2026-07-01T10:00:01.000Z" });
    const second = await makeDraft("hh-a", older.id, { title: "Return", createdAt: "2026-07-01T10:00:02.000Z" });
    const hotel = await makeDraft("hh-a", newer.id, { title: "Dawn Ranch", kind: "other" });

    const groups = await queue();
    expect(groups.map((g) => g.email.id)).toEqual([newer.id, older.id]);
    expect(groups[0]?.email).toEqual({
      id: newer.id,
      from: "delta@delta.com",
      subject: "Hotel",
      receivedAt: "2026-07-02T10:00:00.000Z",
    });
    expect(groups[0]?.drafts.map((d) => d.id)).toEqual([hotel.id]);
    expect(groups[1]?.drafts.map((d) => d.id)).toEqual([first.id, second.id]);
  });

  it("never carries the raw message text — that lives behind /emails/:id", async () => {
    const email = await makeEmail("hh-a");
    await makeDraft("hh-a", email.id);
    const res = await request(app, "/api/import/queue");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(RAW_MARKER);
  });

  it("excludes resolved drafts, and an email with nothing pending has no group", async () => {
    const email = await makeEmail("hh-a");
    const keep = await makeDraft("hh-a", email.id, { title: "Keep" });
    const drop = await makeDraft("hh-a", email.id, { title: "Drop" });
    expect((await postJson(app, `/api/import/drafts/${drop.id}/dismiss`, "")).status).toBe(200);

    let groups = await queue();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.drafts.map((d) => d.id)).toEqual([keep.id]);

    expect((await postJson(app, `/api/import/drafts/${keep.id}/dismiss`, "")).status).toBe(200);
    groups = await queue();
    expect(groups).toEqual([]);
  });

  it("answers [] when nothing is pending", async () => {
    expect(await queue()).toEqual([]);
  });

  it("is tenant-scoped: another household's drafts are invisible", async () => {
    const emailB = await makeEmail("hh-b");
    await makeDraft("hh-b", emailB.id);
    expect(await queue()).toEqual([]);
  });

  it("is readable by a viewer — review is a read until a button is pressed", async () => {
    const email = await makeEmail("hh-a");
    await makeDraft("hh-a", email.id);
    const viewerApp = appAs({ ...identity, role: "viewer" });
    expect(await queue(viewerApp)).toHaveLength(1);
  });
});

describe("GET /api/import/emails/:emailId", () => {
  it("returns the stored message, raw text included", async () => {
    const email = await makeEmail("hh-a", { subject: "Your flight receipt" });
    const res = await request(app, `/api/import/emails/${email.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string; raw: string; from: string };
    expect(body.subject).toBe("Your flight receipt");
    expect(body.from).toBe("delta@delta.com");
    expect(body.raw).toContain(RAW_MARKER);
  });

  it("is readable by a viewer", async () => {
    const email = await makeEmail("hh-a");
    const viewerApp = appAs({ ...identity, role: "viewer" });
    expect((await request(viewerApp, `/api/import/emails/${email.id}`)).status).toBe(200);
  });

  it("answers 404 for an unknown id", async () => {
    const res = await request(app, "/api/import/emails/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("answers 404 for another household's email — indistinguishable from unknown", async () => {
    const emailB = await makeEmail("hh-b");
    expect((await request(app, `/api/import/emails/${emailB.id}`)).status).toBe(404);
  });
});

describe("PUT /api/import/drafts/:draftId", () => {
  it("edits the reviewable fields and the correction persists into the queue", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await putJson(
      app,
      `/api/import/drafts/${draft.id}`,
      JSON.stringify({ kind: "flight", title: "Delta 2214", confirmationNumber: "XYZ999" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftBooking;
    expect(body.kind).toBe("flight");
    expect(body.title).toBe("Delta 2214");
    expect(body.confirmationNumber).toBe("XYZ999");
    // Absent keys kept their stored values.
    expect(body.location).toBe("Boise Airport");
    expect(body.startsAt).toBe("2026-10-09T15:40:00.000Z");

    const groups = await queue();
    expect(groups[0]?.drafts[0]).toMatchObject({ title: "Delta 2214", confirmationNumber: "XYZ999" });
  });

  it("clears nullable fields with explicit nulls (tri-state)", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await putJson(
      app,
      `/api/import/drafts/${draft.id}`,
      JSON.stringify({
        location: null,
        confirmationNumber: null,
        startsAt: null,
        startsAtTz: null,
        endsAt: null,
        endsAtTz: null,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftBooking;
    expect(body.location).toBeNull();
    expect(body.confirmationNumber).toBeNull();
    expect(body.startsAt).toBeNull();
    expect(body.startsAtTz).toBeNull();
  });

  it("rejects an unknown key with 400 (strict schema)", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    expect(
      (await putJson(app, `/api/import/drafts/${draft.id}`, JSON.stringify({ status: "accepted" }))).status,
    ).toBe(400);
  });

  it("rejects an unrecognized kind with 400", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    expect(
      (await putJson(app, `/api/import/drafts/${draft.id}`, JSON.stringify({ kind: "banana" }))).status,
    ).toBe(400);
  });

  it("rejects clearing a zone while its timestamp stays — the merged result must pair", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await putJson(app, `/api/import/drafts/${draft.id}`, JSON.stringify({ startsAtTz: null }));
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable timestamp and an unrecognized timezone with 400", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    expect(
      (await putJson(app, `/api/import/drafts/${draft.id}`, JSON.stringify({ startsAt: "garbage" }))).status,
    ).toBe(400);
    expect(
      (await putJson(app, `/api/import/drafts/${draft.id}`, JSON.stringify({ startsAtTz: "Not/AZone" }))).status,
    ).toBe(400);
  });

  it("answers 404 for an unknown draft and for another household's draft", async () => {
    expect((await putJson(app, "/api/import/drafts/nope", JSON.stringify({ title: "X" }))).status).toBe(404);
    const emailB = await makeEmail("hh-b");
    const draftB = await makeDraft("hh-b", emailB.id);
    expect(
      (await putJson(app, `/api/import/drafts/${draftB.id}`, JSON.stringify({ title: "X" }))).status,
    ).toBe(404);
  });

  it("rejects editing a resolved draft with 400 — terminal states are audit records", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    await postJson(app, `/api/import/drafts/${draft.id}/dismiss`, "");
    expect(
      (await putJson(app, `/api/import/drafts/${draft.id}`, JSON.stringify({ title: "X" }))).status,
    ).toBe(400);
  });

  it("blocks a viewer with 403 and leaves the draft untouched", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const res = await putJson(viewerApp, `/api/import/drafts/${draft.id}`, JSON.stringify({ title: "X" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    const groups = await queue();
    expect(groups[0]?.drafts[0]?.title).toBe("Delta 2214 BOI to STS");
  });

  it("rejects a malformed JSON body with 400", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await putJson(app, `/api/import/drafts/${draft.id}`, "{ not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("POST /api/import/drafts/:draftId/accept", () => {
  it("accepts onto an existing trip: a real booking, encrypted confirmation, carried cost, resolved draft", async () => {
    const tripId = await makeTrip();
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);

    const res = await postJson(app, `/api/import/drafts/${draft.id}/accept`, JSON.stringify({ tripId }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      draft: DraftBooking;
      booking: { id: string; tripId: string; status: string; costCents: number | null };
      trip: { id: string };
    };
    expect(body.draft.status).toBe("accepted");
    expect(body.draft.bookingId).toBe(body.booking.id);
    expect(body.draft.resolvedAt).toBeTruthy();
    expect(body.booking.tripId).toBe(tripId);
    expect(body.trip.id).toBe(tripId);

    // The booking is indistinguishable from a manually entered one: it lists
    // on the trip, the confirmation number is stored encrypted (masked in
    // lists, revealed only on the explicit endpoint), and the extraction
    // payload's costCents rode along.
    const listRes = await request(app, `/api/trips/${tripId}/bookings`);
    const listed = (await listRes.json()) as {
      id: string;
      title: string;
      status: string;
      costCents: number | null;
      confirmationNumberMasked: string | null;
    }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: body.booking.id,
      title: "Delta 2214 BOI to STS",
      status: "booked",
      costCents: 61240,
      confirmationNumberMasked: "••••WN88",
    });
    expect(JSON.stringify(listed)).not.toContain("D7WN88");
    const revealed = await (
      await request(app, `/api/trips/${tripId}/bookings/${body.booking.id}/reveal`)
    ).json();
    expect(revealed).toEqual({ value: "D7WN88" });

    // And the queue reflects the accept.
    expect(await queue()).toEqual([]);
  });

  it("puts chosen travellers on the booking AND the trip — the manual assignPerson path", async () => {
    const tripId = await makeTrip();
    const personRes = await postJson(app, "/api/people", JSON.stringify({ displayName: "Ava" }));
    const personId = ((await personRes.json()) as { id: string }).id;
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);

    const res = await postJson(
      app,
      `/api/import/drafts/${draft.id}/accept`,
      JSON.stringify({ tripId, personIds: [personId] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking: { personIds: string[] } };
    // The response's booking predates the assignment; the stored one carries it.
    const listed = (await (await request(app, `/api/trips/${tripId}/bookings`)).json()) as {
      personIds: string[];
    }[];
    expect(listed[0]?.personIds).toEqual([personId]);
    expect(body.booking).toBeTruthy();
    const travelers = (await (await request(app, `/api/trips/${tripId}/travelers`)).json()) as {
      id: string;
    }[];
    expect(travelers.map((p) => p.id)).toEqual([personId]);
  });

  it("accepts as a new trip seeded from the draft", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await postJson(
      app,
      `/api/import/drafts/${draft.id}/accept`,
      JSON.stringify({
        newTrip: { title: "Guerneville", destination: "Guerneville, CA", startsOn: "2026-10-09", endsOn: "2026-10-12" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { trip: { id: string; title: string; destination: string } };
    expect(body.trip.title).toBe("Guerneville");
    expect(body.trip.destination).toBe("Guerneville, CA");

    const trips = (await (await request(app, "/api/trips")).json()) as { id: string }[];
    expect(trips.map((t) => t.id)).toEqual([body.trip.id]);
    const bookings = (await (await request(app, `/api/trips/${body.trip.id}/bookings`)).json()) as unknown[];
    expect(bookings).toHaveLength(1);
  });

  it("groups several emails onto one trip: accept the first as a new trip, the rest onto it", async () => {
    const flightMail = await makeEmail("hh-a", { subject: "Flights" });
    const hotelMail = await makeEmail("hh-a", { subject: "Hotel" });
    const flight = await makeDraft("hh-a", flightMail.id, { title: "Outbound flight" });
    const hotel = await makeDraft("hh-a", hotelMail.id, { title: "Dawn Ranch", confirmationNumber: "H0TEL9" });

    const first = await postJson(
      app,
      `/api/import/drafts/${flight.id}/accept`,
      JSON.stringify({ newTrip: { title: "Guerneville" } }),
    );
    expect(first.status).toBe(201);
    const { trip } = (await first.json()) as { trip: { id: string } };

    const second = await postJson(
      app,
      `/api/import/drafts/${hotel.id}/accept`,
      JSON.stringify({ tripId: trip.id }),
    );
    expect(second.status).toBe(201);

    const bookings = (await (await request(app, `/api/trips/${trip.id}/bookings`)).json()) as {
      title: string;
    }[];
    expect(bookings.map((b) => b.title).sort()).toEqual(["Dawn Ranch", "Outbound flight"]);
    expect(await queue()).toEqual([]);
  });

  it("rejects tripId and newTrip together, and neither, with 400", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const tripId = await makeTrip();
    expect(
      (
        await postJson(
          app,
          `/api/import/drafts/${draft.id}/accept`,
          JSON.stringify({ tripId, newTrip: { title: "X" } }),
        )
      ).status,
    ).toBe(400);
    expect((await postJson(app, `/api/import/drafts/${draft.id}/accept`, JSON.stringify({}))).status).toBe(400);
  });

  it("answers 404 for an unknown draft, a cross-household draft, and an unknown trip", async () => {
    const tripId = await makeTrip();
    expect(
      (await postJson(app, "/api/import/drafts/nope/accept", JSON.stringify({ tripId }))).status,
    ).toBe(404);

    const emailB = await makeEmail("hh-b");
    const draftB = await makeDraft("hh-b", emailB.id);
    expect(
      (await postJson(app, `/api/import/drafts/${draftB.id}/accept`, JSON.stringify({ tripId }))).status,
    ).toBe(404);

    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    expect(
      (
        await postJson(app, `/api/import/drafts/${draft.id}/accept`, JSON.stringify({ tripId: "nope" }))
      ).status,
    ).toBe(404);
    // The failed accepts wrote nothing: the draft is still pending.
    expect((await queue())[0]?.drafts[0]?.id).toBe(draft.id);
  });

  it("answers 404 for an unknown personId BEFORE creating anything — no orphan trip or booking", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await postJson(
      app,
      `/api/import/drafts/${draft.id}/accept`,
      JSON.stringify({ newTrip: { title: "Guerneville" }, personIds: ["nope"] }),
    );
    expect(res.status).toBe(404);
    expect(await (await request(app, "/api/trips")).json()).toEqual([]);
    expect((await queue())[0]?.drafts[0]?.status).toBe("pending");
  });

  it("rejects accepting a resolved draft with 400 and writes no booking", async () => {
    const tripId = await makeTrip();
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    await postJson(app, `/api/import/drafts/${draft.id}/dismiss`, "");
    const res = await postJson(app, `/api/import/drafts/${draft.id}/accept`, JSON.stringify({ tripId }));
    expect(res.status).toBe(400);
    expect(await (await request(app, `/api/trips/${tripId}/bookings`)).json()).toEqual([]);
  });

  it("rejects a kind whose extracted details don't fit, with 400, leaving the draft pending", async () => {
    const tripId = await makeTrip();
    const email = await makeEmail("hh-a");
    // A reviewer reclassified this to "flight" but extraction captured no
    // carrier/flight number — accepting would store a flight that breaks
    // the per-kind invariant, so it 400s with a message naming the fix.
    const draft = await makeDraft("hh-a", email.id, { kind: "flight" });
    const res = await postJson(app, `/api/import/drafts/${draft.id}/accept`, JSON.stringify({ tripId }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('kind "flight"');
    expect(await (await request(app, `/api/trips/${tripId}/bookings`)).json()).toEqual([]);
    expect((await queue())[0]?.drafts[0]?.status).toBe("pending");
  });

  it("blocks a viewer with 403 — and the new-trip variant creates no trip", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const res = await postJson(
      viewerApp,
      `/api/import/drafts/${draft.id}/accept`,
      JSON.stringify({ newTrip: { title: "Nope" } }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(await (await request(app, "/api/trips")).json()).toEqual([]);
    expect((await queue())[0]?.drafts[0]?.status).toBe("pending");
  });

  it("rejects a malformed JSON body with 400", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await postJson(app, `/api/import/drafts/${draft.id}/accept`, "{ not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("POST /api/import/drafts/:draftId/dismiss", () => {
  it("dismisses a pending draft: out of the queue, kept for audit", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const res = await postJson(app, `/api/import/drafts/${draft.id}/dismiss`, "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftBooking;
    expect(body.status).toBe("dismissed");
    expect(body.resolvedAt).toBeTruthy();
    expect(body.bookingId).toBeNull();

    expect(await queue()).toEqual([]);
    // The row survives as an audit record — not deleted, just resolved.
    const stored = await new DraftBookingRepo(env.DB, seedCtx("hh-a")).findById(draft.id);
    expect(stored?.status).toBe("dismissed");
  });

  it("answers 404 for an unknown draft and for another household's draft", async () => {
    expect((await postJson(app, "/api/import/drafts/nope/dismiss", "")).status).toBe(404);
    const emailB = await makeEmail("hh-b");
    const draftB = await makeDraft("hh-b", emailB.id);
    expect((await postJson(app, `/api/import/drafts/${draftB.id}/dismiss`, "")).status).toBe(404);
    // Untouched in its own household.
    const stored = await new DraftBookingRepo(env.DB, seedCtx("hh-b")).findById(draftB.id);
    expect(stored?.status).toBe("pending");
  });

  it("rejects a second dismiss with 400 — terminal states never move again", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    await postJson(app, `/api/import/drafts/${draft.id}/dismiss`, "");
    expect((await postJson(app, `/api/import/drafts/${draft.id}/dismiss`, "")).status).toBe(400);
  });

  it("blocks a viewer with 403 and the draft stays pending", async () => {
    const email = await makeEmail("hh-a");
    const draft = await makeDraft("hh-a", email.id);
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const res = await postJson(viewerApp, `/api/import/drafts/${draft.id}/dismiss`, "");
    expect(res.status).toBe(403);
    expect((await queue())[0]?.drafts[0]?.status).toBe("pending");
  });
});
