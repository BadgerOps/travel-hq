import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import type { AuditEntry } from "../../../src/server/repos/audit.js";

/**
 * Issue #8, item 4: the reveal audit trail is PERSISTED and OWNER-VIEWABLE.
 *
 * Before this, reveals were console.info'd from the routes: gone with the log
 * retention window, and unanswerable to the only question an owner actually
 * asks -- "who unmasked my passport number, and when?".
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};
const adult: Identity = { ...owner, userId: "u2", email: "ava@example.com", role: "adult" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

const revealInit: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};

function appAs(who: Identity) {
  return createApp({ verify: async () => who, ring });
}

let app: ReturnType<typeof createApp>;

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function postJson(path: string, body: unknown) {
  return request(app, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function reveals(a = app): Promise<AuditEntry[]> {
  const res = await request(a, "/api/audit/reveals");
  expect(res.status).toBe(200);
  return (await res.json()) as AuditEntry[];
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-a", "Badger", now)
    .run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-b", "Other", now)
    .run();
  app = appAs(owner);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/audit/reveals", () => {
  it("records a document reveal as ids and a field NAME, never the document number", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })
    ).json()) as { id: string };
    await request(app, `/api/people/${person.id}/reveal/passport_number`, revealInit);

    const entries = await reveals();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "document_reveal",
      actorUserId: "u1",
      actorEmail: "badger@example.com",
      subjectType: "person",
      subjectId: person.id,
      field: "passport_number",
      // A person is household-scoped; there is no trip parent to name.
      tripId: null,
    });
    // The value that was revealed appears nowhere in the trail.
    expect(JSON.stringify(entries)).not.toContain("C03X72119");
  });

  it("records a confirmation reveal against the trip it was performed under", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as {
      id: string;
    };
    const booking = (await (
      await postJson(`/api/trips/${trip.id}/bookings`, {
        kind: "other",
        title: "Rehearsal dinner",
        confirmationNumber: "ABCDX4T2",
        details: {},
      })
    ).json()) as { id: string };
    await request(app, `/api/trips/${trip.id}/bookings/${booking.id}/reveal`, revealInit);

    const entries = await reveals();
    expect(entries[0]).toMatchObject({
      event: "confirmation_reveal",
      subjectType: "booking",
      subjectId: booking.id,
      field: "confirmation_number",
      tripId: trip.id,
    });
    expect(JSON.stringify(entries)).not.toContain("ABCDX4T2");
  });

  it("returns newest first", async () => {
    const person = (await (
      await postJson("/api/people", {
        displayName: "Ava",
        passportNumber: "C03X72119",
        knownTravelerNumber: "TT1234567",
      })
    ).json()) as { id: string };
    await request(app, `/api/people/${person.id}/reveal/passport_number`, revealInit);
    await request(app, `/api/people/${person.id}/reveal/known_traveler_number`, revealInit);

    const entries = await reveals();
    expect(entries.map((e) => e.field)).toEqual(["known_traveler_number", "passport_number"]);
  });

  it("is owner-only: an adult in the same household gets 403", async () => {
    const res = await request(appAs(adult), "/api/audit/reveals");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("is owner-only: a viewer gets 403", async () => {
    const res = await request(appAs({ ...owner, role: "viewer" }), "/api/audit/reveals");
    expect(res.status).toBe(403);
  });

  it("never shows another household's trail", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })
    ).json()) as { id: string };
    await request(app, `/api/people/${person.id}/reveal/passport_number`, revealInit);

    const otherOwner: Identity = { ...owner, userId: "u9", householdId: "hh-b" };
    expect(await reveals(appAs(otherOwner))).toEqual([]);
  });

  it("has no write endpoint -- history cannot be manufactured over HTTP", async () => {
    const res = await request(app, "/api/audit/reveals", revealInit);
    expect(res.status).toBe(404);
  });
});

describe("a reveal that did not happen is never recorded", () => {
  /**
   * The property the existing reveal tests depend on and this must not break:
   * the repo throws BEFORE the route reaches the audit write, so a denied or
   * nonexistent reveal leaves no row claiming one occurred.
   */
  it("writes nothing when a viewer is denied", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })
    ).json()) as { id: string };

    const viewerApp = appAs({ ...owner, role: "viewer" });
    expect(
      (await request(viewerApp, `/api/people/${person.id}/reveal/passport_number`, revealInit))
        .status,
    ).toBe(403);
    expect(await reveals()).toEqual([]);
  });

  it("writes nothing when the subject does not exist", async () => {
    expect(
      (await request(app, "/api/people/does-not-exist/reveal/passport_number", revealInit)).status,
    ).toBe(404);
    expect(await reveals()).toEqual([]);
  });

  it("writes nothing when the request is rejected before the repo is called", async () => {
    // A field outside the allowlist is a 400 the route answers itself.
    expect(
      (await request(app, "/api/people/whatever/reveal/display_name", revealInit)).status,
    ).toBe(400);
    expect(await reveals()).toEqual([]);
  });
});
