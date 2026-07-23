import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  CardRepo,
  periodStartFor,
  isUsedThisPeriod,
  isValidMonthDay,
} from "../../../src/server/repos/card.js";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };
const viewerA: HouseholdContext = { householdId: "hh-a", userId: "u3", role: "viewer" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM card_perk");
  await env.DB.exec("DELETE FROM card");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
});

describe("period logic (pure)", () => {
  it("monthly periods start on the 1st of the month", () => {
    expect(periodStartFor("monthly", null, "2026-07-23")).toBe("2026-07-01");
    expect(periodStartFor("monthly", null, "2026-07-01")).toBe("2026-07-01");
  });

  it("annual periods default to a calendar-year reset", () => {
    expect(periodStartFor("annual", null, "2026-07-23")).toBe("2026-01-01");
  });

  it("annual periods start at the most recent reset day, which may be last year", () => {
    expect(periodStartFor("annual", "08-15", "2026-07-23")).toBe("2025-08-15");
    expect(periodStartFor("annual", "08-15", "2026-08-15")).toBe("2026-08-15");
    expect(periodStartFor("annual", "08-15", "2026-08-16")).toBe("2026-08-15");
  });

  it("clamps a Feb-29 reset day to Feb 28 in non-leap years", () => {
    expect(periodStartFor("annual", "02-29", "2025-03-01")).toBe("2025-02-28");
    expect(periodStartFor("annual", "02-29", "2024-03-01")).toBe("2024-02-29");
  });

  it("one_time has no period start", () => {
    expect(periodStartFor("one_time", null, "2026-07-23")).toBe(null);
  });

  it("an unused perk is never used-this-period", () => {
    expect(isUsedThisPeriod(null, "monthly", null, "2026-07-23")).toBe(false);
  });

  it("a monthly credit resets when the month rolls over", () => {
    expect(isUsedThisPeriod("2026-06-30T23:00:00.000Z", "monthly", null, "2026-06-30")).toBe(true);
    expect(isUsedThisPeriod("2026-06-30T23:00:00.000Z", "monthly", null, "2026-07-01")).toBe(false);
  });

  it("an annual credit resets on its reset day, not the calendar year", () => {
    // Used in July; reset day Aug 15. Still used until the reset...
    expect(isUsedThisPeriod("2026-07-01T00:00:00.000Z", "annual", "08-15", "2026-08-14")).toBe(true);
    // ...and unspent again from the reset day on.
    expect(isUsedThisPeriod("2026-07-01T00:00:00.000Z", "annual", "08-15", "2026-08-15")).toBe(false);
  });

  it("a one_time credit stays used forever", () => {
    expect(isUsedThisPeriod("2020-01-01T00:00:00.000Z", "one_time", null, "2026-07-23")).toBe(true);
  });

  it("validates MM-DD reset days", () => {
    expect(isValidMonthDay("01-01")).toBe(true);
    expect(isValidMonthDay("12-31")).toBe(true);
    expect(isValidMonthDay("02-29")).toBe(true);
    expect(isValidMonthDay("02-30")).toBe(false);
    expect(isValidMonthDay("13-01")).toBe(false);
    expect(isValidMonthDay("00-10")).toBe(false);
    expect(isValidMonthDay("1-1")).toBe(false);
    expect(isValidMonthDay("04-31")).toBe(false);
  });
});

describe("CardRepo cards", () => {
  it("creates and lists a card, stamping balanceUpdatedAt only when a balance is given", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const bare = await repo.createCard({ name: "Sapphire Reserve", issuer: "Chase" });
    expect(bare.pointsBalance).toBe(null);
    expect(bare.balanceUpdatedAt).toBe(null);

    const funded = await repo.createCard({ name: "Amex Platinum", pointsProgram: "MR", pointsBalance: 120_000 });
    expect(funded.pointsBalance).toBe(120_000);
    expect(funded.balanceUpdatedAt).not.toBe(null);

    const cards = await repo.listWithPerks();
    expect(cards.map((c) => c.name)).toEqual(["Amex Platinum", "Sapphire Reserve"]);
    expect(cards.every((c) => c.perks.length === 0 && c.unspentCents === 0)).toBe(true);
  });

  it("updates tri-state: absent leaves, null clears — and clearing the balance clears its timestamp", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await repo.createCard({ name: "CSR", issuer: "Chase", pointsProgram: "UR", pointsBalance: 85_000 });

    const renamed = await repo.updateCard(card.id, { name: "Sapphire Reserve" });
    expect(renamed.issuer).toBe("Chase");
    expect(renamed.pointsBalance).toBe(85_000);
    expect(renamed.balanceUpdatedAt).toBe(card.balanceUpdatedAt);

    const cleared = await repo.updateCard(card.id, { issuer: null, pointsBalance: null });
    expect(cleared.issuer).toBe(null);
    expect(cleared.pointsBalance).toBe(null);
    expect(cleared.balanceUpdatedAt).toBe(null);
  });

  it("rejects an empty name and a negative balance as ValidationError", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    await expect(repo.createCard({ name: " " })).rejects.toThrow(ValidationError);
    await expect(repo.createCard({ name: "X", pointsBalance: -1 })).rejects.toThrow(ValidationError);
    const card = await repo.createCard({ name: "X" });
    await expect(repo.updateCard(card.id, { name: "" })).rejects.toThrow(ValidationError);
    await expect(repo.updateCard(card.id, { pointsBalance: 1.5 })).rejects.toThrow(ValidationError);
  });

  it("denies viewer writes with ForbiddenError", async () => {
    const owner = new CardRepo(env.DB, ctxA);
    const card = await owner.createCard({ name: "CSR" });
    const viewer = new CardRepo(env.DB, viewerA);
    await expect(viewer.createCard({ name: "Nope" })).rejects.toThrow(ForbiddenError);
    await expect(viewer.updateCard(card.id, { name: "Nope" })).rejects.toThrow(ForbiddenError);
    await expect(viewer.deleteCard(card.id)).rejects.toThrow(ForbiddenError);
  });

  it("never shows, updates, or deletes another household's card", async () => {
    const a = new CardRepo(env.DB, ctxA);
    const card = await a.createCard({ name: "CSR" });

    const b = new CardRepo(env.DB, ctxB);
    expect(await b.findCardById(card.id)).toBeUndefined();
    expect(await b.listWithPerks()).toEqual([]);
    await expect(b.updateCard(card.id, { name: "Stolen" })).rejects.toThrow(NotFoundError);
    await expect(b.deleteCard(card.id)).rejects.toThrow(NotFoundError);

    // And the failed cross-household update touched nothing.
    expect((await a.findCardById(card.id))?.name).toBe("CSR");
  });

  it("deleting a card cascades to its perks", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await repo.createCard({ name: "CSR" });
    await repo.createPerk(card.id, { name: "Travel credit", kind: "statement_credit", valueCents: 30_000, cadence: "annual" });
    await repo.deleteCard(card.id);
    const orphan = await env.DB.prepare("SELECT id FROM card_perk WHERE card_id = ?").bind(card.id).first();
    expect(orphan).toBeNull();
  });
});

describe("CardRepo perks", () => {
  async function makeCard(repo: CardRepo) {
    return repo.createCard({ name: "Sapphire Reserve", pointsProgram: "UR" });
  }

  it("creates, updates, and deletes a perk", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await makeCard(repo);
    const perk = await repo.createPerk(card.id, {
      name: "Travel credit",
      kind: "statement_credit",
      valueCents: 30_000,
      cadence: "annual",
      resetMonthDay: "01-01",
    });
    expect(perk.usedThisPeriod).toBe(false);

    const renamed = await repo.updatePerk(card.id, perk.id, { name: "Annual travel credit", valueCents: 25_000 });
    expect(renamed.name).toBe("Annual travel credit");
    expect(renamed.valueCents).toBe(25_000);

    await repo.deletePerk(card.id, perk.id);
    expect((await repo.listWithPerks())[0]!.perks).toEqual([]);
  });

  it("validates the perk shape with specific errors", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await makeCard(repo);

    // A statement credit / fee offset must carry a value.
    await expect(
      repo.createPerk(card.id, { name: "Credit", kind: "statement_credit", cadence: "annual" }),
    ).rejects.toThrow(ValidationError);
    // A multiplier needs multiplier + category, and has no dollar value.
    await expect(
      repo.createPerk(card.id, { name: "3x", kind: "multiplier", cadence: "one_time", multiplier: 3 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.createPerk(card.id, { name: "3x", kind: "multiplier", cadence: "one_time", multiplier: 3, category: "travel", valueCents: 100 }),
    ).rejects.toThrow(ValidationError);
    // multiplier/category are multiplier-only.
    await expect(
      repo.createPerk(card.id, { name: "Credit", kind: "statement_credit", valueCents: 100, cadence: "annual", multiplier: 2 }),
    ).rejects.toThrow(ValidationError);
    // Reset day is annual-only and must be a real MM-DD.
    await expect(
      repo.createPerk(card.id, { name: "Credit", kind: "statement_credit", valueCents: 100, cadence: "monthly", resetMonthDay: "01-01" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.createPerk(card.id, { name: "Credit", kind: "statement_credit", valueCents: 100, cadence: "annual", resetMonthDay: "02-30" }),
    ).rejects.toThrow(ValidationError);
  });

  it("validates the MERGED shape on update, so a kind change cannot smuggle a bad combination", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await makeCard(repo);
    const perk = await repo.createPerk(card.id, {
      name: "Travel credit",
      kind: "statement_credit",
      valueCents: 30_000,
      cadence: "annual",
    });
    // Becoming a multiplier while keeping value_cents must fail...
    await expect(
      repo.updatePerk(card.id, perk.id, { kind: "multiplier", multiplier: 3, category: "travel" }),
    ).rejects.toThrow(ValidationError);
    // ...and the coherent version of the same change succeeds.
    const changed = await repo.updatePerk(card.id, perk.id, {
      kind: "multiplier",
      multiplier: 3,
      category: "travel",
      valueCents: null,
      cadence: "one_time",
      resetMonthDay: null,
    });
    expect(changed.kind).toBe("multiplier");
    expect(changed.valueCents).toBe(null);
  });

  it("marks a credit used and unused, and 400s for a multiplier", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await makeCard(repo);
    const credit = await repo.createPerk(card.id, { name: "Credit", kind: "statement_credit", valueCents: 30_000, cadence: "annual" });
    const mult = await repo.createPerk(card.id, { name: "3x travel", kind: "multiplier", multiplier: 3, category: "travel", cadence: "one_time" });

    await repo.setPerkUsed(card.id, credit.id, true);
    let [withPerks] = await repo.listWithPerks();
    expect(withPerks!.perks.find((p) => p.id === credit.id)!.usedThisPeriod).toBe(true);
    expect(withPerks!.unspentCents).toBe(0);

    await repo.setPerkUsed(card.id, credit.id, false);
    [withPerks] = await repo.listWithPerks();
    expect(withPerks!.perks.find((p) => p.id === credit.id)!.usedThisPeriod).toBe(false);
    expect(withPerks!.unspentCents).toBe(30_000);

    await expect(repo.setPerkUsed(card.id, mult.id, true)).rejects.toThrow(ValidationError);
  });

  it("a used credit reads as unspent again once its period rolls over — no write needed", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await makeCard(repo);
    const monthly = await repo.createPerk(card.id, { name: "Dining credit", kind: "statement_credit", valueCents: 1_000, cadence: "monthly" });
    const oneTime = await repo.createPerk(card.id, { name: "Global Entry", kind: "statement_credit", valueCents: 10_000, cadence: "one_time" });
    await repo.setPerkUsed(card.id, monthly.id, true);
    await repo.setPerkUsed(card.id, oneTime.id, true);

    // Within the month it was used: spent.
    const today = new Date().toISOString().slice(0, 10);
    let [row] = await repo.listWithPerks(today);
    expect(row!.perks.find((p) => p.id === monthly.id)!.usedThisPeriod).toBe(true);
    expect(row!.unspentCents).toBe(0);

    // The 1st of the NEXT month: the monthly credit reset; the one_time did not.
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
    [row] = await repo.listWithPerks(nextMonth);
    expect(row!.perks.find((p) => p.id === monthly.id)!.usedThisPeriod).toBe(false);
    expect(row!.perks.find((p) => p.id === oneTime.id)!.usedThisPeriod).toBe(true);
    expect(row!.unspentCents).toBe(1_000);
  });

  it("computes unspentCents from unused, valued, non-multiplier perks only", async () => {
    const repo = new CardRepo(env.DB, ctxA);
    const card = await makeCard(repo);
    await repo.createPerk(card.id, { name: "Travel credit", kind: "statement_credit", valueCents: 30_000, cadence: "annual" });
    const used = await repo.createPerk(card.id, { name: "Fee offset", kind: "fee_offset", valueCents: 10_000, cadence: "annual" });
    await repo.createPerk(card.id, { name: "Lounge", kind: "lounge", cadence: "annual" }); // unvalued
    await repo.createPerk(card.id, { name: "3x travel", kind: "multiplier", multiplier: 3, category: "travel", cadence: "one_time" });
    await repo.setPerkUsed(card.id, used.id, true);

    const [row] = await repo.listWithPerks();
    expect(row!.unspentCents).toBe(30_000);
  });

  it("scopes perks to household AND card", async () => {
    const a = new CardRepo(env.DB, ctxA);
    const card = await makeCard(a);
    const other = await a.createCard({ name: "Amex Gold" });
    const perk = await a.createPerk(card.id, { name: "Credit", kind: "statement_credit", valueCents: 100, cadence: "annual" });

    // The right perk under the WRONG card is not found.
    await expect(a.updatePerk(other.id, perk.id, { name: "X" })).rejects.toThrow(NotFoundError);
    await expect(a.deletePerk(other.id, perk.id)).rejects.toThrow(NotFoundError);
    await expect(a.setPerkUsed(other.id, perk.id, true)).rejects.toThrow(NotFoundError);

    // Another household sees nothing at all.
    const b = new CardRepo(env.DB, ctxB);
    await expect(b.setPerkUsed(card.id, perk.id, true)).rejects.toThrow(NotFoundError);
    await expect(b.createPerk(card.id, { name: "X", kind: "lounge", cadence: "annual" })).rejects.toThrow(NotFoundError);
  });

  it("denies viewer perk writes with ForbiddenError", async () => {
    const owner = new CardRepo(env.DB, ctxA);
    const card = await makeCard(owner);
    const perk = await owner.createPerk(card.id, { name: "Credit", kind: "statement_credit", valueCents: 100, cadence: "annual" });

    const viewer = new CardRepo(env.DB, viewerA);
    await expect(viewer.createPerk(card.id, { name: "X", kind: "lounge", cadence: "annual" })).rejects.toThrow(ForbiddenError);
    await expect(viewer.updatePerk(card.id, perk.id, { name: "X" })).rejects.toThrow(ForbiddenError);
    await expect(viewer.deletePerk(card.id, perk.id)).rejects.toThrow(ForbiddenError);
    await expect(viewer.setPerkUsed(card.id, perk.id, true)).rejects.toThrow(ForbiddenError);
    // A viewer may still read.
    expect((await viewer.listWithPerks())[0]!.perks).toHaveLength(1);
  });
});
