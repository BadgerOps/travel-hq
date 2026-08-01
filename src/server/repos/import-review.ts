import {
  TenantRepo,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./base.js";
import type { HouseholdContext } from "./base.js";
import { DraftBookingRepo } from "./draft-booking.js";
import type { DraftBooking } from "./draft-booking.js";
import { InboundEmailRepo } from "./inbound-email.js";
import { openConfirmation } from "./confirmation.js";
import { TripRepo } from "./trip.js";
import type { Trip } from "./trip.js";
import type { Keyring } from "../crypto/envelope.js";
import { findDuplicates } from "../dedupe.js";
import type { DuplicateCandidate, DuplicateGroup } from "../dedupe.js";
import { newId } from "../ids.js";
import { parseDetails } from "../schemas/booking-kinds.js";
import { isValidCalendarDate, isValidInstant } from "../time.js";
import { assertTripDateRange } from "./validation.js";

/**
 * Something a pending draft appears to repeat — either a booking the household
 * already has, or another draft still sitting in the same queue (two forwards
 * of one confirmation land as two drafts, and neither is a booking yet).
 *
 * Reported for information at every confidence; only `high` blocks an accept.
 * See `assertNoDuplicates`.
 */
export type PendingImportDuplicate = {
  reason: DuplicateGroup["reason"];
  confidence: DuplicateGroup["confidence"];
  target: "booking" | "draft";
  id: string;
  title: string;
  startsAt: string | null;
  startsAtTz: string | null;
  /** Where it already lives. Null for a `draft` target — it lives nowhere yet. */
  tripId: string | null;
  tripTitle: string | null;
};

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
  costCents: number | null;
  details: unknown;
  travelerNames: string[];
  travelerEmails: string[];
  extractionSource: DraftBooking["source"];
  localStartsOn: string | null;
  localEndsOn: string | null;
  source: {
    from: string;
    subject: string | null;
    receivedAt: string;
  };
  suggestedTrip: Trip | null;
  /**
   * What this draft looks like a repeat of. Empty for the ordinary case.
   * Populated so the review queue can say so BEFORE the draft becomes a
   * booking — the trip page can only clean up after the fact, and the cheapest
   * duplicate is the one that never got imported.
   */
  duplicates: PendingImportDuplicate[];
};

export type CreateTripFromDraftsInput = {
  draftIds: string[];
  title: string;
  destination?: string;
  startsOn?: string;
  endsOn?: string;
  /**
   * Import even the drafts that duplicate something. The default refusal is a
   * 409 the reviewer can answer; this is how they answer it. Never defaulted
   * to true — a silent import is exactly the behaviour that produced the
   * duplicates in the first place.
   */
  allowDuplicates?: boolean;
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
    const duplicatesByDraft = await this.duplicatesForDrafts(drafts, trips);

    for (const draft of drafts) {
      let email = emailCache.get(draft.inboundEmailId);
      if (email === undefined) {
        email = await this.emails.findById(draft.inboundEmailId);
        emailCache.set(draft.inboundEmailId, email);
      }
      if (!email) continue;
      const range = draftDateRange(draft);
      const extracted = asRecord(draft.extracted);
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
        costCents:
          typeof extracted.costCents === "number" && Number.isInteger(extracted.costCents)
            ? extracted.costCents
            : null,
        details: extracted.details ?? {},
        travelerNames: stringArray(extracted.travelerNames),
        travelerEmails: stringArray(extracted.travelerEmails),
        extractionSource: draft.source,
        localStartsOn: range?.startsOn ?? null,
        localEndsOn: range?.endsOn ?? null,
        source: {
          from: email.from,
          subject: email.subject,
          receivedAt: email.receivedAt,
        },
        suggestedTrip: matches.length === 1 ? matches[0]! : null,
        duplicates: duplicatesByDraft.get(draft.id) ?? [],
      });
    }
    return pending;
  }

  async acceptIntoTrip(
    draftIds: string[],
    tripId: string,
    allowDuplicates = false,
  ): Promise<ImportReviewResult> {
    this.requireWrite();
    const trip = await this.trips.findById(tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");
    if (trip.status === "cancelled") {
      throw new ValidationError("Pending imports cannot be added to a cancelled trip");
    }
    const drafts = await this.pendingDrafts(draftIds);
    // Before the batch, not after: an accepted draft is a booking, and undoing
    // that means finding it again on the trip page and merging it back.
    await this.assertNoDuplicates(drafts, trip, allowDuplicates);
    await this.commitDraftsToTrip(drafts, trip.id);
    return { trip, acceptedDraftIds: drafts.map((draft) => draft.id) };
  }

  async createTripFromDrafts(input: CreateTripFromDraftsInput): Promise<ImportReviewResult> {
    this.requireWrite();
    const title = input.title.trim();
    if (title === "") throw new ValidationError("A trip title is required");
    const drafts = await this.pendingDrafts(input.draftIds);
    // A brand-new trip has no bookings to collide with, so this only catches
    // the batch repeating itself — two forwards of one confirmation selected
    // together, which is the shape that makes a freshly created trip already
    // need cleaning up.
    await this.assertNoDuplicates(drafts, null, input.allowDuplicates ?? false);
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

  /**
   * What each pending draft looks like a repeat of — an existing booking
   * anywhere in the household, or another draft still in the queue.
   *
   * Deliberately not scoped to the draft's suggested trip: a confirmation
   * email is as often forwarded twice a week apart as twice in a minute, and
   * by the second forward the booking may already be sitting on a trip this
   * draft was never matched to. Naming the trip in the result is what makes
   * that useful rather than confusing.
   */
  private async duplicatesForDrafts(
    drafts: DraftBooking[],
    trips: Trip[],
  ): Promise<Map<string, PendingImportDuplicate[]>> {
    const byDraft = new Map<string, PendingImportDuplicate[]>();
    if (drafts.length === 0) return byDraft;

    const liveTrips = new Map(
      trips.filter((trip) => trip.status !== "cancelled").map((trip) => [trip.id, trip]),
    );
    // Only kinds actually present in the queue can match anything — a
    // household with years of bookings should not decrypt every one of them to
    // review one hotel confirmation.
    const kinds = new Set(drafts.map((draft) => draft.kind));
    const rows = (await this.all<BookingCandidateRow>(
      `SELECT id, trip_id, kind, title, location, starts_at, starts_at_tz, confirmation_number
         FROM booking
        WHERE {scope} AND status != 'cancelled'`,
    )).filter((row) => kinds.has(row.kind as DraftBooking["kind"]) && liveTrips.has(row.trip_id));

    const bookings = await Promise.all(
      rows.map(async (row) => ({
        row,
        candidate: {
          id: bookingKey(row.id),
          kind: row.kind,
          title: row.title,
          location: row.location,
          startsAt: row.starts_at,
          // Decrypted to compare, never returned: PendingImportDuplicate
          // carries a title and a trip, not a confirmation number.
          confirmation: await openConfirmation(this.ring, row.confirmation_number),
        } satisfies DuplicateCandidate,
      })),
    );

    const groups = findDuplicates([
      ...drafts.map((draft) => draftCandidate(draft)),
      ...bookings.map((booking) => booking.candidate),
    ]);
    if (groups.length === 0) return byDraft;

    const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
    const bookingsById = new Map(bookings.map((booking) => [booking.row.id, booking.row]));

    for (const group of groups) {
      for (const memberKey of group.bookingIds) {
        const draftId = draftIdOf(memberKey);
        if (!draftId) continue; // a booking-to-booking pair: the trip page's job
        const others: PendingImportDuplicate[] = [];
        for (const otherKey of group.bookingIds) {
          if (otherKey === memberKey) continue;
          const otherDraftId = draftIdOf(otherKey);
          if (otherDraftId) {
            const other = draftsById.get(otherDraftId);
            if (!other) continue;
            others.push({
              reason: group.reason,
              confidence: group.confidence,
              target: "draft",
              id: other.id,
              title: other.title,
              startsAt: other.startsAt,
              startsAtTz: other.startsAtTz,
              tripId: null,
              tripTitle: null,
            });
            continue;
          }
          const row = bookingsById.get(bookingIdOf(otherKey));
          if (!row) continue;
          others.push({
            reason: group.reason,
            confidence: group.confidence,
            target: "booking",
            id: row.id,
            title: row.title,
            startsAt: row.starts_at,
            startsAtTz: row.starts_at_tz,
            tripId: row.trip_id,
            tripTitle: liveTrips.get(row.trip_id)?.title ?? null,
          });
        }
        if (others.length > 0) byDraft.set(draftId, others);
      }
    }
    return byDraft;
  }

  /**
   * Refuses an accept that would re-import something the household already
   * has, unless the reviewer has explicitly said to do it anyway.
   *
   * Only `high` confidence blocks. The weakest rule — same place, same minute,
   * different names — is exactly the shape of two hotel rooms for one family,
   * and a queue that refused to import the second room until you argued with
   * it would be worse than one that never checked. Medium matches are reported
   * by `listPending` and left to the reviewer's eye.
   */
  private async assertNoDuplicates(
    drafts: DraftBooking[],
    trip: Trip | null,
    allowDuplicates: boolean,
  ): Promise<void> {
    if (allowDuplicates) return;

    const kinds = new Set(drafts.map((draft) => draft.kind));
    const rows = trip
      ? (await this.all<BookingCandidateRow>(
          `SELECT id, trip_id, kind, title, location, starts_at, starts_at_tz, confirmation_number
             FROM booking
            WHERE {scope} AND trip_id = ?2 AND status != 'cancelled'`,
          trip.id,
        )).filter((row) => kinds.has(row.kind as DraftBooking["kind"]))
      : [];

    const existing = await Promise.all(
      rows.map(async (row) => ({
        id: bookingKey(row.id),
        kind: row.kind,
        title: row.title,
        location: row.location,
        startsAt: row.starts_at,
        confirmation: await openConfirmation(this.ring, row.confirmation_number),
      } satisfies DuplicateCandidate)),
    );

    const accepting = new Set(drafts.map((draft) => draftKey(draft.id)));
    let redundant = 0;
    let againstExisting = false;
    for (const group of findDuplicates([...drafts.map(draftCandidate), ...existing])) {
      if (group.confidence !== "high") continue;
      const fromBatch = group.bookingIds.filter((key) => accepting.has(key)).length;
      if (fromBatch === 0) continue;
      if (fromBatch < group.bookingIds.length) {
        // The group also holds a booking already on the trip: every draft in
        // it is a re-import of something the household has.
        redundant += fromBatch;
        againstExisting = true;
      } else {
        // The batch repeating itself. One of them is the booking they all
        // wanted to be; the rest are the duplicates.
        redundant += fromBatch - 1;
      }
    }

    if (redundant === 0) return;
    const one = redundant === 1;
    const where = againstExisting && trip
      ? `already on ${trip.title}`
      : "already in this selection";
    throw new ConflictError(
      `${redundant} of these imports ${one ? "looks" : "look"} like ` +
        `${one ? "a booking" : "bookings"} ${where}. Import anyway to keep both copies.`,
    );
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
    const people = await this.peopleForMatching();
    for (const draft of drafts) {
      const extracted = asRecord(draft.extracted);
      const details = parseDetails(
        draft.kind,
        importDetails(draft.kind, draft.title, extracted.details),
      );
      // Non-integer AND negative both fall to null. A negative extracted cost
      // is the model reading a refund line or a credit as the total; storing
      // it would subtract from the trip's spend rollup, which the Cost
      // Analysis tab presents as money spent (see assertNonNegativeAmount in
      // repos/validation.ts for the decision). Dropped rather than rejected
      // for the same reason bookableDraftTiming degrades: an unimportable
      // draft is worse for the reviewer than an imported one missing a price.
      const costCents =
        typeof extracted.costCents === "number" &&
        Number.isInteger(extracted.costCents) &&
        extracted.costCents >= 0
          ? extracted.costCents
          : null;
      const timing = bookableDraftTiming(draft);
      const personIds = matchedPersonIds(
        extracted.travelerNames,
        extracted.travelerEmails,
        people,
      );

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
                ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'booked', ?, ?
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
          timing.startsAt,
          timing.startsAtTz,
          timing.endsAt,
          timing.endsAtTz,
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
    }
    return statements;
  }

  private async peopleForMatching(): Promise<Array<{
    id: string;
    displayName: string;
    email: string | null;
  }>> {
    const rows = await this.all<{ id: string; display_name: string; email: string | null }>(
      `SELECT id, display_name, email FROM person WHERE {scope}`,
    );
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.email,
    }));
  }
}

type BookingCandidateRow = {
  id: string;
  trip_id: string;
  kind: string;
  title: string;
  location: string | null;
  starts_at: string | null;
  starts_at_tz: string | null;
  confirmation_number: string | null;
};

/**
 * Drafts and bookings are matched in one pass, so their ids share a namespace
 * for the length of that call. Both are generated by newId() and cannot
 * actually collide, but an unprefixed mix would make "is this member a draft?"
 * a lookup against two maps whose answer changes silently the day a draft id
 * is reused as a booking id. The prefix makes it a property of the key.
 */
function draftKey(id: string): string {
  return `d:${id}`;
}
function bookingKey(id: string): string {
  return `b:${id}`;
}
function draftIdOf(key: string): string | null {
  return key.startsWith("d:") ? key.slice(2) : null;
}
function bookingIdOf(key: string): string {
  return key.startsWith("b:") ? key.slice(2) : key;
}

function draftCandidate(draft: DraftBooking): DuplicateCandidate {
  return {
    id: draftKey(draft.id),
    kind: draft.kind,
    title: draft.title,
    location: draft.location,
    startsAt: draft.startsAt,
    // Draft confirmation numbers are stored in the clear (draft_booking has no
    // envelope column) — only an accepted booking's is encrypted.
    confirmation: draft.confirmationNumber,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function matchedPersonIds(
  names: unknown,
  emails: unknown,
  people: Array<{ id: string; displayName: string; email: string | null }>,
): string[] {
  const ids = new Set<string>();
  const peopleByName = new Map(
    people.map((person) => [normalizeName(person.displayName), person.id]),
  );
  const peopleByEmail = new Map(
    people
      .filter((person): person is typeof person & { email: string } => !!person.email)
      .map((person) => [normalizeEmail(person.email), person.id]),
  );
  // Names deliberately win. Forwarded mail frequently contains a traveler's
  // work address while their profile contains a personal address.
  for (const candidate of Array.isArray(names) ? names : []) {
    if (typeof candidate !== "string") continue;
    const personId = peopleByName.get(normalizeName(candidate));
    if (personId) ids.add(personId);
  }
  for (const candidate of Array.isArray(emails) ? emails : []) {
    if (typeof candidate !== "string") continue;
    const personId = peopleByEmail.get(normalizeEmail(candidate));
    if (personId) ids.add(personId);
  }
  return [...ids];
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
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
  "startsAt" | "startsAtTz" | "endsAt" | "endsAtTz" | "extracted"
>): DateRange | undefined {
  const start = localDate(draft.startsAt, draft.startsAtTz);
  const end = localDate(draft.endsAt, draft.endsAtTz);
  const details = asRecord(asRecord(draft.extracted).details);
  const detailStart =
    typeof details.checkInDate === "string" && isValidCalendarDate(details.checkInDate)
      ? details.checkInDate
      : undefined;
  const detailEnd =
    typeof details.checkOutDate === "string" && isValidCalendarDate(details.checkOutDate)
      ? details.checkOutDate
      : undefined;
  if (!start && !end && !detailStart && !detailEnd) return undefined;
  const startsOn = start ?? detailStart ?? end ?? detailEnd!;
  const endsOn = end ?? detailEnd ?? start ?? detailStart!;
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

/**
 * The timing an accepted draft may be written to `booking` with.
 *
 * This path does NOT go through `BookingRepo.create()` — it builds its INSERTs
 * by hand so the whole review (trip, bookings, draft resolution) commits as one
 * D1 batch — so it is the one write path that would otherwise miss the
 * repository-level instant rules entirely.
 *
 * It DEGRADES rather than throws, which is the opposite of what a route-driven
 * write does, and deliberately so. A draft's timestamps come from an AI
 * extraction or a calendar attachment, both written before these rules
 * tightened; the review queue offers no way to edit a draft's times, so
 * refusing the accept would strand the reviewer with a booking they can only
 * dismiss. Dropping an unusable instant (and its now-orphaned zone) leaves a
 * booking that is correct in everything else and merely missing a time — the
 * same "degrade the one bad value, keep the row" policy `BookingRepo.listByTrip`
 * and `ItineraryRepo.group()` apply on the read side. Anything created since
 * `DraftBookingRepo.createMany` started validating drafts already satisfies
 * this, so in practice it only ever fires for legacy rows.
 */
function bookableDraftTiming(draft: DraftBooking): {
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
} {
  const usable = (at: string | null, tz: string | null): string | null =>
    at !== null && tz !== null && isValidInstant(at) ? at : null;
  const startsAt = usable(draft.startsAt, draft.startsAtTz);
  let endsAt = usable(draft.endsAt, draft.endsAtTz);
  // An end before its start is the extraction misreading a return leg, not a
  // fact about the reservation. The start is the load-bearing half — it is
  // what the day view groups on — so the end is what goes.
  if (startsAt !== null && endsAt !== null && Date.parse(endsAt) < Date.parse(startsAt)) {
    endsAt = null;
  }
  return {
    startsAt,
    startsAtTz: startsAt === null ? null : draft.startsAtTz,
    endsAt,
    endsAtTz: endsAt === null ? null : draft.endsAtTz,
  };
}

/**
 * Delegates to the shared repository rule so that a trip created from the
 * import queue and a trip created through `POST /api/trips` cannot disagree
 * about what a date range is. This function used to be a private third copy of
 * those same two checks.
 */
function validateTripDates(startsOn: string | null, endsOn: string | null): void {
  assertTripDateRange(startsOn, endsOn);
}
