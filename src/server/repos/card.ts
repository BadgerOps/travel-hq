import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import { newId } from "../ids.js";

export const PERK_KINDS = [
  "statement_credit",
  "free_night",
  "lounge",
  "multiplier",
  "fee_offset",
] as const;
export type PerkKind = (typeof PERK_KINDS)[number];

export const PERK_CADENCES = ["annual", "monthly", "one_time"] as const;
export type PerkCadence = (typeof PERK_CADENCES)[number];

/**
 * A card deliberately carries NO sensitive data: no PAN, no last4, no account
 * numbers -- it is a display name plus points metadata, referenced everywhere
 * by its opaque id. That is why nothing in this repository touches the
 * Keyring/mask machinery the person and booking repos need. Anything secret a
 * future feature wants stored belongs on the encrypted-envelope path
 * (loyalty_account.account_number), not on this table.
 */
export type Card = {
  id: string;
  name: string;
  issuer: string | null;
  pointsProgram: string | null;
  pointsBalance: number | null;
  /** Stamped server-side whenever pointsBalance is set; honest staleness data. */
  balanceUpdatedAt: string | null;
};

export type CardPerk = {
  id: string;
  cardId: string;
  name: string;
  kind: PerkKind;
  /** Credit value in cents; null for unvalued perks, always null for multipliers. */
  valueCents: number | null;
  /** Earn multiplier (e.g. 3 for 3x); set only when kind is "multiplier". */
  multiplier: number | null;
  /** Spend category the multiplier applies to; set only when kind is "multiplier". */
  category: string | null;
  cadence: PerkCadence;
  /** Annual reset day as MM-DD; null means 01-01. Only meaningful for annual cadence. */
  resetMonthDay: string | null;
  /** When the credit was last marked used; null = unused / marked unused. */
  usedAt: string | null;
};

/** A perk plus its derived credit status for the period `today` falls in. */
export type PerkWithStatus = CardPerk & { usedThisPeriod: boolean };

export type CardWithPerks = Card & {
  perks: PerkWithStatus[];
  /**
   * Sum of value_cents over credits NOT used this period. Multiplier perks
   * never count (a multiplier is not a credit); unvalued perks contribute 0.
   */
  unspentCents: number;
};

export type CreateCardInput = {
  name: string;
  issuer?: string;
  pointsProgram?: string;
  pointsBalance?: number;
};

/** Nullable fields are tri-state: absent = leave, null = clear, value = set. */
export type UpdateCardInput = {
  name?: string;
  issuer?: string | null;
  pointsProgram?: string | null;
  pointsBalance?: number | null;
};

export type CreatePerkInput = {
  name: string;
  kind: PerkKind;
  valueCents?: number;
  multiplier?: number;
  category?: string;
  cadence: PerkCadence;
  resetMonthDay?: string;
};

/** Nullable fields are tri-state, matching UpdateCardInput / UpdatePersonInput. */
export type UpdatePerkInput = {
  name?: string;
  kind?: PerkKind;
  valueCents?: number | null;
  multiplier?: number | null;
  category?: string | null;
  cadence?: PerkCadence;
  resetMonthDay?: string | null;
};

/** Today as a UTC calendar date (YYYY-MM-DD). Period math is UTC by design --
 * the server has no per-user timezone, and for month/year-granularity credits
 * a few hours' skew at the boundary is accepted. See the design spec. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Feb permits 29 here; the clamp to 28 in non-leap years happens per-year in
// annualResetFor, so a card whose credit resets every Feb 29 stays storable.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isValidMonthDay(value: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= (DAYS_IN_MONTH[month - 1] ?? 0);
}

function annualResetFor(year: number, monthDay: string): string {
  if (monthDay === "02-29" && !isLeapYear(year)) return `${year}-02-28`;
  return `${year}-${monthDay}`;
}

/**
 * The first day of the period `today` falls in, as YYYY-MM-DD -- or null for
 * one_time, whose single period has no start ("used once is used forever").
 *
 * - monthly: the 1st of today's month.
 * - annual: the most recent occurrence of resetMonthDay (default 01-01),
 *   which may be in the previous calendar year.
 *
 * Pure and injectable so tests pin period boundaries exactly.
 */
export function periodStartFor(
  cadence: PerkCadence,
  resetMonthDay: string | null,
  today: string,
): string | null {
  if (cadence === "one_time") return null;
  if (cadence === "monthly") return `${today.slice(0, 7)}-01`;
  const monthDay = resetMonthDay ?? "01-01";
  const year = Number(today.slice(0, 4));
  const resetThisYear = annualResetFor(year, monthDay);
  return resetThisYear <= today ? resetThisYear : annualResetFor(year - 1, monthDay);
}

/**
 * Derives "used this period" from the stored used_at timestamp. Nothing is
 * ever written at a period rollover: an old used_at simply falls outside the
 * new period and the credit reads as unspent again.
 */
export function isUsedThisPeriod(
  usedAt: string | null,
  cadence: PerkCadence,
  resetMonthDay: string | null,
  today: string,
): boolean {
  if (usedAt === null) return false;
  const start = periodStartFor(cadence, resetMonthDay, today);
  if (start === null) return true; // one_time: used once is used forever
  return usedAt.slice(0, 10) >= start;
}

/** Input key -> column, fixed maps so no request key ever names a column. */
const CARD_COLUMNS = {
  name: "name",
  issuer: "issuer",
  pointsProgram: "points_program",
  pointsBalance: "points_balance",
} as const;

const PERK_COLUMNS = {
  name: "name",
  kind: "kind",
  valueCents: "value_cents",
  multiplier: "multiplier",
  category: "category",
  cadence: "cadence",
  resetMonthDay: "reset_month_day",
} as const;

/** The full perk shape every create/update must satisfy as a whole. */
type PerkShape = {
  name: string;
  kind: PerkKind;
  valueCents: number | null;
  multiplier: number | null;
  category: string | null;
  cadence: PerkCadence;
  resetMonthDay: string | null;
};

/**
 * One validator for the WHOLE perk shape, applied to creates and to the
 * merged result of updates -- so a kind change cannot smuggle an invalid
 * combination (say, a multiplier that kept its value_cents) through a
 * partial update.
 */
function validatePerkShape(p: PerkShape): void {
  if (typeof p.name !== "string" || p.name.trim() === "") {
    throw new ValidationError("name must be a non-empty string");
  }
  if (!PERK_KINDS.includes(p.kind)) {
    throw new ValidationError(`kind must be one of ${PERK_KINDS.join(", ")}`);
  }
  if (!PERK_CADENCES.includes(p.cadence)) {
    throw new ValidationError(`cadence must be one of ${PERK_CADENCES.join(", ")}`);
  }
  if (p.valueCents !== null && (!Number.isInteger(p.valueCents) || p.valueCents <= 0)) {
    throw new ValidationError("valueCents must be a positive integer");
  }
  if (p.resetMonthDay !== null) {
    if (p.cadence !== "annual") {
      throw new ValidationError("resetMonthDay only applies to annual cadence");
    }
    if (!isValidMonthDay(p.resetMonthDay)) {
      throw new ValidationError("resetMonthDay must be a valid MM-DD");
    }
  }
  if (p.kind === "multiplier") {
    if (p.multiplier === null || !Number.isFinite(p.multiplier) || p.multiplier <= 0) {
      throw new ValidationError("a multiplier perk requires a positive multiplier");
    }
    if (p.category === null || p.category.trim() === "") {
      throw new ValidationError("a multiplier perk requires a category");
    }
    if (p.valueCents !== null) {
      throw new ValidationError("a multiplier perk has no credit value; omit valueCents");
    }
  } else {
    if (p.multiplier !== null || p.category !== null) {
      throw new ValidationError("multiplier and category only apply to multiplier perks");
    }
    if ((p.kind === "statement_credit" || p.kind === "fee_offset") && p.valueCents === null) {
      throw new ValidationError(`a ${p.kind} perk requires valueCents`);
    }
  }
}

function validateBalance(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError("pointsBalance must be a non-negative integer");
  }
}

type CardRow = {
  id: string;
  name: string;
  issuer: string | null;
  points_program: string | null;
  points_balance: number | null;
  balance_updated_at: string | null;
};

type PerkRow = {
  id: string;
  card_id: string;
  name: string;
  kind: PerkKind;
  value_cents: number | null;
  multiplier: number | null;
  category: string | null;
  cadence: PerkCadence;
  reset_month_day: string | null;
  used_at: string | null;
};

export class CardRepo extends TenantRepo {
  // ---- cards -------------------------------------------------------------

  async createCard(input: CreateCardInput): Promise<Card> {
    // Redundant with base.ts's own requireWrite() inside run()/insert() --
    // kept as explicit intent at the top of every mutating method, matching
    // TripRepo/BookingRepo/PersonRepo.
    this.requireWrite();
    if (typeof input.name !== "string" || input.name.trim() === "") {
      throw new ValidationError("name must be a non-empty string");
    }
    if (input.pointsBalance !== undefined) validateBalance(input.pointsBalance);
    const id = newId();
    const now = new Date().toISOString();
    await this.insert("card", {
      id,
      name: input.name,
      issuer: input.issuer ?? null,
      points_program: input.pointsProgram ?? null,
      points_balance: input.pointsBalance ?? null,
      balance_updated_at: input.pointsBalance !== undefined ? now : null,
      created_at: now,
    });
    const created = await this.findCardById(id);
    if (!created) throw new Error("Card disappeared immediately after creation");
    return created;
  }

  async updateCard(id: string, input: UpdateCardInput): Promise<Card> {
    this.requireWrite();
    // NotFoundError, not TenantScopeError: an id that isn't in this household
    // is an ordinary bad id, exactly as PersonRepo.update treats it.
    if (!(await this.findCardById(id))) {
      throw new NotFoundError("Card not found in this household");
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    // Caller param k (1-based) binds to ?(k+1); the household id owns ?1.
    let next = 2;

    for (const [key, column] of Object.entries(CARD_COLUMNS)) {
      const value = input[key as keyof UpdateCardInput];
      // `undefined` is "not supplied" -- the tri-state's whole point.
      if (value === undefined) continue;
      if (key === "name" && (typeof value !== "string" || value.trim() === "")) {
        throw new ValidationError("name must be a non-empty string");
      }
      if (key === "pointsBalance" && value !== null) validateBalance(value as number);
      sets.push(`${column} = ?${next++}`);
      params.push(value ?? null);
    }

    // A balance write (set OR clear) restamps its freshness marker; clearing
    // the balance clears the timestamp with it -- a timestamp for a balance
    // that no longer exists would be a lie.
    if (input.pointsBalance !== undefined) {
      sets.push(`balance_updated_at = ?${next++}`);
      params.push(input.pointsBalance === null ? null : new Date().toISOString());
    }

    if (sets.length > 0) {
      await this.run(
        `UPDATE card SET ${sets.join(", ")} WHERE {scope} AND id = ?${next}`,
        ...params,
        id,
      );
    }

    const updated = await this.findCardById(id);
    if (!updated) throw new Error("Card disappeared immediately after update");
    return updated;
  }

  async deleteCard(id: string): Promise<void> {
    this.requireWrite();
    // Without this, an unknown/cross-household id matches zero rows, the
    // DELETE succeeds vacuously, and the route answers 204 for nothing --
    // same existence-check-then-act shape as ChecklistRepo.setDone.
    if (!(await this.findCardById(id))) {
      throw new NotFoundError("Card not found in this household");
    }
    // card_perk rows go with it via ON DELETE CASCADE.
    await this.run("DELETE FROM card WHERE {scope} AND id = ?2", id);
  }

  async findCardById(id: string): Promise<Card | undefined> {
    const row = await this.get<CardRow>("SELECT * FROM card WHERE {scope} AND id = ?2", id);
    return row ? toCard(row) : undefined;
  }

  /**
   * The Cards page's one read: every card with its perks, each perk's derived
   * usedThisPeriod, and the card's unspent-credit total for the period `today`
   * falls in. `today` is injectable for tests; production uses the UTC date.
   */
  async listWithPerks(today: string = todayUtc()): Promise<CardWithPerks[]> {
    const cardRows = await this.all<CardRow>(
      "SELECT * FROM card WHERE {scope} ORDER BY name, created_at",
    );
    const perkRows = await this.all<PerkRow>(
      "SELECT * FROM card_perk WHERE {scope} ORDER BY created_at",
    );

    const byCard = new Map<string, PerkWithStatus[]>();
    for (const row of perkRows) {
      const perk = toPerkWithStatus(row, today);
      const list = byCard.get(row.card_id);
      if (list) list.push(perk);
      else byCard.set(row.card_id, [perk]);
    }

    return cardRows.map((row) => {
      const perks = byCard.get(row.id) ?? [];
      return { ...toCard(row), perks, unspentCents: unspentTotal(perks) };
    });
  }

  // ---- perks -------------------------------------------------------------

  async createPerk(cardId: string, input: CreatePerkInput, today: string = todayUtc()): Promise<PerkWithStatus> {
    this.requireWrite();
    if (!(await this.findCardById(cardId))) {
      throw new NotFoundError("Card not found in this household");
    }
    const shape: PerkShape = {
      name: input.name,
      kind: input.kind,
      valueCents: input.valueCents ?? null,
      multiplier: input.multiplier ?? null,
      category: input.category ?? null,
      cadence: input.cadence,
      resetMonthDay: input.resetMonthDay ?? null,
    };
    validatePerkShape(shape);

    const id = newId();
    await this.insert("card_perk", {
      id,
      card_id: cardId,
      name: shape.name,
      kind: shape.kind,
      value_cents: shape.valueCents,
      multiplier: shape.multiplier,
      category: shape.category,
      cadence: shape.cadence,
      reset_month_day: shape.resetMonthDay,
      used_at: null,
      created_at: new Date().toISOString(),
    });

    const created = await this.findPerk(cardId, id);
    if (!created) throw new Error("Perk disappeared immediately after creation");
    return toPerkWithStatus(created, today);
  }

  async updatePerk(
    cardId: string,
    perkId: string,
    input: UpdatePerkInput,
    today: string = todayUtc(),
  ): Promise<PerkWithStatus> {
    this.requireWrite();
    const existing = await this.findPerk(cardId, perkId);
    if (!existing) throw new NotFoundError("Perk not found in this household");

    // Validate the MERGED row, so a partial update can't produce a shape a
    // create would have rejected.
    const merged: PerkShape = {
      name: input.name ?? existing.name,
      kind: input.kind ?? existing.kind,
      valueCents: input.valueCents === undefined ? existing.value_cents : input.valueCents,
      multiplier: input.multiplier === undefined ? existing.multiplier : input.multiplier,
      category: input.category === undefined ? existing.category : input.category,
      cadence: input.cadence ?? existing.cadence,
      resetMonthDay:
        input.resetMonthDay === undefined ? existing.reset_month_day : input.resetMonthDay,
    };
    validatePerkShape(merged);

    const sets: string[] = [];
    const params: unknown[] = [];
    let next = 2;
    for (const [key, column] of Object.entries(PERK_COLUMNS)) {
      const value = input[key as keyof UpdatePerkInput];
      if (value === undefined) continue;
      sets.push(`${column} = ?${next++}`);
      params.push(value ?? null);
    }

    if (sets.length > 0) {
      await this.run(
        `UPDATE card_perk SET ${sets.join(", ")} WHERE {scope} AND card_id = ?${next} AND id = ?${next + 1}`,
        ...params,
        cardId,
        perkId,
      );
    }

    const updated = await this.findPerk(cardId, perkId);
    if (!updated) throw new Error("Perk disappeared immediately after update");
    return toPerkWithStatus(updated, today);
  }

  async deletePerk(cardId: string, perkId: string): Promise<void> {
    this.requireWrite();
    if (!(await this.findPerk(cardId, perkId))) {
      throw new NotFoundError("Perk not found in this household");
    }
    await this.run(
      "DELETE FROM card_perk WHERE {scope} AND card_id = ?2 AND id = ?3",
      cardId,
      perkId,
    );
  }

  /**
   * Marks a perk's credit used (stamps used_at = now) or unused (clears it)
   * for the current period. A multiplier perk has no credit to spend, so
   * marking one is rejected -- ValidationError, 400, not a silent no-op.
   */
  async setPerkUsed(cardId: string, perkId: string, used: boolean): Promise<void> {
    this.requireWrite();
    const perk = await this.findPerk(cardId, perkId);
    if (!perk) throw new NotFoundError("Perk not found in this household");
    if (perk.kind === "multiplier") {
      throw new ValidationError("A multiplier perk has no credit to mark used");
    }
    await this.run(
      "UPDATE card_perk SET used_at = ?2 WHERE {scope} AND card_id = ?3 AND id = ?4",
      used ? new Date().toISOString() : null,
      cardId,
      perkId,
    );
  }

  /** Scoped by household AND card, so a perk under a different card 404s. */
  private async findPerk(cardId: string, perkId: string): Promise<PerkRow | undefined> {
    return this.get<PerkRow>(
      "SELECT * FROM card_perk WHERE {scope} AND card_id = ?2 AND id = ?3",
      cardId,
      perkId,
    );
  }
}

function toCard(r: CardRow): Card {
  return {
    id: r.id,
    name: r.name,
    issuer: r.issuer,
    pointsProgram: r.points_program,
    pointsBalance: r.points_balance,
    balanceUpdatedAt: r.balance_updated_at,
  };
}

function toPerkWithStatus(r: PerkRow, today: string): PerkWithStatus {
  return {
    id: r.id,
    cardId: r.card_id,
    name: r.name,
    kind: r.kind,
    valueCents: r.value_cents,
    multiplier: r.multiplier,
    category: r.category,
    cadence: r.cadence,
    resetMonthDay: r.reset_month_day,
    usedAt: r.used_at,
    usedThisPeriod: isUsedThisPeriod(r.used_at, r.cadence, r.reset_month_day, today),
  };
}

function unspentTotal(perks: PerkWithStatus[]): number {
  let total = 0;
  for (const p of perks) {
    if (p.kind === "multiplier" || p.usedThisPeriod || p.valueCents === null) continue;
    total += p.valueCents;
  }
  return total;
}
