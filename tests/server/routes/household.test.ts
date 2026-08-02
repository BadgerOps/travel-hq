import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp, type AppBindings } from "../../../src/server/index.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import type { Identity } from "../../../src/server/auth.js";
import type { HouseholdMember } from "../../../src/server/repos/household-member.js";

const ring = new Keyring("server-v1", {
  "server-v1": crypto.getRandomValues(new Uint8Array(32)),
});
const testEnv = { DB: env.DB } as unknown as AppBindings;
const now = "2026-08-02T00:00:00.000Z";

const owner: Identity = {
  userId: "u-owner",
  email: "sol@example.com",
  householdId: "hh-a",
  role: "owner",
};
const adult: Identity = { ...owner, userId: "u-adult", email: "ada@example.com", role: "adult" };
const teen: Identity = { ...owner, userId: "u-teen", email: "teen@example.com", role: "viewer" };
const tripGuest: Identity = {
  ...owner,
  userId: "u-guest",
  email: "guest@example.com",
  role: "viewer",
};

function appAs(identity: Identity) {
  return createApp({ verify: async () => identity, ring });
}

function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.request(path, init, testEnv);
}

function json(
  app: ReturnType<typeof createApp>,
  path: string,
  method: "POST" | "PUT",
  body: unknown,
) {
  return request(app, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function addUser(id: string, email: string): Promise<void> {
  await env.DB.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)")
    .bind(id, email, now)
    .run();
}

async function addMembership(userId: string, role: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, ?)",
  )
    .bind("hh-a", userId, role)
    .run();
}

async function addPerson(id: string, displayName: string, userId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO person (id, household_id, user_id, display_name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, "hh-a", userId, displayName, `${id}@example.com`, now)
    .run();
}

let ownerApp: ReturnType<typeof createApp>;

beforeEach(async () => {
  for (const table of ["person", "household_member", "user", "household"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-a", "Badger", now)
    .run();
  await addUser(owner.userId, owner.email);
  await addMembership(owner.userId, "owner");
  await env.DB.prepare(
    "INSERT INTO person (id, household_id, user_id, display_name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind("p-owner", "hh-a", owner.userId, "Sol", owner.email, now)
    .run();
  ownerApp = appAs(owner);
});

async function members(app: ReturnType<typeof createApp>): Promise<HouseholdMember[]> {
  const response = await request(app, "/api/household/members");
  expect(response.status).toBe(200);
  return response.json<HouseholdMember[]>();
}

describe("GET /api/household/members", () => {
  it("shows the owner who is here and who has only been invited", async () => {
    expect(
      (await json(ownerApp, "/api/household/members", "POST", {
        email: "kit@example.com",
        role: "adult",
        displayName: "Kit",
      })).status,
    ).toBe(201);

    expect((await members(ownerApp)).map((m) => [m.displayName, m.status])).toEqual([
      ["Kit", "invited"],
      ["Sol", "onboarded"],
    ]);
  });

  it("is readable by a family viewer and refused to a shared-trip guest", async () => {
    await addUser(teen.userId, teen.email);
    await addMembership(teen.userId, "viewer");
    await addPerson("p-teen", "Teen", teen.userId);
    await addUser(tripGuest.userId, tripGuest.email);
    await addMembership(tripGuest.userId, "viewer");

    expect((await members(appAs(teen))).map((m) => [m.displayName, m.status])).toEqual([
      ["Sol", "onboarded"],
      ["Teen", "onboarded"],
      [null, "guest"],
    ]);
    expect((await request(appAs(tripGuest), "/api/household/members")).status).toBe(403);
  });
});

describe("POST /api/household/members", () => {
  it("is owner-only", async () => {
    await addUser(adult.userId, adult.email);
    await addMembership(adult.userId, "adult");
    for (const identity of [adult, teen]) {
      const response = await json(appAs(identity), "/api/household/members", "POST", {
        email: "kit@example.com",
        role: "viewer",
      });
      expect(response.status).toBe(403);
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM user WHERE email = ?")
        .bind("kit@example.com")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("returns the created membership and repeats without duplicating it", async () => {
    const first = await json(ownerApp, "/api/household/members", "POST", {
      email: "  Kit@Example.com ",
      role: "viewer",
      displayName: "Kit",
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      email: "kit@example.com",
      role: "viewer",
      displayName: "Kit",
      claimed: false,
      status: "invited",
    });

    const again = await json(ownerApp, "/api/household/members", "POST", {
      email: "kit@example.com",
      role: "viewer",
    });
    expect(again.status).toBe(201);
    expect((await members(ownerApp)).filter((m) => m.email === "kit@example.com")).toHaveLength(1);
  });

  it("surfaces the server's own message for a malformed email", async () => {
    const response = await json(ownerApp, "/api/household/members", "POST", {
      email: "not-an-email",
      role: "viewer",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Enter a valid email address" });
  });

  it("explains why it will not make someone an owner", async () => {
    const response = await json(ownerApp, "/api/household/members", "POST", {
      email: "kit@example.com",
      role: "owner",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose a role of adult or viewer" });
  });

  it("rejects a body with keys it does not read", async () => {
    const response = await json(ownerApp, "/api/household/members", "POST", {
      email: "kit@example.com",
      role: "viewer",
      claimed: true,
    });
    expect(response.status).toBe(400);
  });
});

describe("PUT /api/household/members/:userId/role", () => {
  beforeEach(async () => {
    await addUser(teen.userId, teen.email);
    await addMembership(teen.userId, "viewer");
    await addPerson("p-teen", "Teen", teen.userId);
  });

  it("promotes and demotes for an owner", async () => {
    const promoted = await json(ownerApp, `/api/household/members/${teen.userId}/role`, "PUT", {
      role: "adult",
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ userId: teen.userId, role: "adult" });

    const demoted = await json(ownerApp, `/api/household/members/${teen.userId}/role`, "PUT", {
      role: "viewer",
    });
    expect(demoted.status).toBe(200);
    expect(await demoted.json()).toMatchObject({ role: "viewer" });
  });

  it("is refused to an adult and to a viewer", async () => {
    await addUser(adult.userId, adult.email);
    await addMembership(adult.userId, "adult");
    for (const identity of [adult, teen]) {
      expect(
        (await json(appAs(identity), `/api/household/members/${teen.userId}/role`, "PUT", {
          role: "adult",
        })).status,
      ).toBe(403);
    }
  });

  it("refuses an owner's attempt to change their own role, and says why", async () => {
    const response = await json(ownerApp, `/api/household/members/${owner.userId}/role`, "PUT", {
      role: "adult",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "You cannot change your own role. Another owner has to do it, so a household is never left without one.",
    });
  });

  it("answers 404 for someone who is not a member of this household", async () => {
    expect(
      (await json(ownerApp, "/api/household/members/u-nobody/role", "PUT", { role: "adult" }))
        .status,
    ).toBe(404);
  });
});
