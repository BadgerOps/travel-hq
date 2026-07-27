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
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind(id, id, now).run();
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

  it("isolates people by household", async () => {
    await new PersonRepo(env.DB, ctxA, ring).create({ displayName: "Ava" });
    await new PersonRepo(env.DB, ctxB, ring).create({ displayName: "Bo" });
    expect((await new PersonRepo(env.DB, ctxA, ring).list()).map((p) => p.displayName)).toEqual(["Ava"]);
  });

  it("reveals a document only through revealDocument", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119" });
    expect(await repo.revealDocument(person.id, "passport_number")).toBe("C03X72119");
  });

  it("a viewer cannot reveal a document", async () => {
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
    expect(await repo.revealDocument(person.id, "passport_number")).toBeNull();
  });

  it("update leaves an absent field unchanged, clears on null, replaces on string", async () => {
    const repo = new PersonRepo(env.DB, ctxA, ring);
    const person = await repo.create({ displayName: "Ava", passportNumber: "C03X72119", notes: "keep" });
    await repo.update(person.id, { knownTravelerNumber: "KTN999999" });
    expect(await repo.revealDocument(person.id, "passport_number")).toBe("C03X72119"); // untouched
    expect(await repo.revealDocument(person.id, "known_traveler_number")).toBe("KTN999999");
    await repo.update(person.id, { passportNumber: null });
    expect(await repo.revealDocument(person.id, "passport_number")).toBeNull();
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
