import { BookingAwareRepo, toBooking } from "./booking.js";
import type { Booking, BookingRow } from "./booking.js";
import { NotFoundError } from "./base.js";

export type ItineraryDay = {
  /** Calendar date in the event's own local timezone, as YYYY-MM-DD. */
  date: string;
  bookings: Booking[];
};

export class ItineraryRepo extends BookingAwareRepo {
  /**
   * The day-by-day agenda for one family member on one trip.
   *
   * Existence-checks the trip and the person first, the same way
   * RollupRepo.forTrip and BookingRepo.listByTrip do: without it, an unknown
   * trip id or a person id outside this household both silently answer
   * `200 []`, indistinguishable from "trip/person exists, nothing
   * scheduled". DayView documents that this 404s — it must actually do so,
   * even though today's only caller (TripDetail's Promise.all) never
   * reaches this repo with a bad id.
   */
  async forPerson(tripId: string, personId: string): Promise<ItineraryDay[]> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) throw new NotFoundError("Person not found in this household");

    const rows = await this.all<BookingRow>(
      `SELECT b.*
         FROM booking b
         JOIN booking_person bp ON bp.booking_id = b.id
        WHERE {scope}
          AND b.trip_id = ?2
          AND bp.person_id = ?3
          AND b.status != 'cancelled'
          AND b.starts_at IS NOT NULL
        ORDER BY b.starts_at`,
      tripId,
      personId,
    );
    return this.group(rows);
  }

  /**
   * The whole trip's agenda, regardless of who is on each booking.
   *
   * Existence-checks the trip first, the same way BookingRepo.listByTrip
   * does (I5) — see forPerson above for why.
   */
  async forTrip(tripId: string): Promise<ItineraryDay[]> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const rows = await this.all<BookingRow>(
      `SELECT b.*
         FROM booking b
        WHERE {scope}
          AND b.trip_id = ?2
          AND b.status != 'cancelled'
          AND b.starts_at IS NOT NULL
        ORDER BY b.starts_at`,
      tripId,
    );
    return this.group(rows);
  }

  /**
   * C1: a row that can't be formatted -- an unparseable `starts_at` or an
   * IANA zone `Intl.DateTimeFormat` doesn't recognize, most likely from a
   * hand-edited row, since `BookingRepo.create()` and its repo-level
   * `assertTimezonePaired()` now reject both at write time -- is skipped
   * and logged rather than allowed to throw and take down the *entire* day
   * view. One poisoned row must degrade to one missing entry, not a 500 on
   * every future read of the trip.
   *
   * This same try/catch also covers a row whose confirmation-number
   * envelope can't be decrypted (wrong/rotated-out key, corruption): same
   * failure mode, same policy -- degrade that row, keep the rest of the
   * view intact.
   *
   * WARNING -- asymmetric with the rest of the app, by omission rather than
   * design: a booking row with an unparseable IANA zone is skipped here but
   * is still returned by BookingRepo.listByTrip and still counted by
   * RollupRepo.forTrip's SQL (which never touches `localDateOf` at all).
   * Today `assertTimezonePaired` in booking.ts validates every row at write
   * time, so this asymmetry is unreachable through the API -- but the
   * moment any write path bypasses that validation (a bulk/email-import
   * insert, for instance), the day view, Overview, and the cost panel will
   * disagree about which bookings exist for the same trip. Whether the fix
   * is "skip everywhere" or "surface as broken everywhere" is a decision
   * for whoever builds that import path, not something to default silently
   * here. See the matching note on BookingRepo.listByTrip and
   * docs/BACKLOG.md.
   */
  private async group(rows: BookingRow[]): Promise<ItineraryDay[]> {
    const byDate = new Map<string, Booking[]>();
    const peopleByBooking = await this.personIdsByBooking(rows.map((row) => row.id));

    const converted = await Promise.all(rows.map(async (r) => {
      let date: string;
      let booking: Booking;
      try {
        // starts_at is non-null by the query; its tz is guaranteed paired
        // with it by BookingRepo.create() for any row written through the
        // API -- but not for a row inserted directly by hand.
        date = localDateOf(r.starts_at!, r.starts_at_tz ?? "UTC");
        booking = await toBooking(this.ring, r, peopleByBooking.get(r.id) ?? []);
      } catch (err) {
        console.error(
          `[ItineraryRepo] skipping booking ${r.id} in day view: cannot format row`,
          err,
        );
        return null;
      }
      return { date, booking };
    }));

    for (const item of converted) {
      if (!item) continue;
      const { date, booking } = item;
      const list = byDate.get(date) ?? [];
      list.push(booking);
      byDate.set(date, list);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bookings]) => ({ date, bookings }));
  }
}

/**
 * The calendar date an event belongs to is its date in ITS OWN timezone — not
 * UTC, and not the viewer's. A dinner at 22:00 in Boise is Thursday's dinner
 * even though it is Friday 04:00 UTC, and a red-eye departing Boise late
 * Thursday belongs to Thursday even though it lands Friday in another zone.
 *
 * `en-CA` is used because it formats natively as YYYY-MM-DD.
 */
function localDateOf(utcInstant: string, ianaZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcInstant));
}
