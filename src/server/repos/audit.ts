import { TenantRepo, ForbiddenError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { newId } from "../ids.js";

/**
 * The tenancy-layer view of `audit_log` (migrations/0016, widened by 0018).
 *
 * Scope of this repo: it records WHAT HAPPENED to a household's records -- a
 * stored secret unmasked, a person edited, a member invited -- and lets that
 * history be read back. It is still not a general-purpose event bus. Every
 * event name is a decision about what a household is entitled to know about
 * its members, which is why they are an explicit list here and a CHECK
 * constraint in the schema rather than a free `string`.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: an entry names records and fields,
 * never their contents. There is no column, and no argument, that can carry a
 * passport number into this table. See `RecordInput.fields` and migrations/0018.
 */

/**
 * Kept in sync with the CHECK constraint on audit_log.event, and with the
 * `event` names the structured logger emits for the same actions so one word
 * finds both the row and the log line.
 */
export const AUDIT_EVENTS = [
  "document_reveal",
  "confirmation_reveal",
  "person_created",
  "person_updated",
  "member_invited",
  "member_role_changed",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/** The events that name exactly one revealed field, and require it. */
const REVEAL_EVENTS: readonly AuditEvent[] = ["document_reveal", "confirmation_reveal"];

export const AUDIT_SUBJECT_TYPES = ["person", "booking", "household_member"] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

/**
 * A bare snake_case column identifier. Field names are matched against this
 * before they can be stored.
 *
 * This is the runtime half of "names, never values". `fields: string[]` says
 * so in the type system, but nothing in the type system stops a caller from
 * passing `["passport_number=C03X72119"]`, and the column it lands in is
 * append-only and unencrypted. Every legitimate field name in this codebase
 * is a column identifier, so demanding one costs nothing and makes the
 * dangerous shape unrepresentable rather than merely discouraged.
 */
const FIELD_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/** How many field names one entry may name, before it is describing a dump. */
const MAX_FIELDS = 32;

export type AuditEntry = {
  id: string;
  event: AuditEvent;
  /** Who did it. */
  actorUserId: string;
  actorEmail: string;
  /** WHICH RECORD was acted on -- never what it contained. */
  subjectType: AuditSubjectType;
  subjectId: string;
  /**
   * The NAME of the single revealed field ("passport_number",
   * "confirmation_number"). Null for events that are not reveals; those name
   * their fields in `fields` below, because an edit can touch several.
   */
  field: string | null;
  /** The validated parent trip of a booking reveal; null for person reveals. */
  tripId: string | null;
  /**
   * True when the actor acted on their OWN record. The log's sharpest question
   * is "who looked at somebody else's documents", and a household checking its
   * own passport numbers before a trip would otherwise bury the answer.
   */
  selfService: boolean;
  /**
   * The NAMES of the fields a change touched. Null when the event does not
   * describe a field-level change. Never values -- see the file header.
   */
  fields: string[] | null;
  /** ISO 8601, UTC. */
  at: string;
};

/**
 * The one way to write an audit row.
 *
 * `fields` is a list of NAMES, deliberately not a `Record<string, unknown>`
 * "detail" bag. A bag is the shape a future caller pours a passport number
 * into by accident, and this table is exactly where that must never land.
 */
export type RecordInput = {
  event: AuditEvent;
  subjectType: AuditSubjectType;
  subjectId: string;
  /**
   * Whether the subject is the actor's own record. The caller passes it
   * because only the repository that read `person.user_id` can know, and the
   * answer has to be frozen at the time of the action: the person can later be
   * deleted or relinked, and deriving the flag on read would silently rewrite
   * history.
   */
  selfService?: boolean;
  /** Field NAMES the action touched. Values are not accepted, ever. */
  fields?: string[];
  /** The single field a reveal unmasked. Required for the two reveal events. */
  field?: string;
  /** Required for a booking reveal; must already be validated against it. */
  tripId?: string | null;
};

/** The narrower input of the reveal-specific wrapper, kept for its callers. */
export type RecordRevealInput = {
  event: AuditEvent;
  subjectType: AuditSubjectType;
  subjectId: string;
  field: string;
  tripId?: string | null;
  selfService?: boolean;
};

export type ListActivityOptions = {
  limit?: number;
  /**
   * Keyset cursor: return only entries strictly older than this one. Keyset
   * rather than OFFSET because this log is written while it is being read --
   * an OFFSET page would skip or repeat rows as new entries land at the top,
   * and the row it skipped would be the reveal somebody was scrolling to find.
   */
  before?: { at: string; id: string };
};

type Row = {
  id: string;
  event: AuditEvent;
  actor_user_id: string;
  actor_email: string;
  subject_type: AuditSubjectType;
  subject_id: string;
  field: string | null;
  trip_id: string | null;
  self_service: number;
  detail: string | null;
  at: string;
};

/**
 * How many entries the owner-facing reveal endpoint returns. A fixed window
 * rather than a `?limit=` the client picks: the surface is a "what happened
 * lately" panel, and an unbounded audit read is the one query in the app that
 * can be made arbitrarily expensive by simply using the app a lot.
 */
const READ_LIMIT = 200;

/** The paging read's default and ceiling. Same argument, one page at a time. */
const ACTIVITY_PAGE = 50;
const MAX_ACTIVITY_PAGE = 200;

export class AuditRepo extends TenantRepo {

  /**
   * Writes the record of an action that ALREADY SUCCEEDED. Call it after the
   * action, never before: a row written ahead of the repo call would claim a
   * change for a request that then 403s or 404s.
   *
   * The actor comes from the authenticated context, never from an argument,
   * so a caller cannot attribute its own action to somebody else. `subjectId`
   * and `fields` are arguments because they are facts about the SUBJECT that
   * only the repository holding it has seen.
   */
  async record(input: RecordInput): Promise<AuditEntry> {
    const selfService = input.selfService === true;
    // A viewer used to be unable to reach this method at all -- requireReveal
    // threw first -- and requireWrite() here was a redundant restatement of
    // that. It is no longer redundant: a viewer may now reveal and edit their
    // OWN record, and the row recording that they did has to be writable by
    // them, or the action fails and their own profile is unreachable again.
    //
    // What authorizes the write is therefore the action it describes, which
    // the calling repository has already performed and permission-checked, and
    // which is the sole source of `selfService`.
    if (!selfService) this.requireWrite();

    if (!AUDIT_EVENTS.includes(input.event)) {
      throw new ValidationError(`Unknown audit event "${String(input.event)}"`);
    }
    if (!AUDIT_SUBJECT_TYPES.includes(input.subjectType)) {
      throw new ValidationError(`Unknown audit subject type "${String(input.subjectType)}"`);
    }
    if (typeof input.subjectId !== "string" || input.subjectId.trim() === "") {
      throw new ValidationError("An audit entry requires the id of the record it describes");
    }
    if (REVEAL_EVENTS.includes(input.event)) {
      if (typeof input.field !== "string" || input.field.trim() === "") {
        throw new ValidationError("An audit entry requires the name of the revealed field");
      }
    }
    // The invariant issue #19 bought: a booking reveal is only meaningful in
    // the audit trail if it names the trip it was performed under, and that
    // trip has been checked against the booking. Refusing the row is how the
    // repo keeps a future caller from re-introducing the ambiguity.
    if (input.subjectType === "booking" && !input.tripId) {
      throw new ValidationError("A booking audit entry requires its validated trip id");
    }
    const fields = normalizeFields(input.fields);

    const entry: AuditEntry = {
      id: newId(),
      event: input.event,
      actorUserId: this.ctx.userId,
      actorEmail: this.actorEmail(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      field: input.field ?? null,
      tripId: input.tripId ?? null,
      selfService,
      fields,
      at: new Date().toISOString(),
    };
    const values: Row = {
      id: entry.id,
      event: entry.event,
      actor_user_id: entry.actorUserId,
      actor_email: entry.actorEmail,
      subject_type: entry.subjectType,
      subject_id: entry.subjectId,
      field: entry.field,
      trip_id: entry.tripId,
      self_service: entry.selfService ? 1 : 0,
      detail: fields === null ? null : JSON.stringify({ fields }),
      at: entry.at,
    };
    if (this.ctx.role === "viewer") await this.insertSelfServiceRow(values);
    else await this.insert("audit_log", { ...values });
    return entry;
  }

  /**
   * The reveal-shaped wrapper, kept because its two call sites (the person
   * document reveal and the booking confirmation reveal) read better naming
   * the thing they did, and because narrowing `field` to required at the type
   * level is worth a four-line method.
   */
  async recordReveal(input: RecordRevealInput): Promise<AuditEntry> {
    return this.record(input);
  }

  /**
   * The owner-only reveal history. Owner and not adult: "who unmasked whose
   * passport number" is household-governance information, and an adult being
   * able to audit the other adults is a different product decision from an
   * owner being able to audit their household. Mirrors TripAccessRepo's
   * requireOwner() rather than inventing a second owner concept.
   */
  async listReveals(): Promise<AuditEntry[]> {
    this.requireOwner();
    const rows = await this.all<Row>(
      `SELECT id, event, actor_user_id, actor_email, subject_type, subject_id,
              field, trip_id, self_service, detail, at
         FROM audit_log
        WHERE {scope} AND event IN ('document_reveal','confirmation_reveal')
        ORDER BY at DESC, id DESC
        LIMIT ?2`,
      READ_LIMIT,
    );
    return rows.map(toAuditEntry);
  }

  /**
   * The rolling activity log, newest first, one keyset page at a time.
   *
   * VISIBILITY. An owner sees the household's whole history. Everybody else
   * sees only entries they are the actor or the subject of.
   *
   * The asymmetry is the point, and it is the same one that made listReveals()
   * owner-only: reading who did what to whom across a household is governance,
   * and handing it to every adult is a different decision from handing it to
   * the person who administers the household. But "who edited my passport
   * number?" is a question about your OWN record that you should never have to
   * ask an owner to answer for you -- so that slice is yours whatever your
   * role, including viewer.
   *
   * "The subject is me" is deliberately two things: an entry whose subject_id
   * IS this account (a household_member entry names a user), and an entry
   * about a person row LINKED to this account (a person entry names a person).
   * Matching only the first would hide every edit of your own profile from
   * you, which is the exact question this read exists to answer.
   */
  async listActivity(options: ListActivityOptions = {}): Promise<AuditEntry[]> {
    const limit = clampActivityPage(options.limit);
    const before = options.before;
    // Bound parameters, in order, starting at ?2 -- ?1 is the household id.
    // Built as a list rather than inline so the two optional clauses cannot
    // drift out of step with the numbering.
    const params: unknown[] = [];
    let next = 2;

    let visibility = "";
    if (this.ctx.role !== "owner") {
      const user = `?${next++}`;
      const household = `?${next++}`;
      // The OR sits inside its own parentheses, BELOW the {scope} token's
      // nesting depth, or base.ts refuses the query outright -- a bare OR
      // alongside the tenancy predicate is exactly what could neutralize it.
      // The subquery repeats the household id rather than reaching for ?1,
      // which is reserved.
      visibility =
        ` AND (actor_user_id = ${user}` +
        ` OR subject_id = ${user}` +
        ` OR subject_id IN (SELECT id FROM person WHERE household_id = ${household} AND user_id = ${user}))`;
      params.push(this.ctx.userId, this.ctx.householdId);
    }

    let keyset = "";
    if (before) {
      const at = `?${next++}`;
      const id = `?${next++}`;
      // Strictly older than the cursor, with the id breaking a tie between two
      // entries written in the same millisecond -- without it a page boundary
      // that lands mid-millisecond drops or repeats those rows.
      keyset = ` AND (at < ${at} OR (at = ${at} AND id < ${id}))`;
      params.push(before.at, before.id);
    }

    const rows = await this.all<Row>(
      `SELECT id, event, actor_user_id, actor_email, subject_type, subject_id,
              field, trip_id, self_service, detail, at
         FROM audit_log
        WHERE {scope}${visibility}${keyset}
        ORDER BY at DESC, id DESC
        LIMIT ?${next}`,
      ...params,
      limit,
    );
    return rows.map(toAuditEntry);
  }

  private requireOwner(): void {
    if (this.ctx.role !== "owner") {
      throw new ForbiddenError("Only household owners may read the audit log");
    }
  }

  /**
   * The insert for the one case base.ts's insert() refuses: a viewer recording
   * an action on their own record.
   *
   * Dropping the row instead is not an option — an unauditable action must
   * fail rather than succeed quietly (see the matching comment in
   * routes/people.ts), so a viewer's self-reveal would 500 on the very log
   * entry that proves it happened.
   *
   * Only reachable when the caller passed `selfService`, which only PersonRepo
   * produces, and only after it has established that the subject is this
   * account's own record. See `roleExemptInsert` in base.ts for what is and is
   * not given up.
   */
  private async insertSelfServiceRow(values: Row): Promise<void> {
    await this.roleExemptInsert(
      "a viewer's action on their own record must still be auditable; the alternative is an unlogged reveal",
      "audit_log",
      { ...values },
    );
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

/**
 * Exported so the route can size a page the same way this repo does. Without
 * it the route would compare the row count against the limit it ASKED for, and
 * a client asking for 500 would get 200 rows, read that as a short page, and
 * conclude the log had ended.
 */
export function clampActivityPage(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return ACTIVITY_PAGE;
  const rounded = Math.floor(requested);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_ACTIVITY_PAGE);
}

/**
 * Validates and de-duplicates the field NAMES an entry may carry, or returns
 * null when there are none. Throws rather than silently dropping a rejected
 * name: a caller passing something that is not a column identifier has either
 * mixed up its arguments or is about to write a value into the audit log, and
 * both deserve to fail loudly at the point of the mistake.
 */
function normalizeFields(fields: string[] | undefined): string[] | null {
  if (fields === undefined) return null;
  if (!Array.isArray(fields)) {
    throw new ValidationError("Audit fields must be a list of field names");
  }
  if (fields.length === 0) return null;
  if (fields.length > MAX_FIELDS) {
    throw new ValidationError(`An audit entry may name at most ${MAX_FIELDS} fields`);
  }
  const seen: string[] = [];
  for (const field of fields) {
    if (typeof field !== "string" || !FIELD_NAME_RE.test(field)) {
      // The offending value is NOT echoed: if a caller really did pass a
      // passport number, repeating it in an error message (which is logged)
      // would leak it to the same place the column would have.
      throw new ValidationError("An audit entry may name only bare field identifiers");
    }
    if (!seen.includes(field)) seen.push(field);
  }
  return seen;
}

/**
 * Reads `detail` back as a field-name list. Tolerant on purpose: a row written
 * by an older build, or by hand, must not break the whole page. Anything that
 * is not the expected shape reads as "no fields named", which is honest --
 * the entry still says who did what to which record.
 */
function parseFields(detail: string | null): string[] | null {
  if (detail === null) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed !== "object" || parsed === null) return null;
    const fields = (parsed as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) return null;
    const names = fields.filter((f): f is string => typeof f === "string" && FIELD_NAME_RE.test(f));
    return names.length > 0 ? names : null;
  } catch {
    return null;
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
    selfService: r.self_service === 1,
    fields: parseFields(r.detail),
    at: r.at,
  };
}
