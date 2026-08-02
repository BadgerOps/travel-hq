import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

/**
 * The permission matrix for a person record, tested exhaustively rather than
 * representatively: a mistake here is a security bug, not a layout annoyance.
 *
 * The rule under test is ADDITIVE. Before this change, `person` had no notion
 * of ownership at all -- an admin or owner wrote everyone's record and a viewer
 * wrote nothing, so a teenager could not correct their own phone number and
 * could not read back the passport number they had just stored. What is new is
 * that the row linked to YOUR account is yours to edit and reveal whatever your
 * role. Nothing was taken away: every other row keeps exactly the rule it had.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const testEnv = { DB: env.DB } as unknown as AppBindings;

const owner: Identity = {
  userId: "u-owner",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const admin: Identity = { ...owner, userId: "u-admin", email: "admin@example.com", role: "admin" };
const viewer: Identity = {
  ...owner,
  userId: "u-viewer",
  email: "viewer@example.com",
  role: "viewer",
};
/** A second admin, so "an admin edits another onboarded admin" has a subject. */
const otherAdmin: Identity = {
  ...owner,
  userId: "u-admin2",
  email: "admin2@example.com",
  role: "admin",
};

const ACCOUNTS = [owner, admin, viewer, otherAdmin];

function appAs(who: Identity) {
  return createApp({ verify: async () => who, ring });
}
function request(who: Identity, path: string, init?: RequestInit) {
  return appAs(who).request(path, init, testEnv);
}
function put(who: Identity, id: string, body: unknown) {
  return request(who, `/api/people/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function reveal(who: Identity, id: string, field = "passport_number") {
  return request(who, `/api/people/${id}/reveal/${field}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/**
 * Creates a person as the owner (the only way to get an encrypted document in
 * through the API) and then links it to `userId`, which is what onboarding
 * does. Linking is done in SQL because the endpoint that invites a member is
 * another change; what matters here is the resulting state.
 */
async function seedPerson(displayName: string, userId: string | null): Promise<string> {
  const res = await request(owner, "/api/people", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName, passportNumber: `C03X7${displayName.length}119` }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  if (userId) {
    await env.DB.prepare("UPDATE person SET user_id = ? WHERE id = ?").bind(userId, id).run();
  }
  return id;
}

async function auditRow(personId: string): Promise<{ event: string; self_service: number } | null> {
  return env.DB.prepare(
    `SELECT event, self_service FROM audit_log
      WHERE subject_id = ? AND event = 'document_reveal'
      ORDER BY at DESC, id DESC LIMIT 1`,
  )
    .bind(personId)
    .first<{ event: string; self_service: number }>();
}

let ownersRow: string;
let adminsRow: string;
let viewersRow: string;
let unlinkedRow: string;
let otherAdminsRow: string;
let otherHouseholdRow: string;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  await env.DB.exec("DELETE FROM user");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind(id, id, now)
      .run();
  }
  for (const account of ACCOUNTS) {
    await env.DB.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)")
      .bind(account.userId, account.email, now)
      .run();
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  ownersRow = await seedPerson("Owner", owner.userId);
  adminsRow = await seedPerson("Admin", admin.userId);
  viewersRow = await seedPerson("Viewer", viewer.userId);
  otherAdminsRow = await seedPerson("SecondAdmin", otherAdmin.userId);
  // Pre-seeded and never claimed: a child, or a member who has not signed in.
  unlinkedRow = await seedPerson("Unlinked", null);

  const otherOwner: Identity = { ...owner, userId: "u-elsewhere", householdId: "hh-b" };
  await env.DB.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)")
    .bind("u-elsewhere", "elsewhere@example.com", now)
    .run();
  const res = await request(otherOwner, "/api/people", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Stranger", passportNumber: "C03X79999" }),
  });
  otherHouseholdRow = ((await res.json()) as { id: string }).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editing a person", () => {
  it("a viewer may edit their OWN row", async () => {
    const res = await put(viewer, viewersRow, { phone: "+1 208 555 0111" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phone: "+1 208 555 0111" });
  });

  it("a viewer may not edit anybody else's row", async () => {
    expect((await put(viewer, adminsRow, { phone: "+1 208 555 0112" })).status).toBe(403);
    expect((await put(viewer, unlinkedRow, { phone: "+1 208 555 0113" })).status).toBe(403);
    expect((await put(viewer, ownersRow, { phone: "+1 208 555 0114" })).status).toBe(403);
  });

  it("an admin may edit their own row", async () => {
    expect((await put(admin, adminsRow, { phone: "+1 208 555 0115" })).status).toBe(200);
  });

  it("an admin may edit an unlinked, pre-seeded row", async () => {
    // The case that keeps children and not-yet-onboarded members editable.
    expect((await put(admin, unlinkedRow, { displayName: "Child" })).status).toBe(200);
  });

  /**
   * DELIBERATE, and pinned because an earlier draft of this design took it
   * away. Linking a row to an account grants that account access; it does not
   * revoke anyone else's. Making it a handover would have cost a two-admin
   * household with a single owner the ability to fix each other's records, for
   * a threat model ("either parent can rewrite the other's passport number")
   * that a shared household has other answers to.
   */
  it("an admin may still edit another ONBOARDED admin's row", async () => {
    expect((await put(admin, otherAdminsRow, { phone: "+1 208 555 0116" })).status).toBe(200);
  });

  it("an owner may edit any row in the household", async () => {
    for (const id of [ownersRow, adminsRow, viewersRow, unlinkedRow, otherAdminsRow]) {
      expect((await put(owner, id, { notes: "checked" })).status).toBe(200);
    }
  });

  /**
   * A membership oracle is the failure to avoid: 403 would confirm the row
   * exists somewhere, 404 says only "not here". Every role has to answer the
   * same way, including the viewer whose permission check would otherwise fire
   * first.
   */
  it("answers 404, never 403, for a person in another household", async () => {
    for (const who of [owner, admin, viewer]) {
      expect((await put(who, otherHouseholdRow, { notes: "nope" })).status).toBe(404);
      expect((await put(who, "p-does-not-exist", { notes: "nope" })).status).toBe(404);
    }
  });

  it("leaves the other household's row untouched", async () => {
    await put(admin, otherHouseholdRow, { displayName: "Renamed" });
    expect(
      await env.DB.prepare("SELECT display_name FROM person WHERE id = ?")
        .bind(otherHouseholdRow)
        .first(),
    ).toMatchObject({ display_name: "Stranger" });
  });
});

describe("revealing a document", () => {
  it("a viewer may reveal their OWN document, and the audit row says so", async () => {
    const res = await reveal(viewer, viewersRow);
    expect(res.status).toBe(200);
    expect((await res.json()) as { value: string }).toEqual({ value: "C03X76119" });
    expect(await auditRow(viewersRow)).toMatchObject({
      event: "document_reveal",
      self_service: 1,
    });
  });

  it("a viewer may not reveal anybody else's document", async () => {
    for (const id of [adminsRow, ownersRow, unlinkedRow]) {
      expect((await reveal(viewer, id)).status).toBe(403);
      // A refused reveal is not a reveal, so it leaves no row claiming one.
      expect(await auditRow(id)).toBeNull();
    }
  });

  it("an owner revealing somebody else's document is NOT self-service", async () => {
    expect((await reveal(owner, adminsRow)).status).toBe(200);
    expect(await auditRow(adminsRow)).toMatchObject({ self_service: 0 });
  });

  it("an owner revealing their own document IS self-service", async () => {
    // The flag is about whose record it is, not about the role that read it.
    expect((await reveal(owner, ownersRow)).status).toBe(200);
    expect(await auditRow(ownersRow)).toMatchObject({ self_service: 1 });
  });

  it("an admin may still reveal another onboarded member's document", async () => {
    expect((await reveal(admin, otherAdminsRow)).status).toBe(200);
    expect(await auditRow(otherAdminsRow)).toMatchObject({ self_service: 0 });
  });

  it("answers 404, never 403, for a person in another household", async () => {
    for (const who of [owner, admin, viewer]) {
      expect((await reveal(who, otherHouseholdRow)).status).toBe(404);
      expect((await reveal(who, "p-does-not-exist")).status).toBe(404);
    }
    expect(await auditRow(otherHouseholdRow)).toBeNull();
  });
});

describe("GET/POST /api/people/me", () => {
  it("answers 204 when this account has no person row, and creates nothing", async () => {
    const stranger: Identity = {
      ...owner,
      userId: "u-guest",
      email: "guest@example.com",
      role: "viewer",
    };
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM person WHERE household_id = ?")
      .bind("hh-a")
      .first<{ n: number }>();

    for (const method of ["GET", "POST"]) {
      const res = await request(stranger, "/api/people/me", { method });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM person WHERE household_id = ?")
        .bind("hh-a")
        .first<{ n: number }>(),
    ).toEqual(before);
  });

  it("returns the linked row, for a viewer as much as an owner", async () => {
    for (const who of [owner, viewer]) {
      const res = await request(who, "/api/people/me", { method: "POST" });
      expect(res.status).toBe(200);
      expect((await res.json()) as { id: string }).toMatchObject({
        id: who === owner ? ownersRow : viewersRow,
      });
    }
  });

  it("adopts an unlinked row whose email matches the signed-in account", async () => {
    await env.DB.prepare("UPDATE person SET email = ? WHERE id = ?")
      .bind("newcomer@example.com", unlinkedRow)
      .run();
    const newcomer: Identity = {
      ...owner,
      userId: "u-newcomer",
      email: "newcomer@example.com",
      role: "viewer",
    };
    await env.DB.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)")
      .bind("u-newcomer", "newcomer@example.com", new Date().toISOString())
      .run();

    const res = await request(newcomer, "/api/people/me", { method: "GET" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { id: string }).toMatchObject({ id: unlinkedRow });
    // Claimed, so the same viewer may now edit it -- the whole point of the
    // pre-seeded row being the membership.
    expect((await put(newcomer, unlinkedRow, { phone: "+1 208 555 0117" })).status).toBe(200);
  });
});
