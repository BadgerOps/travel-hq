import { useEffect, useState } from "react";
import { api as defaultApi } from "../api/client.js";
import { useIdentity } from "../api/identity.js";
import type { Booking, ItineraryDay, Person, Trip } from "../api/types.js";
import {
  compareTrips,
  daysUntil,
  formatLongDate,
  resolveTripState,
  tripStateBadge,
} from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { ActiveTripHero } from "../home/ActiveTripHero.js";
import { IdleTripHero } from "../home/IdleTripHero.js";
import { NextBestActions } from "../home/NextBestActions.js";
import { TripCard } from "../home/TripCard.js";
import { PendingImportCard } from "../imports/PendingImportCard.js";
import "../home/home.css";

type Api = typeof defaultApi;

function greeting(now: Date, name: string | null): string {
  const h = now.getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

/**
 * `Identity` carries an email, not a display name — there is no name column on
 * `user`. The local part is the closest honest thing to hand, and matching the
 * email against `person.display_name` would be a guess (people rows are family
 * members, not accounts). Before /api/me resolves this is null and the
 * greeting simply omits the name rather than flashing a placeholder.
 */
function displayNameFor(email: string | undefined): string | null {
  if (!email) return null;
  const local = email.split("@")[0] ?? "";
  if (!local) return null;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

/** "Wedding trip · today" / "Wedding trip · in 12 days" — the header tag. */
function countdownTagText(trip: Trip, today: string): string {
  const state = resolveTripState(trip, today);
  if (state === "active") return `${trip.title} · today`;
  if (trip.startsOn) {
    const days = daysUntil(trip.startsOn, today);
    if (days === 1) return `${trip.title} · tomorrow`;
    if (days > 1) return `${trip.title} · in ${days} days`;
  }
  return `${trip.title} · ${tripStateBadge(trip, today).toLowerCase()}`;
}

export function Home({
  api = defaultApi,
  today = todayIso(),
  now = new Date(),
}: {
  api?: Api;
  today?: string;
  /** Separate from `today`: the hero compares instants, the grid compares dates. */
  now?: Date;
}) {
  const identity = useIdentity();
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [bookingsByTrip, setBookingsByTrip] = useState<Record<string, Booking[]>>({});
  const [days, setDays] = useState<ItineraryDay[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The one resolver decides everything on this screen: which trip is the
  // hero, what the grid shows, and in what order. A cancelled trip is not
  // part of the dashboard at all — it lives on the Trips page (last, with
  // its badge) until someone restores it.
  const visible = trips?.filter((t) => resolveTripState(t, today) !== "cancelled") ?? [];
  const active = visible.find((t) => resolveTripState(t, today) === "active") ?? null;
  const upcoming = visible
    .filter((t) => resolveTripState(t, today) === "upcoming")
    .sort((a, b) => compareTrips(a, b, today));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, p] = await Promise.all([api.trips.list(), api.people.list()]);
        if (cancelled) return;
        setTrips(t);
        setPeople(p);

        const dashboard = t.filter((trip) => resolveTripState(trip, today) !== "cancelled");
        const current = dashboard.find((trip) => resolveTripState(trip, today) === "active");

        // Every visible trip's flat bookings list in parallel (small N):
        // it feeds each card's day-by-day teaser and "n booked · m to go"
        // count, and the idle hero's chips. A failed fetch degrades that one
        // trip to a card without a teaser instead of erroring the page.
        const perTrip = Promise.all(
          dashboard.map(async (trip) => {
            try {
              return [trip.id, await api.trips.bookings(trip.id)] as const;
            } catch {
              return [trip.id, [] as Booking[]] as const;
            }
          }),
        );
        // The itinerary is a separate call for a separate purpose: it is
        // day-grouped in each booking's own timezone and drives the active
        // hero's "next up" — the flat list above must not be scoped to today.
        const itinerary = current
          ? api.trips.itinerary(current.id).catch(() => [] as ItineraryDay[])
          : Promise.resolve([] as ItineraryDay[]);

        const [pairs, d] = await Promise.all([perTrip, itinerary]);
        if (cancelled) return;
        setBookingsByTrip(Object.fromEntries(pairs));
        setDays(d);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, today]);

  const name = displayNameFor(identity?.email);
  const pendingImports = (
    <PendingImportCard
      api={api}
      existingTrips={trips}
      style={{ marginBottom: 24 }}
      onTripCreated={(trip) =>
        setTrips((current) => [...(current ?? []), trip])
      }
    />
  );

  if (error) return <p className="warning">{error}</p>;
  if (trips === null) return <p className="text-muted">Loading…</p>;

  if (trips.length === 0) {
    return (
      <>
        <h3>{greeting(now, name)}</h3>
        <p className="text-muted">
          No trips yet. Add the family in Settings, then create your first trip.
        </p>
        {pendingImports}
      </>
    );
  }

  if (visible.length === 0) {
    // Every trip is cancelled. Rendering a cancelled trip as the hero would
    // contradict its own state; say what is going on instead.
    return (
      <>
        <h3>{greeting(now, name)}</h3>
        <p className="text-muted">
          Every trip is cancelled. Restore one from its trip page, or create a new one
          under Trips.
        </p>
        {pendingImports}
      </>
    );
  }

  // Active first, then soonest upcoming, then past most-recent-first, then
  // complete — the shared comparator (lib/dates.ts) that the Trips page
  // sorts with too. Server order is starts_on ASC, which is exactly
  // backwards for this screen; sorting here rather than adding a query
  // parameter keeps the endpoint's contract (and plan 3's use of it) alone.
  const ordered = [...visible].sort((a, b) => compareTrips(a, b, today));

  const heroTrip = active ?? upcoming[0] ?? ordered[0]!;
  const todayDay = days.find((d) => d.date === today);

  return (
    <>
      <header className="page-header">
        <div className="page-title-group">
          <h3>{greeting(now, name)}</h3>
          <p className="page-subline">
            {formatLongDate(today)}
            {active
              ? ` · travel day — ${active.title}`
              : ` · Coming up: ${heroTrip.title}`}
          </p>
        </div>
        <span className="tag tag-accent">{countdownTagText(heroTrip, today)}</span>
      </header>

      {pendingImports}

      <div className="hero-row">
        {active ? (
          <ActiveTripHero
            trip={active}
            day={todayDay}
            people={people}
            now={now}
            onReveal={async (bookingId) =>
              (await api.trips.revealConfirmation(active.id, bookingId)).value
            }
          />
        ) : (
          <IdleTripHero
            trip={heroTrip}
            today={today}
            people={people}
            bookings={bookingsByTrip[heroTrip.id] ?? []}
          />
        )}
        <NextBestActions api={api} today={today} />
      </div>

      <hr className="hr" />

      <div className="grid-cards">
        {ordered.map((t) => (
          <TripCard
            key={t.id}
            trip={t}
            bookings={bookingsByTrip[t.id] ?? []}
            people={people}
            today={today}
          />
        ))}
      </div>
    </>
  );
}
