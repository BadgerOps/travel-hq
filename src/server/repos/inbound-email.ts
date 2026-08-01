import { TenantRepo, ForbiddenError, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import type { Keyring } from "../crypto/envelope.js";
import { newId } from "../ids.js";
import { rawRetentionCutoffs, rawRetentionExpiresAt } from "../../shared/email-retention.js";

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

/**
 * How `inbound_email.raw` is physically stored. Read from the row's own
 * `raw_encryption` column rather than sniffed from the value, because the two
 * are not reliably distinguishable and guessing wrong in either direction is
 * a data-loss bug: a legacy plaintext message mistaken for an envelope fails
 * to decrypt and vanishes from the UI.
 */
export type RawEncryption = "plaintext" | "envelope";

/**
 * Why a row's `raw` reads the way it does. Every state except `retained`
 * means `raw` is the empty string, and they are kept apart because the
 * product says different things about each:
 *
 * - `retained`     — the message is stored and was decoded successfully.
 * - `never-stored` — ingest deliberately stored no message: a rejected
 *                    sender (retaining up to a megabyte of attacker-supplied
 *                    text would be a free way to fill D1), or a failure that
 *                    happened before the stream could be read.
 * - `purged`       — the message WAS stored and the retention sweep redacted
 *                    it. `rawPurgedAt` says when.
 * - `unreadable`   — the message is stored as an envelope this key ring
 *                    cannot open (no ring configured, or the key it was
 *                    sealed with has been rotated out). The row is still
 *                    returned: silently dropping rows whose ciphertext will
 *                    not open is exactly the failure mode that makes a UI
 *                    look like it lost the user's data.
 */
export type RawRetentionState = "retained" | "never-stored" | "purged" | "unreadable";

export type InboundEmail = {
  id: string;
  /** Envelope (SMTP) sender — what the allowlist was checked against. */
  from: string;
  /** Envelope recipient — what resolved the household. */
  to: string;
  subject: string | null;
  messageId: string | null;
  /**
   * Raw RFC 5322 message text, already decrypted. "" whenever `rawState` is
   * anything other than "retained" — read that field, not this one's
   * emptiness, to tell "never stored" from "kept and then purged".
   */
  raw: string;
  status: InboundEmailStatus;
  /** Human-readable outcome for failed/rejected rows; null on received. */
  error: string | null;
  /** When the ingest handler stored the row (ISO 8601). */
  receivedAt: string;
  /** Why `raw` reads the way it does; see RawRetentionState. */
  rawState: RawRetentionState;
  /** When the retention sweep redacted `raw` (ISO 8601); null if it never did. */
  rawPurgedAt: string | null;
  /**
   * When `raw` becomes eligible for the sweep (ISO 8601) — what the detail
   * view shows as "kept until". Null once there is nothing left to expire, so
   * a purged row does not advertise a future deletion date for a message that
   * is already gone.
   */
  rawExpiresAt: string | null;
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

export type InboundEmailMetadata = Pick<
  InboundEmail,
  "id" | "from" | "to" | "subject" | "status" | "error" | "receivedAt"
>;

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
  raw_encryption: RawEncryption;
  raw_purged_at: string | null;
};

export class InboundEmailRepo extends TenantRepo {
  /**
   * The key ring that seals `raw` at rest, when the caller has one.
   *
   * Optional rather than required, and deliberately so. Making it mandatory
   * would force it through ImportReviewRepo and the extractor, neither of
   * which ever reads or writes raw, and would break every call site that only
   * moves a status. A repo built without a ring writes plaintext — which is
   * precisely the shape every pre-0015 row already has, and which reads back
   * correctly — while every path that actually stores a message (the email
   * ingest handler, the file import route) passes one. `raw_encryption`
   * records which of the two happened per row, so the two can coexist
   * forever without a backfill.
   */
  private readonly ring: Keyring | undefined;

  constructor(db: D1Database, ctx: HouseholdContext, ring?: Keyring) {
    super(db, ctx);
    this.ring = ring;
  }

  /**
   * The ingest handler's (and the extractor's — #6) way in. Mail arrives with
   * no authenticated user, so there is no real HouseholdContext to bind; the
   * household is resolved from the envelope recipient by
   * HouseholdSettingsRepo.findHouseholdByForwardAddress, and this factory
   * fabricates the one synthetic context in the codebase — greppable here,
   * never inline at call sites. Role "adult" so writes pass requireWrite()
   * without granting owner-only powers.
   */
  static forIngest(db: D1Database, householdId: string, ring?: Keyring): InboundEmailRepo {
    const ctx: HouseholdContext = { householdId, userId: "system:email-ingest", role: "adult" };
    return new InboundEmailRepo(db, ctx, ring);
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
    // Seal the message before it is bound, not after it is stored: there is
    // no window in which the plaintext exists in D1. An empty raw (a rejected
    // sender, or an ingest failure that never read the stream) is left as ""
    // rather than encrypted to a nonempty envelope, so "" keeps meaning
    // "nothing here" for the retention sweep and the UI alike.
    const sealed = input.raw === "" || !this.ring
      ? { raw: input.raw, raw_encryption: "plaintext" as RawEncryption }
      : { raw: await this.ring.encrypt(input.raw), raw_encryption: "envelope" as RawEncryption };
    await this.insert("inbound_email", {
      id,
      from_address: input.from,
      to_address: input.to,
      subject: input.subject ?? null,
      message_id: input.messageId ?? null,
      ...sealed,
      status,
      error: input.error ?? null,
      received_at: new Date().toISOString(),
      raw_purged_at: null,
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
    return this.toInboundEmails(rows);
  }

  /**
   * Owner/adult activity feed. Deliberately selects no raw or Message-ID
   * columns; the opaque row id is included as the handle for the detail
   * endpoint (GET /api/inbound-emails/:id).
   */
  async listMetadata(): Promise<InboundEmailMetadata[]> {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not access inbound email activity");
    }
    const rows = await this.all<
      Pick<Row, "id" | "from_address" | "to_address" | "subject" | "status" | "error" | "received_at">
    >(
      `SELECT id, from_address, to_address, subject, status, error, received_at
         FROM inbound_email WHERE {scope} ORDER BY received_at DESC, id DESC`,
    );
    return rows.map((row) => ({
      id: row.id,
      from: row.from_address,
      to: row.to_address,
      subject: row.subject,
      status: row.status,
      error: row.error,
      receivedAt: row.received_at,
    }));
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
    return this.toInboundEmails(rows);
  }

  async findById(id: string): Promise<InboundEmail | undefined> {
    const row = await this.get<Row>("SELECT * FROM inbound_email WHERE {scope} AND id = ?2", id);
    return row ? await this.toInboundEmail(row) : undefined;
  }

  async findByMessageId(messageId: string): Promise<InboundEmail | undefined> {
    const row = await this.get<Row>(
      "SELECT * FROM inbound_email WHERE {scope} AND message_id = ?2",
      messageId,
    );
    return row ? await this.toInboundEmail(row) : undefined;
  }

  /**
   * Redact `raw` on every row in this household whose retention window has
   * elapsed, and return the ids it redacted.
   *
   * This is the whole purge mechanism. There is no cron trigger configured
   * for this Worker, so it runs opportunistically on the paths that already
   * touch inbound mail — the email ingest handler, the file import, and the
   * import review accept/dismiss/create-trip endpoints. Every one of those is
   * already a write, already scoped to one household, and already the moment
   * at which the household in question is demonstrably active, which is
   * exactly when its old mail should be aging out. A household that stops
   * using the product also stops accumulating mail, so no sweep is owed.
   *
   * Redaction, not deletion: the row survives with its envelope metadata,
   * status, error and the drafts it produced, because the activity feed and
   * every booking's provenance link point at it. Only the message text goes.
   *
   * Idempotent and cheap to call on a hot path: the WHERE clause matches
   * nothing once a row has been swept, and the SELECT that precedes the
   * UPDATE exists only so the caller can log what went.
   */
  async purgeExpiredRaw(now: Date = new Date()): Promise<string[]> {
    this.requireWrite();
    const cutoffs = rawRetentionCutoffs(now);
    // CASE rather than OR: base.ts refuses a query with an OR at or above the
    // {scope} token's nesting depth, because that is the shape that can
    // neutralize the tenancy predicate. A CASE expression picks the same two
    // cutoffs apart without introducing one.
    const expired = await this.all<{ id: string }>(
      `SELECT id FROM inbound_email
        WHERE {scope}
          AND raw <> ''
          AND raw_purged_at IS NULL
          AND received_at <= (CASE WHEN status = 'extracted' THEN ?2 ELSE ?3 END)`,
      cutoffs.extracted,
      cutoffs.unresolved,
    );
    if (expired.length === 0) return [];
    await this.run(
      `UPDATE inbound_email
          SET raw = '', raw_encryption = 'plaintext', raw_purged_at = ?2
        WHERE {scope}
          AND raw <> ''
          AND raw_purged_at IS NULL
          AND received_at <= (CASE WHEN status = 'extracted' THEN ?3 ELSE ?4 END)`,
      now.toISOString(),
      cutoffs.extracted,
      cutoffs.unresolved,
    );
    return expired.map((row) => row.id);
  }

  /**
   * The same sweep across every household at once — the seam a future
   * `scheduled()` handler calls, so that adding the cron is a wrangler.toml
   * change plus three lines in the entrypoint rather than a redesign.
   * Returns the number of rows redacted.
   *
   * Deliberately unscoped, and static for that reason: a cron has no
   * household context to bind, and inventing a synthetic one per household
   * would mean first listing every household — a cross-tenant read by another
   * name. It is safe precisely because it can only ever blank a column;
   * there is no tenant whose data it could disclose to another, and no input
   * the caller can shape (`now` aside) to widen it. It uses `db.prepare`
   * directly, which the architecture test permits under repos/ — the tenancy
   * layer is allowed to be the place that knows how to bypass itself.
   */
  static async purgeExpiredRawEverywhere(db: D1Database, now: Date = new Date()): Promise<number> {
    const cutoffs = rawRetentionCutoffs(now);
    const result = await db
      .prepare(
        `UPDATE inbound_email
            SET raw = '', raw_encryption = 'plaintext', raw_purged_at = ?
          WHERE raw <> ''
            AND raw_purged_at IS NULL
            AND received_at <= (CASE WHEN status = 'extracted' THEN ? ELSE ? END)`,
      )
      .bind(now.toISOString(), cutoffs.extracted, cutoffs.unresolved)
      .run();
    return result.meta.changes ?? 0;
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
   *
   * Compare-and-set, not read-then-write. The `AND status = 'received'`
   * predicate has always been the real guard; what was missing was reading
   * its verdict. The queue is drained by workers that can overlap (a retry, a
   * second cron tick), so two of them can both pass the pre-check below and
   * both issue the UPDATE — and the loser's UPDATE matches zero rows. Asking
   * for exactly one changed row is what turns that into an error instead of a
   * caller being told its own requested state was persisted when another
   * worker's was. The row is then re-read rather than synthesized, so the
   * return value is what the database holds, not what we hoped it would hold.
   */
  private async transition(
    id: string,
    status: Extract<InboundEmailStatus, "extracted" | "failed">,
    error: string | null,
  ): Promise<InboundEmail> {
    this.requireWrite();
    const current = await this.findById(id);
    if (!current) throw new NotFoundError("Inbound email not found in this household");
    // Kept ahead of the UPDATE purely for the error message: the common case
    // is a plain re-run over a processed row, and naming the state it is
    // already in is more useful than reporting a race that did not happen.
    if (current.status !== "received") {
      throw new ValidationError(`Only a received inbound email can transition; this one is ${current.status}`);
    }
    const changed = await this.runChanges(
      "UPDATE inbound_email SET status = ?2, error = ?3 WHERE {scope} AND id = ?4 AND status = 'received'",
      status,
      error,
      id,
    );
    if (changed !== 1) {
      // Zero: another worker transitioned it in the window above. More than
      // one is impossible against a primary key and would mean the predicate
      // no longer identifies a single row — refuse either way rather than
      // report a transition this call did not make.
      const persisted = await this.findById(id);
      throw new ValidationError(
        `Inbound email ${id} was transitioned concurrently; it is now ` +
          `${persisted?.status ?? "gone"} and this ${status} transition did not apply`,
      );
    }
    const updated = await this.findById(id);
    if (!updated) throw new Error("Inbound email disappeared immediately after transition");
    return updated;
  }

  /**
   * Sequential rather than Promise.all: each row is an independent AES-GCM
   * decrypt, and a household's activity feed is tens of rows, not thousands.
   * Fanning them out would import the key once per row concurrently for no
   * measurable gain.
   */
  private async toInboundEmails(rows: Row[]): Promise<InboundEmail[]> {
    const emails: InboundEmail[] = [];
    for (const row of rows) emails.push(await this.toInboundEmail(row));
    return emails;
  }

  private async toInboundEmail(r: Row): Promise<InboundEmail> {
    const opened = await this.openRaw(r);
    return {
      id: r.id,
      from: r.from_address,
      to: r.to_address,
      subject: r.subject,
      messageId: r.message_id,
      raw: opened.raw,
      status: r.status,
      error: r.error,
      receivedAt: r.received_at,
      rawState: opened.state,
      rawPurgedAt: r.raw_purged_at,
      // Only a message that is still there has an expiry worth quoting.
      rawExpiresAt:
        opened.state === "retained" ? rawRetentionExpiresAt(r.status, r.received_at) : null,
    };
  }

  /**
   * Turn the stored column back into readable text, and say why when it
   * cannot. Never throws and never drops the row: the caller asked for an
   * email, and an email whose body cannot be recovered is still an email with
   * a sender, a subject, a status and drafts hanging off it. (The precedent
   * to avoid is a confirmation number that fails to decrypt taking its whole
   * booking out of the list, which reads to the user as lost data.)
   */
  private async openRaw(r: Row): Promise<{ raw: string; state: RawRetentionState }> {
    if (r.raw === "") {
      return { raw: "", state: r.raw_purged_at === null ? "never-stored" : "purged" };
    }
    if (r.raw_encryption !== "envelope") {
      // Legacy, and the default for every row written before migration 0015:
      // the column holds the RFC 5322 message itself. Trusting the column
      // rather than the value's shape is what keeps these readable — a real
      // message can be any bytes at all, including bytes that resemble an
      // envelope.
      return { raw: r.raw, state: "retained" };
    }
    if (!this.ring) {
      console.warn(`[inbound-email] no key ring available to open sealed raw for ${r.id}`);
      return { raw: "", state: "unreadable" };
    }
    try {
      return { raw: await this.ring.decrypt(r.raw), state: "retained" };
    } catch (err) {
      // A key rotated out of the ring, or a corrupted column. Log it — this
      // is an operator problem, not a user one — and let the row through.
      console.error(`[inbound-email] could not open sealed raw for ${r.id}`, err);
      return { raw: "", state: "unreadable" };
    }
  }
}

/**
 * One sentence explaining why a message body is not available, written for
 * the person who forwarded the mail rather than for the operator. Lives here,
 * beside the states it switches on, so the API route and the re-extraction
 * endpoint cannot describe the same row two different ways.
 */
export function rawUnavailableReason(email: InboundEmail): string | null {
  switch (email.rawState) {
    case "retained":
      return null;
    case "purged":
      return "The forwarded message is no longer retained — its retention window has passed, so only the extracted bookings and this summary remain.";
    case "never-stored":
      return "No copy of the forwarded message was stored for this email.";
    case "unreadable":
      return "The stored copy of this message could not be decrypted with the household's current encryption key.";
  }
}
