import { Link } from "wouter";
import { MapPin } from "@phosphor-icons/react";
import type { Booking, Person, Trip } from "../api/types.js";
import { countdownLabel } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";

export function TripCard({
  trip,
  bookings,
  people,
  today,
}: {
  trip: Trip;
  bookings: Booking[];
  people: Pick<Person, "id" | "displayName">[];
  today: string;
}) {
  const booked = bookings.filter((b) => b.status === "booked").length;
  const remaining = bookings.length - booked;
  const countdown = countdownLabel(trip.startsOn, trip.endsOn, today);
  const travelerIds = new Set(bookings.flatMap((b) => b.personIds));
  const travelers = people.filter((p) => travelerIds.has(p.id));

  return (
    <Link
      href={`/trips/${trip.id}`}
      className="card elev-sm"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="card-title">{trip.title}</span>
        <span
          className={countdown === "Today" ? "tag tag-accent" : "tag tag-neutral"}
          style={{ marginLeft: "auto" }}
        >
          {countdown}
        </span>
      </div>

      {trip.startsOn && (
        <div className="card-meta">
          {trip.startsOn}
          {trip.endsOn && trip.endsOn !== trip.startsOn ? ` – ${trip.endsOn}` : ""}
        </div>
      )}

      <div className="card-meta">
        {trip.destination && (
          <>
            <MapPin size={12} />
            <span>{trip.destination}</span>
          </>
        )}
        <PersonChips people={travelers} />
        <span style={{ marginLeft: "auto" }}>
          {booked} booked{remaining > 0 ? ` · ${remaining} to go` : ""}
        </span>
      </div>
    </Link>
  );
}
