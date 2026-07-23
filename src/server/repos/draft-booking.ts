import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { newId } from "../ids.js";
import { BOOKING_KINDS } from "../schemas/booking-kinds.js";
import type { BookingKind } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";

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
