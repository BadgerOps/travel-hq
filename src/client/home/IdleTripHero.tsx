import { Link } from "wouter";
import type { Trip } from "../api/types.js";
import { daysUntil } from "../lib/dates.js";

export function IdleTripHero({ trip, today }: { trip: Trip; today: string }) {
  const days = trip.startsOn ? daysUntil(trip.startsOn, today) : null;

  return (
    <div className="hero-idle" style={{ flex: "1.5 1 480px" }}>
      <h6 className="text-muted">
        {days === null ? "Next trip" : `Next trip · in ${days} days`}
      </h6>
      <div style={{ fontSize: 18, fontWeight: 500, marginTop: 8 }}>{trip.title}</div>
      {trip.destination && <p className="text-muted">{trip.destination}</p>}
      <Link href={`/trips/${trip.id}`} className="btn btn-primary">
        Trip details
      </Link>
    </div>
  );
}
