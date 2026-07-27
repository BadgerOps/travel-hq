import { Link } from "wouter";
import { MapPin } from "@phosphor-icons/react";
import type { Booking, Person, Trip } from "../api/types.js";
import { formatDateRange, formatDayLabel, resolveTripState, tripStateBadge } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";
import { TripCoverPhoto } from "../components/TripCoverPhoto.js";

/**
 * The calendar date a booking happens on, in its own timezone — the same
 * grouping rule the server's itinerary endpoint applies. The teaser has only
 * the flat bookings list to work from (fetching every trip's itinerary would
 * double the dashboard's request count), so it re-derives the local date here.
 */
function localDateOf(b: Booking): string | null {
  if (!b.startsAt) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: b.startsAtTz ?? "UTC",
  }).format(new Date(b.startsAt));
}

type TeaserRow = { date: string; bookings: Booking[] };

/** First three calendar days that have dated bookings, ascending. */
function teaserRows(bookings: Booking[]): TeaserRow[] {
  const byDate = new Map<string, Booking[]>();
  for (const b of bookings) {
    if (b.status === "cancelled") continue;
    const date = localDateOf(b);
    if (!date) continue;
    const row = byDate.get(date);
    if (row) row.push(b);
    else byDate.set(date, [b]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 3)
    .map(([date, dayBookings]) => ({
      date,
      bookings: dayBookings.sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? "")),
    }));
}

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
  // State-aware: an explicitly cancelled/complete/forced-active trip names
  // its state; a planning trip keeps the countdown language.
  const badge = tripStateBadge(trip, today);
  const state = resolveTripState(trip, today);
  const travelerIds = new Set(bookings.flatMap((b) => b.personIds));
  const travelers = people.filter((p) => travelerIds.has(p.id));

  const rows = teaserRows(bookings);
  // A plan with nothing in it yet gets its status spelled out where the
  // teaser would sit — the 2a draft-card treatment. Finished or cancelled
  // trips get neither: "0 booked" is not a blocker on a trip that happened.
  const showBlockers = rows.length === 0 && bookings.length === 0 && state === "upcoming";

  return (
    <Link
      href={`/trips/${trip.id}`}
      className="card photo-card"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <div className="cover">
        <TripCoverPhoto photoUrl={trip.photoUrl} tripId={trip.id} />
        <span
          className={`cover-tag tag ${
            badge === "Today" || badge === "Active" ? "tag-accent" : "tag-neutral"
          }`}
        >
          {badge}
        </span>
      </div>

      <div className="photo-card-body">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <span className="card-title">{trip.title}</span>
          {trip.startsOn && (
            <span className="card-date">
              {formatDateRange(trip.startsOn, trip.endsOn, today)}
            </span>
          )}
        </div>

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

        {rows.length > 0 && (
          <div className="day-teaser">
            {rows.map((row) => (
              <div key={row.date} className="day-teaser-row">
                <span className="day">{formatDayLabel(row.date)}</span>
                <span className="what">
                  {row.bookings.map((b, i) => (
                    <span key={b.id}>
                      {i > 0 && " · "}
                      {b.status === "booked" ? (
                        b.title
                      ) : (
                        <span className="warning">{b.title}</span>
                      )}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}

        {showBlockers && (
          <div className="day-teaser">
            <div className="day-teaser-row">
              <span className="what">
                0 booked · {trip.startsOn ? "dates penciled in" : "no dates yet"}
              </span>
            </div>
          </div>
        )}
      </div>
    </Link>
  );
}
