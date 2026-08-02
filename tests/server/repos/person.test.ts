import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { PersonRepo } from "../../../src/server/repos/person.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { NotFoundError, ValidationError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM household");
  await env.DB.exec("DELETE FROM user");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind(id, id, now).run();
  }
  // person.user_id is a real foreign key, so every account a test links a row
  // to has to exist first.
  for (const [id, email] of [
    ["u1", "badger@example.com"],
    ["u2", "other@example.com"],
    ["u-teen", "teen@example.com"],
    ["u-other", "someone@example.com"],
  ]) {
    await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)")
      .bind(id, email, now).run();
  }
});

describe("PersonRepo", () => {
  it("creates a person and masks the passport in list output", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    await repo.create({
      displayName: "Ava",
      email: "ava@example.com",
      phone: "+1 208 555 0123",
      passportNumber: "C03X72119",
    });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      email: "ava@example.com",
      phone: "+1 208 555 0123",
    });
    expect(list[0]?.passportNumberMasked).toBe("••••2119");
    expect(JSON.stringify(list)).not.toContain("C03X72119");
  });

  /**
   * The row an owner pre-seeded IS the household membership, so signing in
   * claims it rather than making a second one. Twice, because the first call
   * is what onboarding looks like and the second is every request after it.
   */
  it("adopts the unlinked row matching the signed-in email, exactly once", async () => {
    await new PersonRepo(env.DB, ctxA, ring).create({
      displayName: "Sol",
      email: "SOL@BadgerOps.net",
    });

    const repo = new PersonRepo(env.DB, ctxA, ring);
    const first = await repo.ensureCurrentUser("sol@badgerops.net");
    const second = await repo.ensureCurrentUser("sol@badgerops.net");
    expect(first).toBeDefined();
    expect(second?.id).toBe(first?.id);
    expect(first).toMatchObject({ displayName: "Sol" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM person WHERE household_id = ? AND user_id = ?",
    ).bind("hh-a", "u1").first()).toEqual({ count: 1 });
    // And no second person row appeared alongside the adopted one.
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM person WHERE household_id = ?")
      .bind("hh-a").first()).toEqual({ count: 1 });
  });

  /**
   * The load-bearing half of the link-or-nothing rule. TripAccessRepo.invite()
   * provisions a `viewer` for anyone invited to a single shared trip, so a
   * weekend guest and a family teenager are the same role; if this method
   * created a row, "you may edit your own person" would hand that guest a
   * passport field. Membership is the pre-seeded row, and there isn't one.
   */
  it("returns nothing, and CREATES nothing, when no row matches the signed-in user", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    expect(await repo.ensureCurrentUser("guest@example.com")).toBeUndefined();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM person WHERE household_id = ?")
      .bind("hh-a").first()).toEqual({ count: 0 });
  });

  it("does not adopt a row that another account has already claimed", async () => {
    const person = await new PersonRepo(env.DB, ctxA, ring).create({
      displayName: "Ava",
      email: "ava@example.com",
    });
    await env.DB.prepare("UPDATE person SET user_id = ? WHERE id = ?").bind("u-other", person.id).run();

    expect(await new PersonRepo(env.DB, ctxA, ring).ensureCurrentUser("ava@example.com"))
      .toBeUndefined();
    expect(await env.DB.prepare("SELECT user_id FROM person WHERE id = ?").bind(person.id).first())
      .toMatchObject({ user_id: "u-other" });
  });

  /**
   * Resolving your own profile is a READ. Gating it on requireWrite() is
   * exactly what made a viewer's own row unreachable -- and the adopt branch
   * writes, so this also pins that a viewer can complete their own onboarding.
   */
  it("lets a viewer resolve and claim their own pre-seeded row", async () => {
    await new PersonRepo(env.DB, ctxA, ring).create({
      displayName: "Teen",
      email: "teen@example.com",
    });
    const viewer = new PersonRepo(env.DB, { ...ctxA, userId: "u-teen", role: "viewer" }, ring);

    const mine = await viewer.ensureCurrentUser("teen@example.com");
    expect(mine).toMatchObject({ displayName: "Teen" });
    expect(await env.DB.prepare("SELECT user_id FROM person WHERE id = ?").bind(mine!.id).first())
      .toMatchObject({ user_id: "u-teen" });
  });

  it("never adopts a row belonging to another household", async () => {
    await new PersonRepo(env.DB, ctxB, ring).create({
      displayName: "Bo",
      email: "shared@example.com",
    });
    expect(await new PersonRepo(env.DB, ctxA, ring).ensureCurrentUser("shared@example.com"))
      .toBeUndefined();
  });

  it("isolates people by household", async () => {
    await new PersonRepo(env.DB, ctxA, ring).create({ displayName: "Ava" });
    await new PersonRepo(env.DB, ctxB, ring).create({ displayName: "Bo" });
    expect((await new PersonRepo(env.DB, ctxA, ring).list()).map((p) => p.displayName)).toEqual(["Ava"]);
  });

  it("reveals a document only through revealDocument", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    expect(await repo.revealDocument(person.id, "passport_number")).toMatchObject({
      value: "C03X72119",
      // Nobody's row: created by an owner and never linked to an account.
      selfService: false,
    });
  });

  it("a viewer cannot reveal someone else's document", async () => {
    const owner = new PersonRepo(env.DB, ctxA, ring);
    const person = await owner.create({ displayName: "Ava", passportNumber: "C03X72119" });
    const viewer = new PersonRepo(env.DB, { ...ctxA, role: "viewer" }, ring);
    await expect(viewer.revealDocument(person.id, "passport_number")).rejects.toThrow(ForbiddenError);
  });

  it("revealDocument 404s for a person outside the household", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    await expect(repo.revealDocument("nope", "passport_number")).rejects.toThrow(NotFoundError);
  });

  it("revealDocument returns null when the field is unset", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava" });
    expect(await repo.revealDocument(person.id, "passport_number")).toMatchObject({ value: null });
  });

  it("update leaves an absent field unchanged, clears on null, replaces on string", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119", notes: "keep" });
    await repo.update(person.id, { knownTravelerNumber: "KTN999999" });
    expect((await repo.revealDocument(person.id, "passport_number")).value).toBe("C03X72119"); // untouched
    expect((await repo.revealDocument(person.id, "known_traveler_number")).value).toBe("KTN999999");
    await repo.update(person.id, { passportNumber: null });
    expect(await repo.revealDocument(person.id, "passport_number")).toMatchObject({ value: null });
  });

  it("updates and clears optional contact fields", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({
      displayName: "Ava",
      email: "old@example.com",
      phone: "+1 208 555 0100",
    });
    expect(await repo.update(person.id, {
      email: "ava@example.com",
      phone: null,
    })).toMatchObject({
      email: "ava@example.com",
      phone: null,
    });
  });

  it("update rejects a masked value handed back as plaintext", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    await expect(repo.update(person.id, { passportNumber: "••••2119" })).rejects.toThrow(ValidationError);
  });

  it("update 404s for a person outside the household", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    await expect(repo.update("nope", { displayName: "X" })).rejects.toThrow(NotFoundError);
  });

  it("a viewer cannot create", async () => {
    const viewer = new PersonRepo(env.DB, { ...ctxA, role: "viewer" }, ring);
    await expect(viewer.create({ displayName: "Ava" })).rejects.toThrow(ForbiddenError);
  });
});
