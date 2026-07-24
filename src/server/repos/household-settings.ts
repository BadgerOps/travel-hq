import { TenantRepo, ForbiddenError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { assertNotMasked } from "../crypto/envelope.js";
import type { Keyring } from "../crypto/envelope.js";
import {
  DEFAULT_WORKERS_AI_MAX_TOKENS,
  DEFAULT_WORKERS_AI_MODEL,
  MAX_WORKERS_AI_MAX_TOKENS,
  MIN_WORKERS_AI_MAX_TOKENS,
  isSupportedWorkersAiModel,
} from "../../shared/workers-ai-models.js";

/** Backwards-compatible server export of the shared extractor default. */
export const DEFAULT_AI_MODEL = DEFAULT_WORKERS_AI_MODEL;
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const AI_PROVIDERS = ["workers-ai", "anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const MAX_EXTRACTION_INSTRUCTIONS_CHARS = 2_000;

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
  /** Maximum output tokens available to Workers AI, including reasoning. */
  aiMaxTokens: number;
  aiProvider: AiProvider;
  anthropicModel: string;
  /** The only credential state exposed outside the repository. */
  anthropicKeyConfigured: boolean;
  extractionInstructions: string;
};

export type IngestHouseholdSettings = HouseholdSettings & {
  /** Encrypted envelope for runtime use only; never serialize this type. */
  anthropicApiKeyCiphertext: string | null;
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
  aiMaxTokens?: number;
  aiProvider?: AiProvider;
  anthropicModel?: string;
  /** absent = keep, null = clear, string = encrypt and replace */
  anthropicApiKey?: string | null;
  extractionInstructions?: string;
};

/**
 * What `findHouseholdByForwardAddress` resolves for the ingest handler (#4):
 * the household the inbound To: address belongs to, plus that household's
 * settings, in one lookup — so ingest never needs to fabricate a
 * HouseholdContext just to read the allowlist and model.
 */
export type ForwardAddressMatch = {
  householdId: string;
  settings: IngestHouseholdSettings;
};

/** The defaults a household with no settings row behaves as. */
export function defaultHouseholdSettings(): HouseholdSettings {
  return {
    forwardAddress: null,
    senderAllowlist: [],
    aiModel: DEFAULT_AI_MODEL,
    aiMaxTokens: DEFAULT_WORKERS_AI_MAX_TOKENS,
    aiProvider: "workers-ai",
    anthropicModel: DEFAULT_ANTHROPIC_MODEL,
    anthropicKeyConfigured: false,
    extractionInstructions: "",
  };
}

type Row = {
  forward_address: string | null;
  sender_allowlist: string;
  ai_model: string;
  ai_max_tokens: number;
  ai_provider: string;
  anthropic_model: string;
  anthropic_api_key: string | null;
  extraction_instructions: string;
};

export class HouseholdSettingsRepo extends TenantRepo {
  constructor(
    db: D1Database,
    ctx: HouseholdContext,
    private readonly ring?: Keyring,
  ) {
    super(db, ctx);
  }

  /**
   * The household's settings, or the defaults when no row exists yet.
   * Owner/adult only — see requireOwnerOrAdult below.
   */
  async getSettings(): Promise<HouseholdSettings> {
    this.requireOwnerOrAdult();
    const row = await this.getRow();
    return row ? toSettings(row) : defaultHouseholdSettings();
  }

  /** Internal provider configuration, including only encrypted credential data. */
  async getIngestSettings(): Promise<IngestHouseholdSettings> {
    this.requireOwnerOrAdult();
    const row = await this.getRow();
    return row
      ? toIngestSettings(row)
      : { ...defaultHouseholdSettings(), anthropicApiKeyCiphertext: null };
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
      input.aiModel === undefined
        ? normalizeStoredWorkersAiModel(current?.ai_model)
        : normalizeWorkersAiModel(input.aiModel);
    const aiMaxTokens =
      input.aiMaxTokens === undefined
        ? normalizeStoredWorkersAiMaxTokens(current?.ai_max_tokens)
        : normalizeWorkersAiMaxTokens(input.aiMaxTokens);
    const aiProvider =
      input.aiProvider === undefined
        ? normalizeStoredProvider(current?.ai_provider)
        : normalizeProvider(input.aiProvider);
    const anthropicModel =
      input.anthropicModel === undefined
        ? normalizeModel(current?.anthropic_model ?? DEFAULT_ANTHROPIC_MODEL, "anthropicModel")
        : normalizeModel(input.anthropicModel, "anthropicModel");
    const extractionInstructions =
      input.extractionInstructions === undefined
        ? (current?.extraction_instructions ?? "")
        : normalizeInstructions(input.extractionInstructions);

    let anthropicApiKey = current?.anthropic_api_key ?? null;
    if (input.anthropicApiKey !== undefined) {
      if (input.anthropicApiKey === null) {
        anthropicApiKey = null;
      } else {
        rejectMasked("anthropicApiKey", input.anthropicApiKey);
        const plaintext = input.anthropicApiKey.trim();
        if (plaintext === "") {
          throw new ValidationError("anthropicApiKey must not be blank");
        }
        if (!this.ring) {
          throw new Error("HouseholdSettingsRepo requires a Keyring to store an Anthropic API key");
        }
        anthropicApiKey = await this.ring.encrypt(plaintext);
      }
    }
    if (aiProvider === "anthropic" && anthropicApiKey === null) {
      throw new ValidationError("An Anthropic API key is required when Anthropic is selected");
    }

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
            SET forward_address = ?2, sender_allowlist = ?3, ai_model = ?4,
                ai_max_tokens = ?5, ai_provider = ?6, anthropic_model = ?7,
                anthropic_api_key = ?8, extraction_instructions = ?9, updated_at = ?10
          WHERE {scope}`,
        forwardAddress,
        senderAllowlist,
        aiModel,
        aiMaxTokens,
        aiProvider,
        anthropicModel,
        anthropicApiKey,
        extractionInstructions,
        now,
      );
    } else {
      await this.insert("household_settings", {
        forward_address: forwardAddress,
        sender_allowlist: senderAllowlist,
        ai_model: aiModel,
        ai_max_tokens: aiMaxTokens,
        ai_provider: aiProvider,
        anthropic_model: anthropicModel,
        anthropic_api_key: anthropicApiKey,
        extraction_instructions: extractionInstructions,
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
        `SELECT household_id, forward_address, sender_allowlist, ai_model, ai_max_tokens
                , ai_provider, anthropic_model, anthropic_api_key, extraction_instructions
           FROM household_settings
          WHERE forward_address = ?`,
      )
      .bind(address)
      .first<Row & { household_id: string }>();
    if (!row) return undefined;
    return { householdId: row.household_id, settings: toIngestSettings(row) };
  }

  private async getRow(): Promise<Row | undefined> {
    return this.get<Row>(
      `SELECT forward_address, sender_allowlist, ai_model, ai_max_tokens, ai_provider,
              anthropic_model, anthropic_api_key, extraction_instructions
         FROM household_settings WHERE {scope}`,
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
    aiModel: normalizeStoredWorkersAiModel(r.ai_model),
    aiMaxTokens: normalizeStoredWorkersAiMaxTokens(r.ai_max_tokens),
    aiProvider: normalizeStoredProvider(r.ai_provider),
    anthropicModel: normalizeStoredModel(r.anthropic_model, DEFAULT_ANTHROPIC_MODEL),
    anthropicKeyConfigured: r.anthropic_api_key !== null,
    extractionInstructions:
      r.extraction_instructions.length <= MAX_EXTRACTION_INSTRUCTIONS_CHARS
        ? r.extraction_instructions
        : "",
  };
}

function toIngestSettings(r: Row): IngestHouseholdSettings {
  return {
    ...toSettings(r),
    anthropicApiKeyCiphertext: r.anthropic_api_key,
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

function normalizeModel(model: string, field = "aiModel"): string {
  const normalized = model.trim();
  if (normalized === "") {
    throw new ValidationError(`${field} must not be blank`);
  }
  return normalized;
}

function normalizeWorkersAiModel(model: string): string {
  const normalized = normalizeModel(model);
  if (!isSupportedWorkersAiModel(normalized)) {
    throw new ValidationError("aiModel must be a supported Workers AI extraction model");
  }
  return normalized;
}

function normalizeStoredWorkersAiModel(model: string | undefined): string {
  const normalized = model?.trim() ?? "";
  return isSupportedWorkersAiModel(normalized) ? normalized : DEFAULT_AI_MODEL;
}

function normalizeWorkersAiMaxTokens(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_WORKERS_AI_MAX_TOKENS ||
    value > MAX_WORKERS_AI_MAX_TOKENS
  ) {
    throw new ValidationError(
      `aiMaxTokens must be an integer from ${MIN_WORKERS_AI_MAX_TOKENS} to ${MAX_WORKERS_AI_MAX_TOKENS}`,
    );
  }
  return value;
}

function normalizeStoredWorkersAiMaxTokens(value: number | undefined): number {
  return value === undefined ||
    !Number.isInteger(value) ||
    value < MIN_WORKERS_AI_MAX_TOKENS ||
    value > MAX_WORKERS_AI_MAX_TOKENS
    ? DEFAULT_WORKERS_AI_MAX_TOKENS
    : value;
}

function normalizeStoredModel(model: string, fallback: string): string {
  const normalized = model.trim();
  return normalized === "" ? fallback : normalized;
}

function normalizeProvider(provider: string): AiProvider {
  if ((AI_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as AiProvider;
  }
  throw new ValidationError(`aiProvider must be one of ${AI_PROVIDERS.join(", ")}`);
}

function normalizeStoredProvider(provider: string | undefined): AiProvider {
  if (provider && (AI_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as AiProvider;
  }
  return "workers-ai";
}

function normalizeInstructions(instructions: string): string {
  if (instructions.length > MAX_EXTRACTION_INSTRUCTIONS_CHARS) {
    throw new ValidationError(
      `extractionInstructions must be at most ${MAX_EXTRACTION_INSTRUCTIONS_CHARS} characters`,
    );
  }
  return instructions;
}

function rejectMasked(field: string, value: string): void {
  try {
    assertNotMasked(field, value);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : String(err));
  }
}
