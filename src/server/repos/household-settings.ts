import { TenantRepo, ForbiddenError, ValidationError } from "./base.js";

/**
 * The one place the default extractor model is spelled out. The ingest
 * extractor (issue #6) imports this rather than repeating the literal, so a
 * future model bump is a one-line change here.
 */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export type HouseholdSettings = {
  /** Where mail for this household is sent; null = ingest not configured. */
  forwardAddress: string | null;
  /**
   * Addresses and/or bare domains permitted to submit mail, enforced by the
   * ingest handler together with DMARC/SPF. Empty = no ingest at all.
   */
  senderAllowlist: string[];
  /** The Workers AI model id the extractor runs. */
  aiModel: string;
};

/**
 * Every field optional: absent leaves the stored value untouched (same
 * tri-state convention as UpdatePersonInput). `forwardAddress: null` clears
 * the address; the allowlist has no null case — clearing it is `[]`.
 */
export type UpdateHouseholdSettingsInput = {
  forwardAddress?: string | null;
  senderAllowlist?: string[];
  aiModel?: string;
};

/**
 * What `findHouseholdByForwardAddress` resolves for the ingest handler (#4):
 * the household the inbound To: address belongs to, plus that household's
 * settings, in one lookup — so ingest never needs to fabricate a
 * HouseholdContext just to read the allowlist and model.
 */
export type ForwardAddressMatch = {
  householdId: string;
  settings: HouseholdSettings;
};

/** The defaults a household with no settings row behaves as. */
export function defaultHouseholdSettings(): HouseholdSettings {
  return { forwardAddress: null, senderAllowlist: [], aiModel: DEFAULT_AI_MODEL };
}

type Row = {
  forward_address: string | null;
  sender_allowlist: string;
  ai_model: string;
};

export class HouseholdSettingsRepo extends TenantRepo {
  /**
   * The household's settings, or the defaults when no row exists yet.
   * Owner/adult only — see requireOwnerOrAdult below.
   */
  async getSettings(): Promise<HouseholdSettings> {
    this.requireOwnerOrAdult();
    const row = await this.getRow();
    return row ? toSettings(row) : defaultHouseholdSettings();
  }

  /**
   * Upserts the household's single settings row. Absent fields keep their
   * stored value; the first write creates the row from the defaults plus
   * whatever the caller supplied.
   */
  async updateSettings(input: UpdateHouseholdSettingsInput): Promise<HouseholdSettings> {
    // Redundant with base.ts's own requireWrite() inside run()/insert() --
    // kept as explicit intent at the top of every mutating method, matching
    // TripRepo/BookingRepo/PersonRepo.
    this.requireWrite();

    const current = await this.getRow();

    const forwardAddress =
      input.forwardAddress === undefined
        ? (current?.forward_address ?? null)
        : normalizeForwardAddress(input.forwardAddress);
    const senderAllowlist =
      input.senderAllowlist === undefined
        ? (current?.sender_allowlist ?? "[]")
        : JSON.stringify(normalizeAllowlist(input.senderAllowlist));
    const aiModel =
      input.aiModel === undefined ? (current?.ai_model ?? DEFAULT_AI_MODEL) : normalizeModel(input.aiModel);

    if (forwardAddress !== null) {
      // ValidationError (400), not a raw UNIQUE-constraint failure (500): two
      // households claiming one forward address would make the ingest
      // handler's To: lookup ambiguous, so the column is globally unique and
      // a clash is an ordinary bad request. The check must look across
      // households by definition, hence unscoped; the schema's UNIQUE
      // constraint remains the backstop if two writes race.
      const claims = await this.unscoped<{ household_id: string }>(
        "forward_address is globally unique; a clash check must look across households",
        "SELECT household_id FROM household_settings WHERE forward_address = ?",
        forwardAddress,
      );
      if (claims.some((c) => c.household_id !== this.ctx.householdId)) {
        throw new ValidationError("That forward address is already in use by another household");
      }
    }

    const now = new Date().toISOString();
    if (current) {
      await this.run(
        `UPDATE household_settings
            SET forward_address = ?2, sender_allowlist = ?3, ai_model = ?4, updated_at = ?5
          WHERE {scope}`,
        forwardAddress,
        senderAllowlist,
        aiModel,
        now,
      );
    } else {
      await this.insert("household_settings", {
        forward_address: forwardAddress,
        sender_allowlist: senderAllowlist,
        ai_model: aiModel,
        created_at: now,
        updated_at: now,
      });
    }

    return this.getSettings();
  }

  /**
   * Resolves which household an inbound message belongs to by its To:
   * address, WITHOUT a HouseholdContext — the ingest handler (#4) runs
   * before any tenant is known, which is exactly why this is static. Returns
   * the household id and its settings in one lookup so the caller can check
   * the allowlist and pick the model without a second query. `undefined`
   * means no household has claimed that address and the message must not be
   * ingested.
   *
   * Raw db.prepare is legitimate here: this file lives in repos/, the layer
   * the architecture test allows to prepare statements, and the query is
   * unscoped by definition — the household id is its OUTPUT.
   */
  static async findHouseholdByForwardAddress(
    db: D1Database,
    to: string,
  ): Promise<ForwardAddressMatch | undefined> {
    const address = to.trim().toLowerCase();
    if (address === "") return undefined;
    const row = await db
      .prepare(
        `SELECT household_id, forward_address, sender_allowlist, ai_model
           FROM household_settings
          WHERE forward_address = ?`,
      )
      .bind(address)
      .first<Row & { household_id: string }>();
    if (!row) return undefined;
    return { householdId: row.household_id, settings: toSettings(row) };
  }

  private async getRow(): Promise<Row | undefined> {
    return this.get<Row>(
      "SELECT forward_address, sender_allowlist, ai_model FROM household_settings WHERE {scope}",
    );
  }

  /**
   * Settings are owner/adult only in BOTH directions, unlike ordinary domain
   * reads: the forward address and sender allowlist decide whose mail can
   * write into this household, so even seeing them is configuration access,
   * not trip-viewing. requireWrite() would deny the same role, but its
   * message ("may not modify") would be a lie on a GET.
   */
  private requireOwnerOrAdult(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not access household settings");
    }
  }
}

function toSettings(r: Row): HouseholdSettings {
  return {
    forwardAddress: r.forward_address,
    senderAllowlist: parseAllowlist(r.sender_allowlist),
    aiModel: r.ai_model,
  };
}

function parseAllowlist(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every((e): e is string => typeof e === "string")) {
      return parsed;
    }
  } catch {
    // fall through
  }
  // Corrupt stored JSON fails CLOSED: an unreadable allowlist behaves as an
  // empty one, and an empty allowlist means no sender may submit mail.
  return [];
}

/** One non-empty local part, one @, one non-empty domain, no whitespace. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+$/;

function normalizeForwardAddress(addr: string | null): string | null {
  if (addr === null) return null;
  const normalized = addr.trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) {
    throw new ValidationError("forwardAddress must be a single email address");
  }
  return normalized;
}

/**
 * Trims, lowercases, and de-duplicates. An entry is either a full address
 * (one @) or a bare domain (no @); anything blank, containing whitespace, or
 * with multiple @s is a bad request, named per entry so the caller can fix
 * the right line.
 */
function normalizeAllowlist(entries: string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") {
      throw new ValidationError("senderAllowlist entries must not be blank");
    }
    if (/\s/.test(entry) || (entry.match(/@/g) ?? []).length > 1) {
      throw new ValidationError(
        `senderAllowlist entry "${entry}" must be a single address or domain`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function normalizeModel(model: string): string {
  const normalized = model.trim();
  if (normalized === "") {
    throw new ValidationError("aiModel must not be blank");
  }
  return normalized;
}
