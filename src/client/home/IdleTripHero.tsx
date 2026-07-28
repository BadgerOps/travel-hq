import { Link } from "wouter";
import type { Booking, Person, Trip } from "../api/types.js";
import { daysUntil, formatDateRange } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";

function kickerText(startsOn: string | null, today: string): string {
  if (!startsOn) return "Next trip";
  const days = daysUntil(startsOn, today);
  if (days <= 0) return "Next trip";
  if (days === 1) return "Next trip · tomorrow";
  return `Next trip · in ${days} days`;
}

/**
 * The 2a idle hero: kicker with countdown, trip title, human dates +
 * destination, then whatever the booking data can honestly say — traveler
 * chips and an open-items line. `bookings` defaults to empty so the hero
 * degrades to the dates-only shape when Home's per-trip fetch failed (or a
 * caller has nothing to give); the missing lines are simply omitted.
 */
export function IdleTripHero({
  trip,
  today,
  people = [],
  bookings = [],
}: {
  trip: Trip;
  today: string;
  people?: Pick<Person, "id" | "displayName">[];
  bookings?: Booking[];
}) {
  const travelerIds = new Set(bookings.flatMap((b) => b.personIds));
  const travelers = people.filter((p) => travelerIds.has(p.id));
  const booked = bookings.filter((b) => b.status === "booked").length;
  const open = bookings.length - booked;

  const dates = trip.startsOn ? formatDateRange(trip.startsOn, trip.endsOn, today) : null;
  const meta = [dates, trip.destination].filter(Boolean).join(" · ");

  return (
    <div className="hero-idle hero-main">
      <div className="hero-kicker-row">
        <h6 className="text-muted">{kickerText(trip.startsOn, today)}</h6>
      </div>
      <div className="hero-trip-title">{trip.title}</div>
      {meta && <p className="hero-trip-meta">{meta}</p>}
      {travelers.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <PersonChips people={travelers} />
        </div>
      )}
      {bookings.length > 0 && (
        <p className="hero-trip-sub">
          {booked} booked{open > 0 ? ` · ${open} to go` : ""}
        </p>
      )}
      <div className="hero-actions">
        <Link href={`/trips/${trip.id}`} className="btn btn-primary">
          Trip details
        </Link>
      </div>
    </div>
  );
}
