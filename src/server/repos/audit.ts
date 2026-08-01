import { TenantRepo, ForbiddenError, ValidationError } from "./base.js";
import { newId } from "../ids.js";

/**
 * The tenancy-layer view of `audit_log` (migrations/0016_audit_log.sql).
 *
 * Scope of this repo, deliberately narrow: it records that a stored secret was
 * unmasked, and it lets a household OWNER read that history back. It is not a
 * general-purpose event bus -- every additional event type is a decision about
 * what a household is entitled to know about its members, and that decision
 * belongs in a review, not in a convenience method.
 */

/**
 * Kept in sync with the CHECK constraint on audit_log.event, and with the
 * `event` names the structured logger emits for the same actions so one word
 * finds both the row and the log line.
 */
export const AUDIT_EVENTS = ["document_reveal", "confirmation_reveal"] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export const AUDIT_SUBJECT_TYPES = ["person", "booking"] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

export type AuditEntry = {
  id: string;
  event: AuditEvent;
  /** Who revealed it. */
  actorUserId: string;
  actorEmail: string;
  /** WHICH RECORD was revealed -- never what it contained. */
  subjectType: AuditSubjectType;
  subjectId: string;
  /** The NAME of the revealed field ("passport_number", "confirmation_number"). */
  field: string;
  /** The validated parent trip of a booking reveal; null for person reveals. */
  tripId: string | null;
  /** ISO 8601, UTC. */
  at: string;
};

export type RecordRevealInput = {
  event: AuditEvent;
  subjectType: AuditSubjectType;
  subjectId: string;
  field: string;
  /** Required for a booking reveal; must already be validated against it. */
  tripId?: string | null;
};

type Row = {
  id: string;
  event: AuditEvent;
  actor_user_id: string;
  actor_email: string;
  subject_type: AuditSubjectType;
  subject_id: string;
  field: string;
  trip_id: string | null;
  at: string;
};

/**
 * How many entries the owner-facing endpoint returns. A fixed window rather
 * than a `?limit=` the client picks: the surface is a "what happened lately"
 * panel, and an unbounded audit read is the one query in the app that can be
 * made arbitrarily expensive by simply using the app a lot.
 */
const READ_LIMIT = 200;

export class AuditRepo extends TenantRepo {
  /**
   * Writes the record of a reveal that ALREADY SUCCEEDED. Call it after the
   * reveal, never before: a row written ahead of the repo call would claim a
   * reveal for a request that then 403s or 404s.
   *
   * The actor comes from the authenticated context, never from an argument,
   * so a caller cannot attribute its own reveal to somebody else.
   */
  async recordReveal(input: RecordRevealInput): Promise<AuditEntry> {
    // Redundant with insert()'s own check -- kept as explicit intent at the
    // top of every mutating method, as the other repos do. A viewer can never
    // get here anyway (requireReveal throws first), which is the property the
    // audit trail depends on.
    this.requireWrite();
    if (!AUDIT_EVENTS.includes(input.event)) {
      throw new ValidationError(`Unknown audit event "${String(input.event)}"`);
    }
    if (!AUDIT_SUBJECT_TYPES.includes(input.subjectType)) {
      throw new ValidationError(`Unknown audit subject type "${String(input.subjectType)}"`);
    }
    if (typeof input.field !== "string" || input.field.trim() === "") {
      throw new ValidationError("An audit entry requires the name of the revealed field");
    }
    // The invariant issue #19 bought: a booking reveal is only meaningful in
    // the audit trail if it names the trip it was performed under, and that
    // trip has been checked against the booking. Refusing the row is how the
    // repo keeps a future caller from re-introducing the ambiguity.
    if (input.subjectType === "booking" && !input.tripId) {
      throw new ValidationError("A booking audit entry requires its validated trip id");
    }
    const entry: AuditEntry = {
      id: newId(),
      event: input.event,
      actorUserId: this.ctx.userId,
      actorEmail: this.actorEmail(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      field: input.field,
      tripId: input.tripId ?? null,
      at: new Date().toISOString(),
    };
    await this.insert("audit_log", {
      id: entry.id,
      event: entry.event,
      actor_user_id: entry.actorUserId,
      actor_email: entry.actorEmail,
      subject_type: entry.subjectType,
      subject_id: entry.subjectId,
      field: entry.field,
      trip_id: entry.tripId,
      at: entry.at,
    });
    return entry;
  }

  /**
   * The owner-only read. Owner and not adult: "who unmasked whose passport
   * number" is household-governance information, and an adult being able to
   * audit the other adults is a different product decision from an owner being
   * able to audit their household. Mirrors TripAccessRepo's requireOwner()
   * rather than inventing a second owner concept.
   */
  async listReveals(): Promise<AuditEntry[]> {
    this.requireOwner();
    const rows = await this.all<Row>(
      `SELECT id, event, actor_user_id, actor_email, subject_type, subject_id, field, trip_id, at
         FROM audit_log
        WHERE {scope}
        ORDER BY at DESC, id DESC
        LIMIT ?2`,
      READ_LIMIT,
    );
    return rows.map(toAuditEntry);
  }

  private requireOwner(): void {
    if (this.ctx.role !== "owner") {
      throw new ForbiddenError("Only household owners may read the audit log");
    }
  }

  /**
   * HouseholdContext carries no email (it is the tenancy contract, not the
   * identity), but every HTTP caller's context IS an Identity, which does.
   * Falling back to the user id keeps a non-HTTP caller auditable rather than
   * writing an empty string into the column.
   */
  private actorEmail(): string {
    const email = (this.ctx as { email?: unknown }).email;
    return typeof email === "string" && email.trim() !== "" ? email : this.ctx.userId;
  }
}

function toAuditEntry(r: Row): AuditEntry {
  return {
    id: r.id,
    event: r.event,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    field: r.field,
    tripId: r.trip_id,
    at: r.at,
  };
}
