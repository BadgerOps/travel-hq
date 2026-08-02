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
async function activity(
  who: Identity,
  query = "",
): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const res = await request(appAs(who), `/api/audit/activity${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { entries: AuditEntry[]; nextCursor: string | null };
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

/**
 * The log stopped being reveal-only: an owner asking "who changed this?" was
 * previously unanswerable, and answering it in a second table would have given
 * the same question two histories to disagree about.
 */
describe("GET /api/audit/activity", () => {
  async function person(displayName: string): Promise<string> {
    const res = await postJson("/api/people", { displayName });
    return ((await res.json()) as { id: string }).id;
  }
  async function link(personId: string, who: Identity): Promise<void> {
    await env.DB.prepare("INSERT OR IGNORE INTO user (id, email, created_at) VALUES (?, ?, ?)")
      .bind(who.userId, who.email, new Date().toISOString())
      .run();
    await env.DB.prepare("UPDATE person SET user_id = ? WHERE id = ?")
      .bind(who.userId, personId)
      .run();
  }
  function put(who: Identity, id: string, body: unknown) {
    return request(appAs(who), `/api/people/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("records a creation and an edit, naming the FIELDS but never their values", async () => {
    const id = await person("Ava");
    expect((await put(owner, id, { phone: "+1 208 555 0123", passportNumber: "C03X72119" })).status)
      .toBe(200);

    const { entries } = await activity(owner);
    expect(entries.map((e) => e.event)).toEqual(["person_updated", "person_created"]);
    expect(entries[0]).toMatchObject({
      subjectType: "person",
      subjectId: id,
      actorUserId: "u1",
      // Column names, in the order the repo writes them.
      fields: ["phone", "passport_number"],
      selfService: false,
    });
    expect(entries[1]).toMatchObject({ fields: ["display_name"] });
    // The whole safety argument in one assertion: a phone number and a
    // passport number both went through the request that wrote these rows.
    const raw = JSON.stringify(entries);
    expect(raw).not.toContain("C03X72119");
    expect(raw).not.toContain("208 555 0123");
  });

  it("marks an edit of your own record as self-service, at any role", async () => {
    const id = await person("Teen");
    const teen: Identity = { ...owner, userId: "u-teen", email: "teen@example.com", role: "viewer" };
    await link(id, teen);

    expect((await put(teen, id, { phone: "+1 208 555 0124" })).status).toBe(200);
    const { entries } = await activity(teen);
    expect(entries[0]).toMatchObject({
      event: "person_updated",
      actorUserId: "u-teen",
      selfService: true,
      fields: ["phone"],
    });
  });

  /**
   * The visibility rule, which is the reason this endpoint is not simply
   * owner-only: reading who did what to whom across a household is governance,
   * but "who edited MY passport number?" is a question about your own record
   * that you should never have to ask an owner to answer for you.
   */
  it("shows an owner the whole household", async () => {
    const mine = await person("Ava");
    await put(adult, mine, { phone: "+1 208 555 0125" });
    expect((await activity(owner)).entries).toHaveLength(2);
  });

  it("shows a non-owner only what they did, and what was done to them", async () => {
    const theirs = await person("Ava");
    const mine = await person("Teen");
    const teen: Identity = { ...owner, userId: "u-teen", email: "teen@example.com", role: "viewer" };
    await link(mine, teen);

    // An owner edits both rows. The teenager may see the one about their own
    // record -- as the SUBJECT, not the actor -- and not the other.
    await put(owner, theirs, { notes: "hi" });
    await put(owner, mine, { notes: "hi" });

    const { entries } = await activity(teen);
    expect(entries.map((e) => e.subjectId)).toEqual([mine, mine]);
    expect(entries.every((e) => e.actorUserId === "u1")).toBe(true);
  });

  it("shows an adult the entries they are the actor of", async () => {
    const theirs = await person("Ava");
    await put(adult, theirs, { notes: "corrected" });
    const { entries } = await activity(adult);
    // The person_created row was the owner's doing on somebody else's record.
    expect(entries.map((e) => e.event)).toEqual(["person_updated"]);
    expect(entries[0]).toMatchObject({ actorUserId: "u2" });
  });

  it("never shows another household's activity", async () => {
    await person("Ava");
    const otherOwner: Identity = { ...owner, userId: "u9", householdId: "hh-b" };
    expect((await activity(otherOwner)).entries).toEqual([]);
  });

  it("pages newest-first with an opaque cursor, without skipping or repeating", async () => {
    const ids: string[] = [];
    for (const name of ["A", "B", "C", "D", "E"]) ids.push(await person(name));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { entries: AuditEntry[]; nextCursor: string | null } = await activity(
        owner,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(new Set(seen).size).toBe(5);
    // Newest first: the last person created is the first entry returned.
    const bySubject = (await activity(owner, "?limit=50")).entries;
    expect(bySubject.map((e) => e.subjectId)).toEqual([...ids].reverse());
  });

  it("ignores a malformed cursor rather than failing, and clamps a silly limit", async () => {
    await person("Ava");
    expect((await activity(owner, "?cursor=nonsense")).entries).toHaveLength(1);
    expect((await activity(owner, "?limit=notanumber")).entries).toHaveLength(1);
    expect((await activity(owner, "?limit=100000")).entries).toHaveLength(1);
  });

  it("has no write endpoint -- activity cannot be manufactured over HTTP", async () => {
    expect((await request(app, "/api/audit/activity", revealInit)).status).toBe(404);
  });
});

describe("the reveal trail, now that the table holds more than reveals", () => {
  it("still returns only reveals, with the self-service flag", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })
    ).json()) as { id: string };
    await request(app, `/api/people/${person.id}/reveal/passport_number`, revealInit);

    const entries = await reveals();
    expect(entries.map((e) => e.event)).toEqual(["document_reveal"]);
    expect(entries[0]).toMatchObject({ selfService: false, fields: null });
  });

  it("flags a reveal of your own record", async () => {
    const created = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })
    ).json()) as { id: string };
    await env.DB.prepare("INSERT OR IGNORE INTO user (id, email, created_at) VALUES (?, ?, ?)")
      .bind(owner.userId, owner.email, new Date().toISOString())
      .run();
    await env.DB.prepare("UPDATE person SET user_id = ? WHERE id = ?").bind("u1", created.id).run();

    await request(app, `/api/people/${created.id}/reveal/passport_number`, revealInit);
    expect((await reveals())[0]).toMatchObject({ selfService: true });
  });
});
