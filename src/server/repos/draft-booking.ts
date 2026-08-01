import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { assertNotMasked } from "../crypto/envelope.js";
import { newId } from "../ids.js";
import { BOOKING_KINDS, importedDetails, parseDetails } from "../schemas/booking-kinds.js";
import type { BookingKind } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";
import { assertBookingTiming, assertNonNegativeAmount } from "./validation.js";

export const DRAFT_BOOKING_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type DraftBookingStatus = (typeof DRAFT_BOOKING_STATUSES)[number];
export const DRAFT_BOOKING_SOURCES = ["ics", "ai"] as const;
export type DraftBookingSource = (typeof DRAFT_BOOKING_SOURCES)[number];

export type DraftBooking = {
  id: string;
  inboundEmailId: string;
  ordinal: number;
  kind: BookingKind;
  title: string;
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  confirmationNumber: string | null;
  source: DraftBookingSource;
  extracted: unknown;
  status: DraftBookingStatus;
  bookingId: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type CreateDraftBookingInput = {
  inboundEmailId: string;
  ordinal: number;
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
 * What a reviewer may correct on a PENDING draft, before it becomes a booking.
 *
 * WHY THE DRAFT AND NOT THE ACCEPT. The obvious alternative was to let
 * `POST /api/imports/accept` carry per-draft overrides. It was rejected:
 * `ImportReviewRepo` commits an accept as ONE D1 batch whose booking title is
 * a scalar sub-select against `draft_booking` (that sub-select is the race
 * guard — see the comment above the INSERT in `commitDraftsToTrip`), so an
 * override would have to either bypass that guard or be threaded through every
 * statement in the batch. Editing the row instead keeps the batch exactly as
 * it is, survives a reviewer who corrects a draft on Tuesday and accepts it on
 * Friday, makes the correction visible to the duplicate detector and to the
 * next person who reads the queue, and needs no new atomicity story.
 *
 * Tri-state, as `UpdateBookingInput` and `UpdateTripInput` established:
 *
 *   absent / undefined -> leave the stored value exactly as it is
 *   null               -> clear the stored value
 *   value              -> store this new value
 *
 * `kind` and `title` are non-nullable: a draft that lost its title could not
 * be committed at all (`booking.title` is NOT NULL, and the sub-select above
 * would insert the NULL rather than fail loudly).
 *
 * `costCents` and `details` have no columns of their own — they live inside
 * `extracted_json`, which is where `commitDraftsToTrip` reads them from. They
 * are patched INTO that object rather than replacing it, so the traveler names
 * and emails beside them (which the accept matches people against) survive an
 * edit untouched. The scalar copies of title/kind/times that also sit in that
 * JSON are deliberately NOT rewritten: every consumer — the queue, the email
 * detail dialog, the accept — reads those from the mapped columns, and leaving
 * the extractor's own words in place keeps the JSON honest as the record of
 * what extraction actually said.
 *
 * `details` is NOT tri-state either — it is the whole per-kind record,
 * replaced wholesale when supplied, for the same reason as a booking's: a deep
 * merge makes it impossible to remove a key the extractor got wrong, which is
 * most of the point of being able to edit at all.
 */
export type UpdateDraftBookingInput = {
  kind?: BookingKind;
  title?: string;
  location?: string | null;
  startsAt?: string | null;
  startsAtTz?: string | null;
  endsAt?: string | null;
  endsAtTz?: string | null;
  /**
   * PLAINTEXT, and stored as plaintext: `draft_booking` has no envelope
   * column, and the accept is what encrypts (see `commitDraftsToTrip`'s
   * `encryptedConfirmation`). Encrypting here would double-encrypt at accept
   * time and hand the trip page ciphertext of ciphertext.
   */
  confirmationNumber?: string | null;
  costCents?: number | null;
  details?: unknown;
};

/**
 * Input key -> column for the SET clause. Column names come from this fixed
 * map and never from caller-supplied keys, so no request body can reach run()
 * with an identifier of its own choosing — the BookingRepo.update pattern.
 */
const UPDATE_COLUMNS = {
  kind: "kind",
  title: "title",
  location: "location",
  startsAt: "starts_at",
  startsAtTz: "starts_at_tz",
  endsAt: "ends_at",
  endsAtTz: "ends_at_tz",
  confirmationNumber: "confirmation_number",
} as const;

type Row = {
  id: string;
  inbound_email_id: string;
  ordinal: number;
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
  private readonly batchDb: D1Database;

  constructor(db: D1Database, ctx: HouseholdContext) {
    super(db, ctx);
    this.batchDb = db;
  }

  static forIngest(db: D1Database, householdId: string): DraftBookingRepo {
    return new DraftBookingRepo(db, {
      householdId,
      userId: "system:email-ingest",
      role: "adult",
    });
  }

  /** Validates the complete set, then inserts it in one transactional batch. */
  async createMany(inputs: CreateDraftBookingInput[]): Promise<DraftBooking[]> {
    this.requireWrite();
    if (inputs.length === 0) return [];
    for (const input of inputs) validateDraft(input);

    for (const emailId of new Set(inputs.map((input) => input.inboundEmailId))) {
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
             id, household_id, inbound_email_id, ordinal, kind, title, location,
             starts_at, starts_at_tz, ends_at, ends_at_tz,
             confirmation_number, source, extracted_json, status,
             booking_id, created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
        )
        .bind(
          id,
          this.ctx.householdId,
          input.inboundEmailId,
          input.ordinal,
          input.kind,
          input.title.trim(),
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
    return this.listByEmail(inputs[0]!.inboundEmailId);
  }

  async listByEmail(inboundEmailId: string): Promise<DraftBooking[]> {
    const rows = await this.all<Row>(
      "SELECT * FROM draft_booking WHERE {scope} AND inbound_email_id = ?2 ORDER BY ordinal",
      inboundEmailId,
    );
    return rows.map(toDraftBooking);
  }

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

  async findById(id: string): Promise<DraftBooking | undefined> {
    const row = await this.get<Row>("SELECT * FROM draft_booking WHERE {scope} AND id = ?2", id);
    return row ? toDraftBooking(row) : undefined;
  }

  /**
   * Correct a pending draft in place — the write behind "edit before you
   * accept".
   *
   * Extraction is a suggestion, not truth: a model reads "1:30" off a tour
   * confirmation and puts it in the wrong zone, or types the room number into
   * the confirmation field. Until this existed the only repair was to accept
   * the draft and then edit the resulting booking, which meant the wrong value
   * briefly WAS the household's data — it reached the day view, the rollups,
   * and anyone else's screen.
   *
   * PENDING ONLY, and that is enforced twice: once against the row this method
   * read, and once in the UPDATE's own `status = 'pending'` predicate, whose
   * changed-row count is checked. The second is not redundant — between the
   * read and the write another reviewer can accept the same draft, and an edit
   * that silently landed on an accepted draft would change a row nothing reads
   * while telling this reviewer their correction was saved.
   *
   * Every value is held to what `BookingRepo.create` would accept (shared
   * assertions in ./validation.js, shared per-kind schemas in
   * ../schemas/booking-kinds.js). An edit that wrote a value the accept would
   * have to drop — an instant with no zone, an end before its start, a
   * negative cost — would be worse than no edit at all: it looks saved, and
   * then quietly disappears at commit.
   */
  async update(id: string, patch: UpdateDraftBookingInput): Promise<DraftBooking> {
    // Redundant with base.ts's own requireWrite() inside run() — kept as
    // explicit intent at the top of every mutating method.
    this.requireWrite();

    const current = await this.findById(id);
    // The same two failures, in the same two classes, as
    // ImportReviewRepo.pendingDrafts(): a draft in another household must be
    // indistinguishable from one that does not exist, and a resolved draft is
    // a 400 rather than a 404 because the row is right there and the caller
    // asked for something it no longer supports.
    if (!current) throw new NotFoundError("Pending import not found in this household");
    if (current.status !== "pending") {
      throw new ValidationError("Only pending imports can be edited");
    }

    if (patch.kind !== undefined && !BOOKING_KINDS.includes(patch.kind)) {
      throw new ValidationError(`kind must be one of ${BOOKING_KINDS.join(", ")}`);
    }
    if (
      patch.title !== undefined &&
      (typeof patch.title !== "string" || patch.title.trim() === "")
    ) {
      throw new ValidationError("title must be a non-empty string");
    }
    const kind = patch.kind ?? current.kind;
    const title = patch.title === undefined ? current.title : patch.title.trim();

    // The EFFECTIVE post-patch pair, not the patch: clearing `startsAtTz`
    // while a stored `startsAt` remains is exactly as broken as sending an
    // instant with no zone, and only this method can see the stored half.
    assertBookingTiming({
      startsAt: patch.startsAt === undefined ? current.startsAt : patch.startsAt,
      startsAtTz: patch.startsAtTz === undefined ? current.startsAtTz : patch.startsAtTz,
      endsAt: patch.endsAt === undefined ? current.endsAt : patch.endsAt,
      endsAtTz: patch.endsAtTz === undefined ? current.endsAtTz : patch.endsAtTz,
    });
    assertNonNegativeAmount("costCents", patch.costCents);

    let confirmationNumber: string | null | undefined;
    if (patch.confirmationNumber !== undefined) {
      const trimmed = patch.confirmationNumber?.trim() ?? "";
      // Belt and braces: a draft's confirmation number is shown in the clear
      // (nothing has encrypted it yet), so an honest client has no masked
      // value to echo. This guard exists so that a future queue that DID mask
      // it cannot write "••••WN88" over the real code, exactly as
      // BookingRepo.create/update refuse the same round trip.
      if (trimmed !== "") {
        try {
          assertNotMasked("confirmationNumber", trimmed);
        } catch (err) {
          throw new ValidationError(err instanceof Error ? err.message : String(err));
        }
      }
      confirmationNumber = trimmed === "" ? null : trimmed;
    }

    // Validated exactly as the accept will consume it — through
    // importedDetails() — so a lodging edit is not rejected for a
    // propertyName the commit was about to supply from the title. The PARSED
    // record is what gets stored, so what the reviewer sees on re-review is
    // what the booking will carry (IATA codes upper-cased, nulls dropped).
    let details: unknown;
    if (patch.details !== undefined) {
      details = parseDetails(kind, importedDetails(kind, title, patch.details));
    } else if (patch.kind !== undefined && patch.kind !== current.kind) {
      // The kind moved but the details did not. A flight's details are not a
      // valid car rental's, so re-validate rather than storing a record the
      // new kind's schema would reject at accept time.
      try {
        details = parseDetails(
          kind,
          importedDetails(kind, title, asRecord(current.extracted).details),
        );
      } catch {
        throw new ValidationError(
          `Changing this import to ${kind} needs details that match that kind`,
        );
      }
    }

    const columnValues: Record<keyof typeof UPDATE_COLUMNS, string | null | undefined> = {
      kind: patch.kind,
      title: patch.title === undefined ? undefined : title,
      location: patch.location,
      startsAt: patch.startsAt,
      startsAtTz: patch.startsAtTz,
      endsAt: patch.endsAt,
      endsAtTz: patch.endsAtTz,
      confirmationNumber,
    };

    const sets: string[] = [];
    const params: unknown[] = [];
    // Caller param k (1-based) binds to ?(k+1); the household id owns ?1.
    let next = 2;
    for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
      const value = columnValues[key as keyof typeof UPDATE_COLUMNS];
      // `undefined` is "not supplied", which is the tri-state's whole point.
      if (value === undefined) continue;
      sets.push(`${column} = ?${next++}`);
      params.push(value ?? null);
    }

    if (patch.costCents !== undefined || details !== undefined) {
      sets.push(`extracted_json = ?${next++}`);
      params.push(JSON.stringify({
        ...asRecord(current.extracted),
        ...(patch.costCents === undefined ? {} : { costCents: patch.costCents }),
        ...(details === undefined ? {} : { details }),
      }));
    }

    if (sets.length > 0) {
      const changed = await this.runChanges(
        `UPDATE draft_booking SET ${sets.join(", ")}
          WHERE {scope} AND id = ?${next} AND status = 'pending'`,
        ...params,
        id,
      );
      if (changed === 0) {
        // The compare-and-set lost: the draft was accepted or dismissed
        // between the read above and this write. Same answer as finding it
        // resolved in the first place.
        throw new ValidationError("Only pending imports can be edited");
      }
    }

    const updated = await this.findById(id);
    if (!updated) throw new Error("Draft booking disappeared immediately after update");
    return updated;
  }

  async markAccepted(id: string, bookingId: string): Promise<DraftBooking> {
    const draft = await this.findById(id);
    if (!draft) throw new NotFoundError("Draft booking not found in this household");
    if (draft.status !== "pending") {
      throw new ValidationError(`Only a pending draft can transition; this one is ${draft.status}`);
    }
    const booking = await this.get<{ id: string; source_inbound_email_id: string | null }>(
      "SELECT id, source_inbound_email_id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");
    if (booking.source_inbound_email_id !== draft.inboundEmailId) {
      throw new ValidationError("Accepted booking must retain the draft's source inbound email");
    }
    return await this.transition(id, "accepted", bookingId);
  }

  async markDismissed(id: string): Promise<DraftBooking> {
    return await this.transition(id, "dismissed", null);
  }

  private async transition(
    id: string,
    status: "accepted" | "dismissed",
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateDraft(input: CreateDraftBookingInput): void {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new ValidationError("Draft ordinal must be a non-negative integer");
  }
  if (!BOOKING_KINDS.includes(input.kind)) {
    throw new ValidationError(`kind must be one of ${BOOKING_KINDS.join(", ")}`);
  }
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new ValidationError("A draft booking requires a non-empty title");
  }
  if (!DRAFT_BOOKING_SOURCES.includes(input.source)) {
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

function toDraftBooking(row: Row): DraftBooking {
  let extracted: unknown = {};
  try {
    extracted = JSON.parse(row.extracted_json);
  } catch {
    // Mapped columns remain useful if a legacy/corrupt JSON payload exists.
  }
  return {
    id: row.id,
    inboundEmailId: row.inbound_email_id,
    ordinal: row.ordinal,
    kind: row.kind,
    title: row.title,
    location: row.location,
    startsAt: row.starts_at,
    startsAtTz: row.starts_at_tz,
    endsAt: row.ends_at,
    endsAtTz: row.ends_at_tz,
    confirmationNumber: row.confirmation_number,
    source: row.source,
    extracted,
    status: row.status,
    bookingId: row.booking_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
