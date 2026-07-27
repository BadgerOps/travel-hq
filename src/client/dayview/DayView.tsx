import { useEffect, useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { Booking, ItineraryDay, Person } from "../api/types.js";
import { PersonFilter } from "./PersonFilter.js";
import { DatePager } from "./DatePager.js";
import { SharedAgenda } from "./SharedAgenda.js";
import "./dayview.css";

/**
 * The day-view boundary.
 *
 * Today it always renders shape 1c (SharedAgenda). Shape 1d, the
 * column-per-person grid, is backlogged as a desktop-only toggle — when it
 * lands, it swaps in here and callers do not change. Keep shape-specific
 * concerns out of this component's props.
 */
export function DayView({
  tripId,
  people,
  api,
  onBookingClick,
  tripTitle,
}: {
  tripId: string;
  people: Person[];
  api: typeof defaultApi;
  onBookingClick?: (booking: Booking) => void;
  /** Names the header kicker ("Wedding · day by day"). Optional so callers
   * that only have an id still render — the kicker falls back to plain
   * "Day by day". */
  tripTitle?: string;
}) {
  const [days, setDays] = useState<ItineraryDay[] | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  // The calendar date, not the array index: an index survives a refetch only
  // by accident of position. Filtering to a person whose days are a subset
  // of the current view shifts every later date down the array, so clamping
  // the *index* lands on whatever date happens to occupy that slot in the
  // new (shorter) array — e.g. viewing Oct 11 unfiltered and filtering to
  // someone whose only days are Oct 9-10 silently lands on Oct 10 instead of
  // signalling that Oct 11 fell out of view. Keeping the date and
  // re-deriving the index below is what makes "stay on today unless today
  // truly isn't available" the actual behavior.
  const [date, setDate] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // Filtering refetches rather than filtering client-side: the server owns the
    // booking_person join and the timezone-correct day grouping, and re-deriving
    // either here is exactly where an off-by-one-day bug would appear.
    api.trips
      .itinerary(tripId, personId ?? undefined)
      .then((d) => {
        if (cancelled) return;
        setDays(d);
        setDate((current) => {
          if (current && d.some((day) => day.date === current)) return current;
          // The previously-viewed date isn't in the new set (first load, or
          // it was filtered out entirely): fall back to the nearest
          // available day rather than always snapping to the first. YYYY-MM-DD
          // strings sort chronologically, so plain string comparison works.
          if (current) return nearestDate(d, current);
          return d[0]?.date ?? null;
        });
      })
      // Same rule as TripDetail: an unknown trip id (or a person id that is
      // not in this household) 404s, and without this the view is stuck on
      // "Loading…" with an unhandled rejection behind it.
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, tripId, personId]);

  // Failed load ≠ empty state: an itinerary that errored must say so
  // (role="alert"), never masquerade as "nothing scheduled".
  if (failed) {
    return (
      <p className="text-muted" role="alert">
        Couldn't load this trip's itinerary.
      </p>
    );
  }
  if (days === null) return <p className="text-muted">Loading…</p>;

  const index = date ? Math.max(0, days.findIndex((d) => d.date === date)) : 0;
  const current = days[index];

  return (
    <div className="dayview">
      <div className="dayview-header">
        <div className="dayview-title-group">
          <div className="dayview-kicker">
            {tripTitle ? `${tripTitle} · day by day` : "Day by day"}
          </div>
          {current && <h3>{longDayLabel(current.date)}</h3>}
        </div>
        <DatePager
          dates={days.map((d) => d.date)}
          index={index}
          onChange={(i) => setDate(days[i]?.date ?? null)}
        />
      </div>

      {/* Rendered even when the filtered view has no days: the selected chip
          is the only way back to the whole-family view. */}
      <PersonFilter people={people} selected={personId} onSelect={setPersonId} />

      {current ? (
        <SharedAgenda
          bookings={current.bookings}
          people={people}
          onBookingClick={onBookingClick}
        />
      ) : (
        <p className="text-muted">
          Nothing scheduled{personId ? " for this traveller" : ""} on this trip yet.
        </p>
      )}
    </div>
  );
}

/** "Friday, October 9" — the header's h3. UTC for the same plain-calendar-date
 * reason as everywhere else in this folder. */
function longDayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** The available day closest to `target` (a YYYY-MM-DD string), by calendar
 * distance rather than array position. `days` sorts chronologically already
 * (ItineraryRepo.group), but this doesn't rely on that — it just compares
 * every candidate. Returns null for an empty list. */
function nearestDate(days: ItineraryDay[], target: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const { date } of days) {
    const distance = Math.abs(daysBetween(date, target));
    if (distance < bestDistance) {
      best = date;
      bestDistance = distance;
    }
  }
  return best;
}

function daysBetween(a: string, b: string): number {
  const MS_PER_DAY = 86_400_000;
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY;
}
