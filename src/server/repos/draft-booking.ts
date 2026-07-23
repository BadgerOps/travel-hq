import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { newId } from "../ids.js";
import { BOOKING_KINDS } from "../schemas/booking-kinds.js";
import type { BookingKind } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";

/**
 * The full status vocabulary of a draft_booking row. Kept in sync with the
 * CHECK constraint in migrations/0005_draft_booking.sql.
 *
 * - `pending`   — written by the extractor (#6); the review UI's (#7) queue.
 * - `accepted`  — a reviewer accepted it onto a trip; bookingId links the
 *                 booking that was created from it. Terminal.
 * - `dismissed` — a reviewer rejected it. Kept for audit — there is no
 *                 delete on this repo, on purpose. Terminal.
 */
export const DRAFT_BOOKING_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type DraftBookingStatus = (typeof DRAFT_BOOKING_STATUSES)[number];

/** What produced a draft: the calendar attachment or Workers AI. */
export const DRAFT_BOOKING_SOURCES = ["ics", "ai"] as const;
export type DraftBookingSource = (typeof DRAFT_BOOKING_SOURCES)[number];

export type DraftBooking = {
  id: string;
  /** The inbound_email row this draft was extracted from. */
  inboundEmailId: string;
  kind: BookingKind;
  title: string;
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  /**
   * Plaintext here, unlike booking's encrypted envelope: the same value
   * already sits in the raw email text in this database. It is encrypted at
   * accept time, when #7 passes it to BookingRepo.create.
   */
  confirmationNumber: string | null;
  source: DraftBookingSource;
  /**
   * The full validated extraction payload (parsed JSON) — everything the
   * extractor read, including fields with no column of their own (costCents,
   * per-kind details). #7 carries this into the booking it creates.
   */
  extracted: unknown;
  status: DraftBookingStatus;
  /** The booking created from this draft; set by markAccepted, else null. */
  bookingId: string | null;
  createdAt: string;
  /** When the draft left pending (accepted/dismissed); null while pending. */
  resolvedAt: string | null;
};

export type CreateDraftBookingInput = {
  inboundEmailId: string;
  kind: BookingKind;
  title: string;
  location?: string | null;
  startsAt?: string | null;
  startsAtTz?: string | null;
  endsAt?: string | null;
  endsAtTz?: string | null;
  confirmationNumber?: string | null;
  source: DraftBookingSource;
  extracted?: unknown;
};

/**
 * The fields a reviewer may edit before accepting (#7). Same tri-state
 * convention as UpdatePersonInput/UpdateHouseholdSettingsInput: absent
 * leaves the stored value untouched, null clears a nullable field.
 */
export type UpdateDraftBookingInput = {
  kind?: BookingKind;
  title?: string;
  location?: string | null;
  startsAt?: string | null;
  startsAtTz?: string | null;
  endsAt?: string | null;
  endsAtTz?: string | null;
  confirmationNumber?: string | null;
};

type Row = {
  id: string;
  inbound_email_id: string;
  kind: BookingKind;
  title: string;
  location: string | null;
  starts_at: string | null;
  starts_at_tz: string | null;
  ends_at: string | null;
  ends_at_tz: string | null;
  confirmation_number: string | null;
  source: DraftBookingSource;
  extracted_json: string;
  status: DraftBookingStatus;
  booking_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

export class DraftBookingRepo extends TenantRepo {
  /**
   * D1 batch access for createMany's all-or-nothing insert. TenantRepo keeps
   * its own handle private on purpose (nothing outside base.ts should build
   * scoped SQL); this copy is legitimate because this file lives in repos/,
   * the one layer the architecture test allows to prepare statements, and
   * every statement it prepares binds the household id from the context.
   */
  private readonly batchDb: D1Database;

  constructor(db: D1Database, ctx: HouseholdContext) {
    super(db, ctx);
    this.batchDb = db;
  }

  /**
   * The extractor's (#6) way in — same synthetic-context pattern, and the
   * same reasoning, as InboundEmailRepo.forIngest: extraction runs with no
   * authenticated user, scoped to the household the envelope recipient
   * resolved to. Role "adult" so writes pass requireWrite() without granting
   * owner-only powers.
   */
  static forIngest(db: D1Database, householdId: string): DraftBookingRepo {
    const ctx: HouseholdContext = { householdId, userId: "system:email-ingest", role: "adult" };
    return new DraftBookingRepo(db, ctx);
  }

  /**
   * Creates a batch of pending drafts ALL-OR-NOTHING: every input is
   * validated (and its source email existence-checked) before anything is
   * written, and the inserts run in a single D1 batch, which is transactional
   * — a mid-batch failure rolls back the whole set. This is the extractor's
   * no-partial-drafts guarantee at the storage layer; there is deliberately
   * no single create() to route around it.
   */
  async createMany(inputs: CreateDraftBookingInput[]): Promise<DraftBooking[]> {
    // Redundant with base.ts's own requireWrite() on writes — kept as
    // explicit, belt-and-braces intent at the top of every mutating method,
    // matching TripRepo/BookingRepo/InboundEmailRepo.
    this.requireWrite();
    if (inputs.length === 0) return [];

    for (const input of inputs) validateDraftFields(input);

    // Every referenced email must exist in THIS household before any write.
    for (const emailId of new Set(inputs.map((i) => i.inboundEmailId))) {
      const email = await this.get<{ id: string }>(
        "SELECT id FROM inbound_email WHERE {scope} AND id = ?2",
        emailId,
      );
      if (!email) throw new NotFoundError("Inbound email not found in this household");
    }

    const now = new Date().toISOString();
    const ids: string[] = [];
    const statements = inputs.map((input) => {
      const id = newId();
      ids.push(id);
      return this.batchDb
        .prepare(
          `INSERT INTO draft_booking (
             id, household_id, inbound_email_id, kind, title, location,
             starts_at, starts_at_tz, ends_at, ends_at_tz,
             confirmation_number, source, extracted_json, status,
             booking_id, created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
        )
        .bind(
          id,
          this.ctx.householdId,
          input.inboundEmailId,
          input.kind,
          input.title,
          input.location ?? null,
          input.startsAt ?? null,
          input.startsAtTz ?? null,
          input.endsAt ?? null,
          input.endsAtTz ?? null,
          input.confirmationNumber ?? null,
          input.source,
          JSON.stringify(input.extracted ?? {}),
          now,
        );
    });
    await this.batchDb.batch(statements);

    const created: DraftBooking[] = [];
    for (const id of ids) {
      const draft = await this.findById(id);
      if (!draft) throw new Error("Draft booking disappeared immediately after creation");
      created.push(draft);
    }
    return created;
  }

  /** Newest first — the review UI's (#7) reading order, like inbound mail. */
  async list(): Promise<DraftBooking[]> {
    const rows = await this.all<Row>(
      "SELECT * FROM draft_booking WHERE {scope} ORDER BY created_at DESC, id DESC",
    );
    return rows.map(toDraftBooking);
  }

  /** Oldest first — queue order. #7 works listByStatus("pending"). */
  async listByStatus(status: DraftBookingStatus): Promise<DraftBooking[]> {
    if (!DRAFT_BOOKING_STATUSES.includes(status)) {
      throw new ValidationError(`Unknown draft booking status "${String(status)}"`);
    }
    const rows = await this.all<Row>(
      "SELECT * FROM draft_booking WHERE {scope} AND status = ?2 ORDER BY created_at, id",
      status,
    );
    return rows.map(toDraftBooking);
  }

  /** Every draft extracted from one email, in extraction order (#7's audit view). */
  async listByEmail(inboundEmailId: string): Promise<DraftBooking[]> {
    const rows = await this.all<Row>(
      "SELECT * FROM draft_booking WHERE {scope} AND inbound_email_id = ?2 ORDER BY created_at, id",
      inboundEmailId,
    );
    return rows.map(toDraftBooking);
  }

  async findById(id: string): Promise<DraftBooking | undefined> {
    const row = await this.get<Row>("SELECT * FROM draft_booking WHERE {scope} AND id = ?2", id);
    return row ? toDraftBooking(row) : undefined;
  }

  /**
   * Edits a PENDING draft's reviewable fields (#7's edit-before-accept).
   * Accepted/dismissed drafts are immutable audit records. The merged result
   * is validated whole, so an edit can neither blank the title nor leave a
   * timestamp without its zone.
   */
  async update(id: string, input: UpdateDraftBookingInput): Promise<DraftBooking> {
    // See createMany for why this is redundant on purpose.
    this.requireWrite();
    const current = await this.findById(id);
    if (!current) throw new NotFoundError("Draft booking not found in this household");
    if (current.status !== "pending") {
      throw new ValidationError(`Only a pending draft can be edited; this one is ${current.status}`);
    }

    const merged = {
      kind: input.kind === undefined ? current.kind : input.kind,
      title: input.title === undefined ? current.title : input.title,
      location: input.location === undefined ? current.location : input.location,
      startsAt: input.startsAt === undefined ? current.startsAt : input.startsAt,
      startsAtTz: input.startsAtTz === undefined ? current.startsAtTz : input.startsAtTz,
      endsAt: input.endsAt === undefined ? current.endsAt : input.endsAt,
      endsAtTz: input.endsAtTz === undefined ? current.endsAtTz : input.endsAtTz,
      confirmationNumber:
        input.confirmationNumber === undefined ? current.confirmationNumber : input.confirmationNumber,
    };
    validateDraftFields(merged);

    await this.run(
      `UPDATE draft_booking
          SET kind = ?2, title = ?3, location = ?4,
              starts_at = ?5, starts_at_tz = ?6, ends_at = ?7, ends_at_tz = ?8,
              confirmation_number = ?9
        WHERE {scope} AND id = ?10 AND status = 'pending'`,
      merged.kind,
      merged.title,
      merged.location,
      merged.startsAt,
      merged.startsAtTz,
      merged.endsAt,
      merged.endsAtTz,
      merged.confirmationNumber,
      id,
    );
    return { ...current, ...merged };
  }

  /**
   * pending → accepted, recording the booking that was created from this
   * draft. #7 calls BookingRepo.create first, then this with the new id; the
   * booking must exist in this household (scoped existence check).
   */
  async markAccepted(id: string, bookingId: string): Promise<DraftBooking> {
    const booking = await this.get<{ id: string }>(
      "SELECT id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");
    // `return await`, not `return`: transition() can reject synchronously
    // (requireWrite), and returning the bare promise defers its adoption to a
    // later microtask — workerd's rejection tracker flags that window as an
    // unhandled rejection. Same note as InboundEmailRepo.markExtracted.
    return await this.transition(id, "accepted", bookingId);
  }

  /** pending → dismissed. Kept for audit; never deleted. */
  async markDismissed(id: string): Promise<DraftBooking> {
    // See markAccepted for why this is `return await`.
    return await this.transition(id, "dismissed", null);
  }

  /**
   * The only legal transitions are pending → accepted|dismissed. Terminal
   * states never move again — un-dismissing or re-pointing an accepted draft
   * would falsify the audit trail.
   */
  private async transition(
    id: string,
    status: Extract<DraftBookingStatus, "accepted" | "dismissed">,
    bookingId: string | null,
  ): Promise<DraftBooking> {
    this.requireWrite();
    const current = await this.findById(id);
    if (!current) throw new NotFoundError("Draft booking not found in this household");
    if (current.status !== "pending") {
      throw new ValidationError(`Only a pending draft can transition; this one is ${current.status}`);
    }
    const resolvedAt = new Date().toISOString();
    await this.run(
      "UPDATE draft_booking SET status = ?2, booking_id = ?3, resolved_at = ?4 WHERE {scope} AND id = ?5 AND status = 'pending'",
      status,
      bookingId,
      resolvedAt,
      id,
    );
    return { ...current, status, bookingId, resolvedAt };
  }
}

/**
 * The draft-level counterpart of BookingRepo's assertTimezonePaired, plus
 * kind/title/source checks — the repo-level belt-and-braces guarantee that a
 * non-HTTP caller (the extractor IS one) cannot store a draft the review UI
 * chokes on. Extraction already normalizes; this is the backstop.
 */
function validateDraftFields(input: {
  kind: string;
  title: string;
  startsAt?: string | null;
  startsAtTz?: string | null;
  endsAt?: string | null;
  endsAtTz?: string | null;
  source?: string;
}): void {
  if (!BOOKING_KINDS.includes(input.kind as BookingKind)) {
    throw new ValidationError(`kind must be one of ${BOOKING_KINDS.join(", ")}`);
  }
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new ValidationError("A draft booking requires a non-empty title");
  }
  if (input.source !== undefined && !DRAFT_BOOKING_SOURCES.includes(input.source as DraftBookingSource)) {
    throw new ValidationError(`source must be one of ${DRAFT_BOOKING_SOURCES.join(", ")}`);
  }
  assertPair("startsAt", input.startsAt, input.startsAtTz);
  assertPair("endsAt", input.endsAt, input.endsAtTz);
}

function assertPair(name: string, at: string | null | undefined, tz: string | null | undefined): void {
  if (!at) {
    if (tz) throw new ValidationError(`${name}Tz requires ${name}`);
    return;
  }
  if (!tz) throw new ValidationError(`${name} requires ${name}Tz (an IANA timezone)`);
  if (!isValidTimestamp(at)) throw new ValidationError(`${name} must be a parseable timestamp`);
  if (!isValidTimezone(tz)) throw new ValidationError(`${name}Tz must be a valid IANA timezone`);
}

function toDraftBooking(r: Row): DraftBooking {
  return {
    id: r.id,
    inboundEmailId: r.inbound_email_id,
    kind: r.kind,
    title: r.title,
    location: r.location,
    startsAt: r.starts_at,
    startsAtTz: r.starts_at_tz,
    endsAt: r.ends_at,
    endsAtTz: r.ends_at_tz,
    confirmationNumber: r.confirmation_number,
    source: r.source,
    extracted: parseExtracted(r.extracted_json),
    status: r.status,
    bookingId: r.booking_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

function parseExtracted(stored: string): unknown {
  try {
    return JSON.parse(stored);
  } catch {
    // Corrupt stored JSON degrades to an empty payload rather than making
    // every list()/findById() throw — the mapped columns still stand alone.
    return {};
  }
}
