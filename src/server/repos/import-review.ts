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
    for (const draft of drafts) {
      const extracted = asRecord(draft.extracted);
      const details = parseDetails(draft.kind, extracted.details ?? {});
      const costCents =
        typeof extracted.costCents === "number" && Number.isInteger(extracted.costCents)
          ? extracted.costCents
          : null;
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
      statements.push({
        sql: `UPDATE draft_booking
                 SET status = 'accepted', booking_id = ?, resolved_at = ?
               WHERE id = ? AND household_id = ? AND status = 'pending'`,
        params: [bookingId, resolvedAt, draft.id, this.ctx.householdId],
      });
    }
    return statements;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
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
