import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { HouseholdMemberRepo } from "../../../src/server/repos/household-member.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const owner: HouseholdContext = { householdId: "hh-a", userId: "u-owner", role: "owner" };
const otherOwner: HouseholdContext = { householdId: "hh-b", userId: "u-other-owner", role: "owner" };

function repo(ctx: HouseholdContext): HouseholdMemberRepo {
  return new HouseholdMemberRepo(env.DB, ctx);
}

const now = "2026-08-02T00:00:00.000Z";

async function addUser(id: string, email: string): Promise<void> {
  await env.DB.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)")
    .bind(id, email, now)
    .run();
}

async function addMembership(householdId: string, userId: string, role: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, ?)",
  )
    .bind(householdId, userId, role)
    .run();
}

async function addPerson(
  id: string,
  householdId: string,
  displayName: string,
  extra: { userId?: string; email?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO person (id, household_id, user_id, display_name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, householdId, extra.userId ?? null, displayName, extra.email ?? null, now)
    .run();
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...(params as never[]))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function auditRows(): Promise<{ event: string; subject_type: string; subject_id: string }[]> {
  const rows = await env.DB.prepare(
    "SELECT event, subject_type, subject_id FROM audit_log WHERE household_id = ? ORDER BY at, id",
  )
    .bind("hh-a")
    .all<{ event: string; subject_type: string; subject_id: string }>();
  return rows.results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM audit_log");
  for (const table of ["person", "household_member", "user", "household"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind(id, id, now)
      .run();
  }
  // Each household starts the way a real one does: an owner who has signed in,
  // so their person row is already claimed.
  await addUser(owner.userId, "sol@example.com");
  await addMembership(owner.householdId, owner.userId, "owner");
  await addPerson("p-sol", owner.householdId, "Sol", {
    userId: owner.userId,
    email: "sol@example.com",
  });
  await addUser(otherOwner.userId, "kit@example.com");
  await addMembership(otherOwner.householdId, otherOwner.userId, "owner");
  await addPerson("p-kit", otherOwner.householdId, "Kit", {
    userId: otherOwner.userId,
    email: "kit@example.com",
  });
});

describe("HouseholdMemberRepo.invite", () => {
  it("provisions an account, a membership, and the person row that constitutes it", async () => {
    const member = await repo(owner).invite({
      email: "ada@example.com",
      role: "adult",
      displayName: "Ada",
    });

    expect(member).toMatchObject({
      email: "ada@example.com",
      role: "adult",
      displayName: "Ada",
      claimed: false,
      status: "invited",
    });
    expect(member.userId).toBeTruthy();
    expect(member.personId).toBeTruthy();

    // The three rows must agree with each other and with what was returned.
    const user = await env.DB.prepare("SELECT id, email FROM user WHERE lower(email) = ?")
      .bind("ada@example.com")
      .first<{ id: string; email: string }>();
    expect(user?.id).toBe(member.userId);
    const membership = await env.DB.prepare(
      "SELECT role FROM household_member WHERE household_id = ? AND user_id = ?",
    )
      .bind("hh-a", member.userId)
      .first<{ role: string }>();
    expect(membership?.role).toBe("adult");
    const person = await env.DB.prepare(
      "SELECT id, household_id, user_id, display_name, email FROM person WHERE id = ?",
    )
      .bind(member.personId)
      .first<{ household_id: string; user_id: string | null; display_name: string; email: string }>();
    expect(person).toMatchObject({
      household_id: "hh-a",
      // NULL until they sign in: the row is an invitation, not an onboarding.
      user_id: null,
      display_name: "Ada",
      email: "ada@example.com",
    });
  });

  it("records the invitation against the membership it created", async () => {
    const member = await repo(owner).invite({ email: "ada@example.com", role: "adult" });
    expect(await auditRows()).toEqual([
      { event: "member_invited", subject_type: "household_member", subject_id: member.userId },
    ]);
    // Names, never values: the invited address must not be in the audit row.
    const dump = await env.DB.prepare("SELECT * FROM audit_log").all();
    expect(JSON.stringify(dump.results)).not.toContain("ada@example.com");
  });

  it("is idempotent: a second invite creates no second person and no second membership", async () => {
    const first = await repo(owner).invite({ email: "ada@example.com", role: "adult" });
    const second = await repo(owner).invite({ email: "ada@example.com", role: "viewer" });

    expect(second.personId).toBe(first.personId);
    expect(second.userId).toBe(first.userId);
    // The stored role wins over the re-invited one -- a repeat invite must not
    // rewrite an existing role.
    expect(second.role).toBe("adult");

    expect(await count("SELECT COUNT(*) AS count FROM user WHERE lower(email) = ?", "ada@example.com")).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS count FROM household_member WHERE household_id = ? AND user_id = ?",
        "hh-a",
        first.userId,
      ),
    ).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS count FROM person WHERE household_id = ? AND lower(email) = ?", "hh-a", "ada@example.com"),
    ).toBe(1);
  });

  it("does not create a second person for someone who has already onboarded", async () => {
    await addUser("u-ada", "ada@example.com");
    await addPerson("p-ada", "hh-a", "Ada", { userId: "u-ada", email: "ada@example.com" });
    await addMembership("hh-a", "u-ada", "adult");

    const member = await repo(owner).invite({ email: "ADA@example.com", role: "viewer" });
    expect(member).toMatchObject({ personId: "p-ada", claimed: true, status: "onboarded", role: "adult" });
    // Only the owner's own row and Ada's; no second Ada.
    expect(await count("SELECT COUNT(*) AS count FROM person WHERE household_id = ?", "hh-a")).toBe(2);
  });

  it("normalizes case and surrounding whitespace in the email", async () => {
    const member = await repo(owner).invite({ email: "  Ada@Example.COM  ", role: "viewer" });
    expect(member.email).toBe("ada@example.com");
    expect(
      await count("SELECT COUNT(*) AS count FROM user WHERE email = ?", "ada@example.com"),
    ).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS count FROM person WHERE email = ?", "ada@example.com"),
    ).toBe(1);
  });

  it("falls back to a name derived from the email when none is given", async () => {
    const member = await repo(owner).invite({ email: "ada.lovelace@example.com", role: "viewer" });
    expect(member.displayName).toBe("Ada Lovelace");
  });

  it("refuses to make anyone an owner", async () => {
    await expect(
      repo(owner).invite({ email: "ada@example.com", role: "owner" as never }),
    ).rejects.toThrow(ValidationError);
    expect(await count("SELECT COUNT(*) AS count FROM user WHERE lower(email) = ?", "ada@example.com")).toBe(0);
  });

  it("rejects a malformed email with a message written for the person filling in the form", async () => {
    await expect(repo(owner).invite({ email: "not-an-email", role: "adult" })).rejects.toThrow(
      "Enter a valid email address",
    );
    await expect(
      repo(owner).invite({ email: `${"a".repeat(320)}@example.com`, role: "adult" }),
    ).rejects.toThrow(ValidationError);
    // Nothing was written: only the owner's own pre-existing row remains.
    expect(await count("SELECT COUNT(*) AS count FROM person WHERE household_id = ?", "hh-a")).toBe(1);
  });

  it("is owner-only", async () => {
    for (const role of ["adult", "viewer"] as const) {
      await expect(
        repo({ ...owner, userId: "u-someone", role }).invite({
          email: "ada@example.com",
          role: "viewer",
        }),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(await count("SELECT COUNT(*) AS count FROM household_member WHERE household_id = ?", "hh-a")).toBe(1);
  });

  it("leaves an existing account's membership of another household alone", async () => {
    await addUser("u-ada", "ada@example.com");
    await addMembership("hh-b", "u-ada", "adult");

    const member = await repo(owner).invite({ email: "ada@example.com", role: "viewer" });
    expect(member.userId).toBe("u-ada");

    const memberships = await env.DB.prepare(
      "SELECT household_id, role FROM household_member WHERE user_id = ? ORDER BY household_id",
    )
      .bind("u-ada")
      .all<{ household_id: string; role: string }>();
    expect(memberships.results).toEqual([
      { household_id: "hh-a", role: "viewer" },
      { household_id: "hh-b", role: "adult" },
    ]);
    // The invite belongs to this household only: no person row appeared in hh-b.
    expect(
      await count(
        "SELECT COUNT(*) AS count FROM person WHERE household_id = ? AND lower(email) = ?",
        "hh-b",
        "ada@example.com",
      ),
    ).toBe(0);
  });
});

describe("HouseholdMemberRepo.setRole", () => {
  beforeEach(async () => {
    await addUser("u-ada", "ada@example.com");
    await addMembership("hh-a", "u-ada", "viewer");
    await addPerson("p-ada", "hh-a", "Ada", { userId: "u-ada", email: "ada@example.com" });
  });

  async function storedRole(householdId: string, userId: string): Promise<string | undefined> {
    const row = await env.DB.prepare(
      "SELECT role FROM household_member WHERE household_id = ? AND user_id = ?",
    )
      .bind(householdId, userId)
      .first<{ role: string }>();
    return row?.role;
  }

  it("promotes a viewer to adult and demotes them again", async () => {
    const promoted = await repo(owner).setRole("u-ada", "adult");
    expect(promoted).toMatchObject({ userId: "u-ada", role: "adult", personId: "p-ada" });
    expect(await storedRole("hh-a", "u-ada")).toBe("adult");

    const demoted = await repo(owner).setRole("u-ada", "viewer");
    expect(demoted.role).toBe("viewer");
    expect(await storedRole("hh-a", "u-ada")).toBe("viewer");
  });

  it("records the role change against the membership, and records nothing when refused", async () => {
    await repo(owner).setRole("u-ada", "adult");
    expect(await auditRows()).toEqual([
      { event: "member_role_changed", subject_type: "household_member", subject_id: "u-ada" },
    ]);

    await expect(repo(owner).setRole("u-nobody", "adult")).rejects.toThrow(NotFoundError);
    expect(await auditRows()).toHaveLength(1);
  });

  it("is owner-only in both directions", async () => {
    for (const role of ["adult", "viewer"] as const) {
      await expect(
        repo({ householdId: "hh-a", userId: "u-someone", role }).setRole("u-ada", "adult"),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        repo({ householdId: "hh-a", userId: "u-someone", role }).setRole("u-ada", "viewer"),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(await storedRole("hh-a", "u-ada")).toBe("viewer");
  });

  it("refuses to make anyone an owner", async () => {
    await expect(repo(owner).setRole("u-ada", "owner" as never)).rejects.toThrow(ValidationError);
    expect(await storedRole("hh-a", "u-ada")).toBe("viewer");
  });

  it("refuses to let an owner change their own role, in words a person can act on", async () => {
    await expect(repo(owner).setRole(owner.userId, "adult")).rejects.toThrow(
      "You cannot change your own role. Another owner has to do it, so a household is never left without one.",
    );
    expect(await storedRole("hh-a", owner.userId)).toBe("owner");
  });

  it("answers 404 for a non-member and for another household's member alike", async () => {
    await expect(repo(owner).setRole("u-nobody", "adult")).rejects.toThrow(NotFoundError);
    // A real account, a real membership -- in a household this caller is not in.
    await expect(repo(owner).setRole(otherOwner.userId, "adult")).rejects.toThrow(NotFoundError);
    expect(await storedRole("hh-b", otherOwner.userId)).toBe("owner");
  });
});

describe("HouseholdMemberRepo.list", () => {
  it("tells a claimed row apart from a pre-seeded one that nobody has onboarded", async () => {
    await addUser("u-ada", "ada@example.com");
    await addMembership("hh-a", "u-ada", "adult");
    await addPerson("p-ada", "hh-a", "Ada", { userId: "u-ada", email: "ada@example.com" });
    await repo(owner).invite({ email: "bo@example.com", role: "viewer", displayName: "Bo" });
    // A child: a person row with no account behind it at all.
    await addPerson("p-cy", "hh-a", "Cy");

    const list = await repo(owner).list();
    expect(list.map((m) => [m.displayName, m.status, m.claimed, m.role])).toEqual([
      ["Ada", "onboarded", true, "adult"],
      ["Bo", "invited", false, "viewer"],
      ["Cy", "unclaimed", false, null],
      ["Sol", "onboarded", true, "owner"],
    ]);
  });

  it("lists an account with no person row as a guest rather than hiding it", async () => {
    await addUser("u-guest", "guest@example.com");
    await addMembership("hh-a", "u-guest", "viewer");

    const list = await repo(owner).list();
    expect(list.filter((m) => m.status === "guest")).toEqual([
      {
        personId: null,
        displayName: null,
        email: "guest@example.com",
        userId: "u-guest",
        role: "viewer",
        claimed: false,
        status: "guest",
      },
    ]);
  });

  it("never returns another household's members", async () => {
    await repo(owner).invite({ email: "ada@example.com", role: "adult", displayName: "Ada" });
    await repo(otherOwner).invite({ email: "zed@example.com", role: "adult", displayName: "Zed" });

    const mine = await repo(owner).list();
    expect(mine.map((m) => m.email)).toEqual(["ada@example.com", "sol@example.com"]);
    const theirs = await repo(otherOwner).list();
    expect(theirs.map((m) => m.email)).toEqual(["kit@example.com", "zed@example.com"]);
  });

  it("lets a family viewer read the roster but not a shared-trip guest", async () => {
    await addUser("u-teen", "teen@example.com");
    await addMembership("hh-a", "u-teen", "viewer");
    await addPerson("p-teen", "hh-a", "Teen", { userId: "u-teen", email: "teen@example.com" });
    await addUser("u-guest", "guest@example.com");
    await addMembership("hh-a", "u-guest", "viewer");

    const family = await repo({ householdId: "hh-a", userId: "u-teen", role: "viewer" }).list();
    expect(family.map((m) => m.displayName)).toContain("Teen");
    await expect(
      repo({ householdId: "hh-a", userId: "u-guest", role: "viewer" }).list(),
    ).rejects.toThrow(ForbiddenError);
  });
});
