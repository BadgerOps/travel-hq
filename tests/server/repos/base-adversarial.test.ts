import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TenantRepo } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

class Probe extends TenantRepo {
  raw<T>(sql: string, ...p: unknown[]): Promise<T[]> { return this.all<T>(sql, ...p); }
  rawRun(sql: string, ...p: unknown[]): Promise<void> { return this.run(sql, ...p); }
  ins(t: string, v: Record<string, unknown>): Promise<void> { return this.insert(t, v); }
}
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let r: Probe;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind(id, id, now).run();
  }
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Mine", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t2", "hh-b", "SECRET", now).run();
  r = new Probe(env.DB, ctxA);
});

async function titleOf(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT title FROM trip WHERE id=?").bind(id).first<{ title: string }>();
  return row?.title;
}
const leaks = (rows: { title: string }[]) => rows.some((x) => x.title === "SECRET");

describe("independent attack suite", () => {
  it("A1 OR 1=1 after token", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE {scope} OR 1=1")).rejects.toThrow();
  });
  it("A2 OR before token", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE 1=1 OR {scope}")).rejects.toThrow();
  });
  it("A3 UNION after token", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE {scope} UNION SELECT title FROM trip")).rejects.toThrow();
  });
  it("A4 subquery + OR 1=1", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE id IN (SELECT id FROM trip WHERE {scope}) OR 1=1")).rejects.toThrow();
  });
  it("A5 HAVING OR", async () => {
    await expect(r.raw("SELECT title FROM trip GROUP BY title HAVING {scope} OR 1=1")).rejects.toThrow();
  });
  it("A6 token in comment", async () => {
    await expect(r.raw("SELECT title FROM trip -- {scope}\n")).rejects.toThrow();
  });
  it("A7 token in string literal", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE title = '{scope}'")).rejects.toThrow();
  });
  it("A8 ? in comment must not misbind", async () => {
    const rows = await r.raw<{ title: string }>("SELECT title FROM trip /* deleted? */ WHERE {scope} AND id = ?2", "t1");
    expect(leaks(rows)).toBe(false);
    expect(rows.map((x) => x.title)).toEqual(["Mine"]);
  });
  it("A9 ? in string literal must not misbind", async () => {
    const rows = await r.raw<{ title: string }>("SELECT title FROM trip WHERE {scope} AND title NOT LIKE '%?%' AND id = ?2", "t1");
    expect(leaks(rows)).toBe(false);
  });
  it("A10 cross-tenant UPDATE writes nothing", async () => {
    await r.rawRun("UPDATE trip SET title = ?2 WHERE {scope} AND id = ?3", "Hijacked", "t2");
    expect(await titleOf("t2")).toBe("SECRET");
  });
  it("A11 viewer cannot run() a write", async () => {
    const v = new Probe(env.DB, { ...ctxA, role: "viewer" });
    await expect(v.rawRun("UPDATE trip SET title=?2 WHERE {scope} AND id=?3", "x", "t1")).rejects.toThrow();
  });
  it("A12 viewer cannot insert()", async () => {
    const v = new Probe(env.DB, { ...ctxA, role: "viewer" });
    await expect(v.ins("trip", { id: "z", title: "z", created_at: "now" })).rejects.toThrow();
  });
  it("A13 error message leaks no schema", async () => {
    try {
      await r.raw("SELECT passport_number FROM person");
      throw new Error("should have thrown");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).not.toContain("passport_number");
      expect(m).not.toContain("person");
    }
  });
  it("A14 insert cannot smuggle household_id", async () => {
    await r.ins("trip", { id: "z", household_id: "hh-b", title: "z", created_at: "now" });
    const row = await env.DB.prepare("SELECT household_id FROM trip WHERE id='z'").first<{ household_id: string }>();
    expect(row?.household_id).toBe("hh-a");
  });
  it("A15 whitespace household id rejected", () => {
    expect(() => new Probe(env.DB, { ...ctxA, householdId: "   " })).toThrow();
  });
  it("A16 legit nested OR in subquery still allowed", async () => {
    const rows = await r.raw<{ title: string }>("SELECT title FROM trip WHERE {scope} AND id IN (SELECT id FROM trip WHERE title='Mine' OR title='Other')");
    expect(rows.map((x) => x.title)).toEqual(["Mine"]);
  });
  // NEW GUARD 1: a caller writing the reserved ?1 in a value position.
  it("A17 caller writing reserved ?1 is rejected", async () => {
    await expect(r.raw("SELECT title FROM trip WHERE {scope} AND id = ?1")).rejects.toThrow();
    // And the row it targeted is untouched / not leaked.
    expect(await titleOf("t2")).toBe("SECRET");
  });
  // NEW GUARD 2: ?1 outside the {scope} expansion, in a select position.
  it("A18 ?1 outside the {scope} expansion is rejected", async () => {
    await expect(r.raw("SELECT ?1 AS x FROM trip WHERE {scope}")).rejects.toThrow();
  });
});
