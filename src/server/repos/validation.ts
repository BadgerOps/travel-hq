import { ValidationError } from "./base.js";
import { isValidCalendarDate, isValidInstant, isValidTimezone } from "../time.js";

/**
 * The repository layer's shared temporal and numeric assertions.
 *
 * `time.ts` answers "is this string a date/an instant?" and deliberately knows
 * nothing about HTTP or about this layer's error vocabulary -- it sits below
 * the repositories and is imported by `ingest/` too, which must not drag the
 * tenancy layer in behind it. This module is the thin adapter that turns those
 * predicates into `ValidationError` (400 via `mapError`), so that every write
 * path phrases the same rejection the same way.
 *
 * It exists because the alternative was demonstrably worse: `TripRepo.update`
 * validated calendar shape and ordering while `TripRepo.create` validated
 * nothing, `ImportReviewRepo` carried its own private third copy of the same
 * two rules, and `ChecklistRepo`/`PersonRepo` had no date validation at all.
 * A rule that only one of a table's write paths enforces is not a rule; it is
 * a race between which path the caller happens to use.
 *
 * REPOSITORIES ARE THE ENFORCEMENT POINT, not the Zod route schemas. The route
 * schemas mirror these checks where it is cheap (a malformed request should
 * fail at the boundary with a field-level message), but the email-import path
 * writes bookings and trips without ever passing through a route, so anything
 * only the boundary enforces is not enforced.
 */

/**
 * A calendar date: exactly `YYYY-MM-DD`, and a day that exists.
 *
 * `null`/`undefined` pass: "no date" is a legitimate stored value for every
 * column this guards (a trip with no dates yet, a person with no DOB on file).
 * Clearing a value is the tri-state's `null`, which is not the same thing as
 * supplying a broken one.
 */
export function assertCalendarDate(
  field: string,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !isValidCalendarDate(value)) {
    throw new ValidationError(`${field} must be a well-formed YYYY-MM-DD date`);
  }
}

/**
 * A calendar-date range that runs forwards. Equal endpoints are fine -- a
 * day trip starts and ends on the same date.
 *
 * Both arguments must already have passed `assertCalendarDate`, which is what
 * makes the plain string comparison correct: `YYYY-MM-DD` sorts
 * lexicographically exactly as it sorts chronologically, which is also why
 * every `ORDER BY starts_on` in this codebase works without a date function.
 */
export function assertDateOrder(
  startField: string,
  endField: string,
  start: string | null | undefined,
  end: string | null | undefined,
): void {
  if (!start || !end) return;
  if (start > end) {
    throw new ValidationError(`${startField} must be on or before ${endField}`);
  }
}

/**
 * Both halves of a trip's date range, in one call, so that `TripRepo.create`,
 * `TripRepo.update` and `ImportReviewRepo.createTripFromDrafts` cannot enforce
 * three subtly different versions of the same rule again.
 *
 * Callers pass the EFFECTIVE pair. For an update that means the stored value
 * wherever the patch is silent: patching only `endsOn` to a date before a
 * stored `startsOn` is just as inverted a range as sending both, and only the
 * repository can see the stored half.
 */
export function assertTripDateRange(
  startsOn: string | null | undefined,
  endsOn: string | null | undefined,
): void {
  assertCalendarDate("startsOn", startsOn);
  assertCalendarDate("endsOn", endsOn);
  assertDateOrder("startsOn", "endsOn", startsOn, endsOn);
}

/**
 * An unambiguous instant: a full ISO-8601 date-time carrying `Z` or an
 * explicit offset. See `isValidInstant` in `time.ts` for what that rejects and
 * why a wall clock without an offset is not a moment in time.
 */
export function assertInstant(
  field: string,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !isValidInstant(value)) {
    throw new ValidationError(
      `${field} must be an ISO-8601 instant with an explicit offset or Z`,
    );
  }
}

/**
 * An instant range that runs forwards. Equal endpoints are fine -- a
 * zero-length event is odd but not corrupt, and rounding a short activity to
 * the minute produces one.
 *
 * Compared as parsed milliseconds rather than as strings: two instants for the
 * same moment can be written with different offsets (`…T10:00:00+05:00` and
 * `…T05:00:00Z`), so string ordering would report a perfectly ordinary
 * cross-timezone flight as inverted.
 */
export function assertInstantOrder(
  startField: string,
  endField: string,
  start: string | null | undefined,
  end: string | null | undefined,
): void {
  if (!start || !end) return;
  if (Date.parse(start) > Date.parse(end)) {
    throw new ValidationError(`${startField} must be at or before ${endField}`);
  }
}

/**
 * The two instants a scheduled thing carries, and the zones without which
 * neither is a moment in time.
 *
 * Structurally typed rather than tied to one input shape so that every write
 * path can hand over its EFFECTIVE pair: `BookingRepo.update` and
 * `DraftBookingRepo.update` both merge a patch over a stored row before
 * checking, because clearing `startsAtTz` while a stored `startsAt` remains is
 * exactly as broken as posting a timestamp with no zone, and only the
 * repository can see the stored half. `null` and `undefined` both mean "not
 * set" here — the tri-state distinction matters to the SET clause, not to this
 * check.
 */
export type BookingTiming = {
  startsAt?: string | null;
  startsAtTz?: string | null;
  endsAt?: string | null;
  endsAtTz?: string | null;
};

/**
 * A timestamp without its IANA zone renders every cross-timezone itinerary
 * wrong, which is most flights. Reject the unpaired case at the boundary
 * rather than discovering it in the UI.
 *
 * Also rejects a timestamp `Date.parse` can't understand and a timezone
 * `Intl.DateTimeFormat` doesn't recognize. An unparseable timestamp must never
 * reach `localDateOf()` in ItineraryRepo, where it would throw on every future
 * read of that trip's day view.
 */
export function assertTimezonePaired(input: BookingTiming): void {
  if (input.startsAt) {
    if (!input.startsAtTz) {
      throw new ValidationError("startsAt requires startsAtTz (an IANA timezone)");
    }
    assertInstant("startsAt", input.startsAt);
    if (!isValidTimezone(input.startsAtTz)) {
      throw new ValidationError("startsAtTz must be a valid IANA timezone");
    }
  }
  if (input.endsAt) {
    if (!input.endsAtTz) {
      throw new ValidationError("endsAt requires endsAtTz (an IANA timezone)");
    }
    assertInstant("endsAt", input.endsAt);
    if (!isValidTimezone(input.endsAtTz)) {
      throw new ValidationError("endsAtTz must be a valid IANA timezone");
    }
  }
}

/**
 * Everything a booking's two instants must satisfy, in the order the checks
 * make sense: each one has to BE an instant with a zone before asking whether
 * one precedes the other.
 *
 * A flight landing before it took off used to pass every write path — and then
 * rendered as a negative duration, sorted its trip's day view against itself,
 * and gave `ItineraryRepo.group()` a booking whose "ongoing" days run
 * backwards.
 *
 * This lives here rather than in `repos/booking.ts` (where it was born) or in
 * a route schema because it now has THREE callers that must not drift:
 * `BookingRepo.create`, `BookingRepo.update`, and `DraftBookingRepo.update` —
 * the last of which exists so a reviewer can correct an extracted time before
 * it becomes a booking, and would be worse than useless if it let a value
 * through that the accept would then have to silently drop.
 */
export function assertBookingTiming(input: BookingTiming): void {
  assertTimezonePaired(input);
  assertInstantOrder("startsAt", "endsAt", input.startsAt, input.endsAt);
}

/**
 * A whole, non-negative amount.
 *
 * DECISION (issue #23): negative `costCents` and `pointsUsed` are NOT
 * supported. They are rejected rather than stored as adjustments.
 *
 * The reasoning, so nobody has to re-derive it: every consumer of these two
 * columns presents them as spend and usage, not as a signed ledger.
 * `RollupRepo` sums them into a trip total, the Cost Analysis tab renders that
 * total as money spent and divides it per traveler and per day, and the
 * booking dialog's cost field is a single positive amount with no sign
 * control. A refund or a points redemption reversal therefore has nowhere to
 * live: it would silently reduce a total that every label in the UI calls
 * "cost", and there is no repair path -- no screen shows you which negative
 * row is dragging the number down. Supporting adjustments properly means a
 * separate signed adjustments concept with its own UI, not a minus sign
 * smuggled into a booking. Until that exists, the honest answer to a negative
 * amount is a 400.
 */
export function assertNonNegativeAmount(
  field: string,
  value: number | null | undefined,
): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number`);
  }
  if (value < 0) {
    throw new ValidationError(`${field} must not be negative`);
  }
}
