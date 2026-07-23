import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { newId } from "../ids.js";

/**
 * The full status vocabulary of an inbound_email row. Kept in sync with the
 * CHECK constraint in migrations/0004_inbound_email.sql.
 *
 * - `received`  — stored by ingest (#4); the sender passed the allowlist AND
 *                 DMARC/SPF. This is the extraction queue: the extractor (#6)
 *                 reads rows in this state and transitions them to
 *                 `extracted` or `failed`.
 * - `extracted` — extraction produced a draft (#6). Never written by ingest.
 * - `failed`    — an internal error at ingest time (raw kept best-effort, may
 *                 be empty) or at extraction time (#6); `error` says why.
 * - `rejected`  — the recipient matched a household but the sender failed
 *                 verification (not allowlisted and/or failed DMARC/SPF).
 *                 Stored for auditability; never extracted; `error` says why.
 */
export const INBOUND_EMAIL_STATUSES = ["received", "extracted", "failed", "rejected"] as const;
export type InboundEmailStatus = (typeof INBOUND_EMAIL_STATUSES)[number];

/** The statuses ingest may create a row in. `extracted` is a transition only. */
export type CreateInboundEmailStatus = Exclude<InboundEmailStatus, "extracted">;

export type InboundEmail = {
  id: string;
  /** Envelope (SMTP) sender — what the allowlist was checked against. */
  from: string;
  /** Envelope recipient — what resolved the household. */
  to: string;
  subject: string | null;
  messageId: string | null;
  /** Raw RFC 5322 message text; "" when the raw stream could not be read. */
  raw: string;
  status: InboundEmailStatus;
  /** Human-readable outcome for failed/rejected rows; null on received. */
  error: string | null;
  /** When the ingest handler stored the row (ISO 8601). */
  receivedAt: string;
};

export type CreateInboundEmailInput = {
  from: string;
  to: string;
  subject?: string | null;
  messageId?: string | null;
  raw: string;
  /** Defaults to "received". */
  status?: CreateInboundEmailStatus;
  /** Required in spirit for failed/rejected; ignored-as-null when absent. */
  error?: string | null;
};

type Row = {
  id: string;
  from_address: string;
  to_address: string;
  subject: string | null;
  message_id: string | null;
  raw: string;
  status: InboundEmailStatus;
  error: string | null;
  received_at: string;
};

export class InboundEmailRepo extends TenantRepo {
  /**
   * The ingest handler's (and the extractor's — #6) way in. Mail arrives with
   * no authenticated user, so there is no real HouseholdContext to bind; the
   * household is resolved from the envelope recipient by
   * HouseholdSettingsRepo.findHouseholdByForwardAddress, and this factory
   * fabricates the one synthetic context in the codebase — greppable here,
   * never inline at call sites. Role "adult" so writes pass requireWrite()
   * without granting owner-only powers.
   */
  static forIngest(db: D1Database, householdId: string): InboundEmailRepo {
    const ctx: HouseholdContext = { householdId, userId: "system:email-ingest", role: "adult" };
    return new InboundEmailRepo(db, ctx);
  }

  async create(input: CreateInboundEmailInput): Promise<InboundEmail> {
    // Redundant with base.ts's own requireWrite() check inside insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, matching TripRepo/BookingRepo/HouseholdSettingsRepo.
    this.requireWrite();
    // Widened on purpose (TS narrows a const by its initializer even under a
    // wider annotation): the compile-time type already excludes "extracted",
    // but a JS caller (or a bad cast) can still pass it, so the runtime guard
    // below must be able to see it.
    const status = (input.status ?? "received") as InboundEmailStatus;
    if (!INBOUND_EMAIL_STATUSES.includes(status) || status === "extracted") {
      // "extracted" is reachable only via markExtracted() on a received row;
      // a row can never be born extracted.
      throw new ValidationError("An inbound email may only be created as received, failed, or rejected");
    }
    const id = newId();
    await this.insert("inbound_email", {
      id,
      from_address: input.from,
      to_address: input.to,
      subject: input.subject ?? null,
      message_id: input.messageId ?? null,
      raw: input.raw,
      status,
      error: input.error ?? null,
      received_at: new Date().toISOString(),
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Inbound email disappeared immediately after creation");
    return created;
  }

  /** Newest first — the review UI's (#7) reading order. */
  async list(): Promise<InboundEmail[]> {
    const rows = await this.all<Row>(
      "SELECT * FROM inbound_email WHERE {scope} ORDER BY received_at DESC, id DESC",
    );
    return rows.map(toInboundEmail);
  }

  /**
   * Oldest first — queue order. The extractor (#6) calls
   * listByStatus("received") and works the backlog front to back.
   */
  async listByStatus(status: InboundEmailStatus): Promise<InboundEmail[]> {
    if (!INBOUND_EMAIL_STATUSES.includes(status)) {
      throw new ValidationError(`Unknown inbound email status "${String(status)}"`);
    }
    const rows = await this.all<Row>(
      "SELECT * FROM inbound_email WHERE {scope} AND status = ?2 ORDER BY received_at, id",
      status,
    );
    return rows.map(toInboundEmail);
  }

  async findById(id: string): Promise<InboundEmail | undefined> {
    const row = await this.get<Row>("SELECT * FROM inbound_email WHERE {scope} AND id = ?2", id);
    return row ? toInboundEmail(row) : undefined;
  }

  /** received → extracted. The extractor (#6) calls this on success. */
  async markExtracted(id: string): Promise<InboundEmail> {
    // `return await`, not `return`: transition() can reject synchronously
    // (requireWrite), and returning the bare promise defers its adoption to a
    // later microtask — workerd's rejection tracker flags that window as an
    // unhandled rejection. await attaches the handler in the same turn.
    return await this.transition(id, "extracted", null);
  }

  /** received → failed, with a human-readable reason (#8 surfaces it). */
  async markFailed(id: string, error: string): Promise<InboundEmail> {
    if (typeof error !== "string" || error.trim() === "") {
      throw new ValidationError("markFailed requires a non-empty, human-readable error");
    }
    // See markExtracted for why this is `return await`.
    return await this.transition(id, "failed", error);
  }

  /**
   * The only legal transitions are received → extracted|failed. Terminal
   * states (extracted, failed, rejected) never move again — a re-run of the
   * extractor over an already-processed row is a bug, not a retry.
   */
  private async transition(
    id: string,
    status: Extract<InboundEmailStatus, "extracted" | "failed">,
    error: string | null,
  ): Promise<InboundEmail> {
    this.requireWrite();
    const current = await this.findById(id);
    if (!current) throw new NotFoundError("Inbound email not found in this household");
    if (current.status !== "received") {
      throw new ValidationError(`Only a received inbound email can transition; this one is ${current.status}`);
    }
    await this.run(
      "UPDATE inbound_email SET status = ?2, error = ?3 WHERE {scope} AND id = ?4 AND status = 'received'",
      status,
      error,
      id,
    );
    return { ...current, status, error };
  }
}

function toInboundEmail(r: Row): InboundEmail {
  return {
    id: r.id,
    from: r.from_address,
    to: r.to_address,
    subject: r.subject,
    messageId: r.message_id,
    raw: r.raw,
    status: r.status,
    error: r.error,
    receivedAt: r.received_at,
  };
}
