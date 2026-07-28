import { TenantRepo, ForbiddenError, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { DraftBookingRepo } from "./draft-booking.js";
import type { DraftBooking } from "./draft-booking.js";
import { InboundEmailRepo } from "./inbound-email.js";
import { TripRepo } from "./trip.js";
import type { Trip } from "./trip.js";
import type { Keyring } from "../crypto/envelope.js";
import { newId } from "../ids.js";
import { parseDetails } from "../schemas/booking-kinds.js";
import { isValidCalendarDate } from "../time.js";
import { openConfirmation } from "./confirmation.js";

export type PendingImportDraft = {
  id: string;
  inboundEmailId: string;
  kind: DraftBooking["kind"];
  title: string;
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  confirmationNumber: string | null;
  extractionSource: DraftBooking["source"];
  localStartsOn: string | null;
  localEndsOn: string | null;
  source: {
    from: string;
    subject: string | null;
    receivedAt: string;
  };
  suggestedTrip: Trip | null;
};

export type CreateTripFromDraftsInput = {
  draftIds: string[];
  title: string;
  destination?: string;
  startsOn?: string;
  endsOn?: string;
};

export type ImportReviewResult = {
  trip: Trip;
  acceptedDraftIds: string[];
};

type DateRange = { startsOn: string; endsOn: string };

type BookingCandidate = {
  id: string;
  confirmationNumber: string | null;
  kind: string;
  title: string;
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  costCents: number | null;
  details: Record<string, unknown>;
};

type BookingCandidateRow = {
  id: string;
  confirmation_number: string | null;
  kind: string;
  title: string;
  location: string | null;
  starts_at: string | null;
  starts_at_tz: string | null;
  ends_at: string | null;
  ends_at_tz: string | null;
  cost_cents: number | null;
  details: string;
};

export class ImportReviewRepo extends TenantRepo {
  private readonly drafts: DraftBookingRepo;
  private readonly emails: InboundEmailRepo;
  private readonly trips: TripRepo;

  constructor(
    db: D1Database,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
    this.drafts = new DraftBookingRepo(db, ctx);
    this.emails = new InboundEmailRepo(db, ctx);
    this.trips = new TripRepo(db, ctx);
  }

  async listPending(): Promise<PendingImportDraft[]> {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not review imported bookings");
    }
    const [drafts, trips] = await Promise.all([
      this.drafts.listByStatus("pending"),
      this.trips.list(),
    ]);
    const emailCache = new Map<string, Awaited<ReturnType<InboundEmailRepo["findById"]>>>();
    const pending: PendingImportDraft[] = [];

    for (const draft of drafts) {
      let email = emailCache.get(draft.inboundEmailId);
      if (email === undefined) {
        email = await this.emails.findById(draft.inboundEmailId);
        emailCache.set(draft.inboundEmailId, email);
      }
      if (!email) continue;
      const range = draftDateRange(draft);
      const matches = range ? dateCompatibleTrips(trips, range) : [];
      pending.push({
        id: draft.id,
        inboundEmailId: draft.inboundEmailId,
        kind: draft.kind,
        title: draft.title,
        location: draft.location,
        startsAt: draft.startsAt,
        startsAtTz: draft.startsAtTz,
        endsAt: draft.endsAt,
        endsAtTz: draft.endsAtTz,
        confirmationNumber: draft.confirmationNumber,
        extractionSource: draft.source,
        localStartsOn: range?.startsOn ?? null,
        localEndsOn: range?.endsOn ?? null,
        source: {
          from: email.from,
          subject: email.subject,
          receivedAt: email.receivedAt,
        },
        suggestedTrip: matches.length === 1 ? matches[0]! : null,
      });
    }
    return pending;
  }

  async acceptIntoTrip(draftIds: string[], tripId: string): Promise<ImportReviewResult> {
    this.requireWrite();
    const trip = await this.trips.findById(tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");
    if (trip.status === "cancelled") {
      throw new ValidationError("Pending imports cannot be added to a cancelled trip");
    }
    const drafts = await this.pendingDrafts(draftIds);
    await this.commitDraftsToTrip(drafts, trip.id);
    return { trip, acceptedDraftIds: drafts.map((draft) => draft.id) };
  }

  async createTripFromDrafts(input: CreateTripFromDraftsInput): Promise<ImportReviewResult> {
    this.requireWrite();
    const title = input.title.trim();
    if (title === "") throw new ValidationError("A trip title is required");
    const drafts = await this.pendingDrafts(input.draftIds);
    const derived = combinedDateRange(drafts);
    const startsOn = input.startsOn ?? derived?.startsOn ?? null;
    const endsOn = input.endsOn ?? derived?.endsOn ?? null;
    validateTripDates(startsOn, endsOn);

    const tripId = newId();
    const now = new Date().toISOString();
    const statements = [
      {
        sql: `INSERT INTO trip
                (id, household_id, title, destination, starts_on, ends_on, status, notes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'planning', NULL, ?)`,
        params: [
          tripId,
          this.ctx.householdId,
          title,
          input.destination?.trim() || null,
          startsOn,
          endsOn,
          now,
        ],
      },
      ...(await this.draftAcceptanceStatements(drafts, tripId, now)),
    ];
    await this.unscopedBatchRun(
      "atomic import review: create one in-household trip, create its source-linked bookings, and resolve the prevalidated in-household drafts",
      statements,
    );
    const trip = await this.trips.findById(tripId);
    if (!trip) throw new Error("Imported trip disappeared immediately after creation");
    return { trip, acceptedDraftIds: drafts.map((draft) => draft.id) };
  }

  async dismiss(draftIds: string[]): Promise<string[]> {
    this.requireWrite();
    const drafts = await this.pendingDrafts(draftIds);
    for (const draft of drafts) await this.drafts.markDismissed(draft.id);
    return drafts.map((draft) => draft.id);
  }

  private async pendingDrafts(ids: string[]): Promise<DraftBooking[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw new ValidationError("Choose at least one pending import");
    const drafts: DraftBooking[] = [];
    for (const id of unique) {
      const draft = await this.drafts.findById(id);
      if (!draft) throw new NotFoundError("Pending import not found in this household");
      if (draft.status !== "pending") {
        throw new ValidationError("Only pending imports can be reviewed");
      }
      drafts.push(draft);
    }
    return drafts;
  }

  private async commitDraftsToTrip(drafts: DraftBooking[], tripId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.unscopedBatchRun(
      "atomic import review: create source-linked bookings in a prevalidated in-household trip and resolve the prevalidated in-household drafts",
      await this.draftAcceptanceStatements(drafts, tripId, now),
    );
  }

  private async draftAcceptanceStatements(
    drafts: DraftBooking[],
    tripId: string,
    resolvedAt: string,
  ): Promise<Array<{ sql: string; params: unknown[] }>> {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const [peopleByEmail, candidates] = await Promise.all([
      this.peopleByEmail(),
      this.bookingCandidates(tripId),
    ]);
    for (const draft of drafts) {
      const extracted = asRecord(draft.extracted);
      const details = parseDetails(
        draft.kind,
        importDetails(draft.kind, draft.title, extracted.details),
      );
      const detailRecord = asRecord(details);
      const costCents =
        typeof extracted.costCents === "number" && Number.isInteger(extracted.costCents)
          ? extracted.costCents
          : null;
      const personIds = matchedPersonIds(extracted.travelerEmails, peopleByEmail);
      const incoming: Omit<BookingCandidate, "id"> = {
        confirmationNumber: draft.confirmationNumber,
        kind: draft.kind,
        title: draft.title,
        location: draft.location,
        startsAt: draft.startsAt,
        startsAtTz: draft.startsAtTz,
        endsAt: draft.endsAt,
        endsAtTz: draft.endsAtTz,
        costCents,
        details: detailRecord,
      };
      const duplicate = candidates.find((candidate) =>
        sameReservation(candidate, incoming)
      );

      if (duplicate) {
        const mergedDetails = mergeDetails(duplicate.details, detailRecord);
        statements.push({
          sql: `UPDATE booking
                   SET kind = CASE WHEN kind = 'other' AND ? != 'other' THEN ? ELSE kind END,
                       location = coalesce(location, ?),
                       starts_at = coalesce(starts_at, ?),
                       starts_at_tz = coalesce(starts_at_tz, ?),
                       ends_at = coalesce(ends_at, ?),
                       ends_at_tz = coalesce(ends_at_tz, ?),
                       cost_cents = coalesce(cost_cents, ?),
                       details = ?
                 WHERE id = ? AND household_id = ?`,
          params: [
            draft.kind,
            draft.kind,
            draft.location,
            draft.startsAt,
            draft.startsAtTz,
            draft.endsAt,
            draft.endsAtTz,
            costCents,
            JSON.stringify(mergedDetails),
            duplicate.id,
            this.ctx.householdId,
          ],
        });
        appendPersonStatements(
          statements,
          duplicate.id,
          tripId,
          personIds,
        );
        statements.push({
          sql: `UPDATE draft_booking
                   SET status = 'accepted', booking_id = ?, resolved_at = ?
                 WHERE id = ? AND household_id = ? AND status = 'pending'`,
          params: [
            duplicate.id,
            resolvedAt,
            draft.id,
            this.ctx.householdId,
          ],
        });
        duplicate.details = mergedDetails;
        duplicate.kind =
          duplicate.kind === "other" ? draft.kind : duplicate.kind;
        duplicate.location ??= draft.location;
        duplicate.startsAt ??= draft.startsAt;
        duplicate.startsAtTz ??= draft.startsAtTz;
        duplicate.endsAt ??= draft.endsAt;
        duplicate.endsAtTz ??= draft.endsAtTz;
        duplicate.costCents ??= costCents;
        continue;
      }

      const bookingId = newId();
      const encryptedConfirmation = draft.confirmationNumber
        ? await this.ring.encrypt(draft.confirmationNumber)
        : null;

      // The title scalar subquery is also the race guard. If another reviewer
      // resolves this draft after prevalidation but before the batch executes,
      // it returns NULL, violates booking.title NOT NULL, and rolls back the
      // entire batch instead of creating a duplicate or a partial trip.
      statements.push({
        sql: `INSERT INTO booking (
                id, household_id, trip_id, source_inbound_email_id, kind, title,
                location, starts_at, starts_at_tz, ends_at, ends_at_tz,
                confirmation_number, cost_cents, points_used, points_program,
                status, details, created_at
              ) VALUES (
                ?, ?, ?, ?, ?,
                (SELECT title FROM draft_booking
                  WHERE id = ? AND household_id = ? AND status = 'pending'),
                ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'planned', ?, ?
              )`,
        params: [
          bookingId,
          this.ctx.householdId,
          tripId,
          draft.inboundEmailId,
          draft.kind,
          draft.id,
          this.ctx.householdId,
          draft.location,
          draft.startsAt,
          draft.startsAtTz,
          draft.endsAt,
          draft.endsAtTz,
          encryptedConfirmation,
          costCents,
          JSON.stringify(details),
          resolvedAt,
        ],
      });
      appendPersonStatements(statements, bookingId, tripId, personIds);
      statements.push({
        sql: `UPDATE draft_booking
                 SET status = 'accepted', booking_id = ?, resolved_at = ?
               WHERE id = ? AND household_id = ? AND status = 'pending'`,
        params: [bookingId, resolvedAt, draft.id, this.ctx.householdId],
      });
      candidates.push({ id: bookingId, ...incoming });
    }
    return statements;
  }

  private async peopleByEmail(): Promise<Map<string, string>> {
    const rows = await this.all<{ id: string; email: string }>(
      `SELECT id, email
         FROM person
        WHERE {scope} AND email IS NOT NULL AND trim(email) != ''`,
    );
    return new Map(rows.map((row) => [normalizeEmail(row.email), row.id]));
  }

  private async bookingCandidates(tripId: string): Promise<BookingCandidate[]> {
    const rows = await this.all<BookingCandidateRow>(
      `SELECT id, confirmation_number, kind, title, location,
              starts_at, starts_at_tz, ends_at, ends_at_tz, cost_cents, details
         FROM booking
        WHERE {scope} AND trip_id = ?2 AND status != 'cancelled'`,
      tripId,
    );
    const candidates: BookingCandidate[] = [];
    for (const row of rows) {
      try {
        candidates.push({
          id: row.id,
          confirmationNumber: await openConfirmation(
            this.ring,
            row.confirmation_number,
          ),
          kind: row.kind,
          title: row.title,
          location: row.location,
          startsAt: row.starts_at,
          startsAtTz: row.starts_at_tz,
          endsAt: row.ends_at,
          endsAtTz: row.ends_at_tz,
          costCents: row.cost_cents,
          details: parseStoredDetails(row.details),
        });
      } catch (err) {
        console.error(
          `[ImportReviewRepo] skipping booking ${row.id} during duplicate detection`,
          err,
        );
      }
    }
    return candidates;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function matchedPersonIds(
  value: unknown,
  peopleByEmail: Map<string, string>,
): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const personId = peopleByEmail.get(normalizeEmail(candidate));
    if (personId) ids.add(personId);
  }
  return [...ids];
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function appendPersonStatements(
  statements: Array<{ sql: string; params: unknown[] }>,
  bookingId: string,
  tripId: string,
  personIds: string[],
): void {
  for (const personId of personIds) {
    statements.push({
      sql: "INSERT OR IGNORE INTO booking_person (booking_id, person_id) VALUES (?, ?)",
      params: [bookingId, personId],
    });
    statements.push({
      sql: "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      params: [tripId, personId],
    });
  }
}

function sameReservation(
  existing: BookingCandidate,
  incoming: Omit<BookingCandidate, "id">,
): boolean {
  const existingConfirmation = normalizeConfirmation(existing.confirmationNumber);
  const incomingConfirmation = normalizeConfirmation(incoming.confirmationNumber);
  if (
    existingConfirmation === "" ||
    existingConfirmation !== incomingConfirmation ||
    normalizeTitle(existing.title) !== normalizeTitle(incoming.title)
  ) {
    return false;
  }

  if (
    datesConflict(
      existing.startsAt,
      existing.startsAtTz,
      incoming.startsAt,
      incoming.startsAtTz,
    ) ||
    datesConflict(
      existing.endsAt,
      existing.endsAtTz,
      incoming.endsAt,
      incoming.endsAtTz,
    )
  ) {
    return false;
  }

  // The same confirmation can legitimately contain multiple rooms, sites,
  // or units. If both extractions identify different units, keep both.
  const existingUnit = reservationUnit(existing.details);
  const incomingUnit = reservationUnit(incoming.details);
  return !existingUnit || !incomingUnit || existingUnit === incomingUnit;
}

function normalizeConfirmation(value: string | null): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function datesConflict(
  firstAt: string | null,
  firstZone: string | null,
  secondAt: string | null,
  secondZone: string | null,
): boolean {
  const first = localDate(firstAt, firstZone);
  const second = localDate(secondAt, secondZone);
  return !!first && !!second && first !== second;
}

function reservationUnit(details: Record<string, unknown>): string | undefined {
  for (const key of ["siteNumber", "site", "roomNumber", "room", "unit"]) {
    const value = details[key];
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim().toLowerCase();
      if (normalized !== "") return normalized;
    }
  }
  return undefined;
}

function mergeDetails(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (
      merged[key] === undefined ||
      merged[key] === null ||
      merged[key] === ""
    ) {
      merged[key] = value;
    }
  }
  return merged;
}

function parseStoredDetails(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function importDetails(kind: string, title: string, value: unknown): unknown {
  const details = asRecord(value);
  if (kind !== "lodging") return details;
  return {
    propertyName:
      typeof details.propertyName === "string" && details.propertyName.trim() !== ""
        ? details.propertyName
        : title,
    ...details,
  };
}

function draftDateRange(draft: Pick<
  DraftBooking,
  "startsAt" | "startsAtTz" | "endsAt" | "endsAtTz"
>): DateRange | undefined {
  const start = localDate(draft.startsAt, draft.startsAtTz);
  const end = localDate(draft.endsAt, draft.endsAtTz);
  if (!start && !end) return undefined;
  const startsOn = start ?? end!;
  const endsOn = end ?? start!;
  return startsOn <= endsOn
    ? { startsOn, endsOn }
    : { startsOn: endsOn, endsOn: startsOn };
}

function combinedDateRange(drafts: DraftBooking[]): DateRange | undefined {
  const ranges = drafts.map(draftDateRange).filter((range): range is DateRange => !!range);
  if (ranges.length === 0) return undefined;
  return {
    startsOn: ranges.map((range) => range.startsOn).sort()[0]!,
    endsOn: ranges.map((range) => range.endsOn).sort().at(-1)!,
  };
}

function dateCompatibleTrips(trips: Trip[], range: DateRange): Trip[] {
  return trips.filter(
    (trip) =>
      trip.status !== "cancelled" &&
      trip.startsOn !== null &&
      trip.endsOn !== null &&
      trip.startsOn <= range.startsOn &&
      trip.endsOn >= range.endsOn,
  );
}

function localDate(at: string | null, zone: string | null): string | undefined {
  if (!at || !zone) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(at));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = value("year");
    const month = value("month");
    const day = value("day");
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
}

function validateTripDates(startsOn: string | null, endsOn: string | null): void {
  if (startsOn !== null && !isValidCalendarDate(startsOn)) {
    throw new ValidationError("startsOn must be a well-formed YYYY-MM-DD date");
  }
  if (endsOn !== null && !isValidCalendarDate(endsOn)) {
    throw new ValidationError("endsOn must be a well-formed YYYY-MM-DD date");
  }
  if (startsOn !== null && endsOn !== null && startsOn > endsOn) {
    throw new ValidationError("startsOn must be on or before endsOn");
  }
}
