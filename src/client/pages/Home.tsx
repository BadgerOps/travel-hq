import { useEffect, useState } from "react";
import { api as defaultApi } from "../api/client.js";
import { useIdentity } from "../api/identity.js";
import type { Booking, ItineraryDay, Person, Trip } from "../api/types.js";
import { compareTrips, resolveTripState, tripStateBadge } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { ActiveTripHero } from "../home/ActiveTripHero.js";
import { IdleTripHero } from "../home/IdleTripHero.js";
import { NextBestActions } from "../home/NextBestActions.js";
import { TripCard } from "../home/TripCard.js";
import { PendingImportCard } from "../imports/PendingImportCard.js";

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
  const [bookings, setBookings] = useState<Booking[]>([]);
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
        const current = t.find((trip) => resolveTripState(trip, today) === "active");
        if (current) {
          // Two calls, two purposes: the itinerary is day-grouped in each
          // booking's own timezone and drives the hero; the flat list drives
          // the active card's "n booked · m to go" count, which is a whole-trip
          // number and must not be scoped to today.
          const [b, d] = await Promise.all([
            api.trips.bookings(current.id),
            api.trips.itinerary(current.id),
          ]);
          if (!cancelled) {
            setBookings(b);
            setDays(d);
          }
        }
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
          No trips yet. Add the family under People, then create your first trip.
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
      <header
        style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 24 }}
      >
        <div>
          <h3 style={{ marginBottom: 4 }}>{greeting(now, name)}</h3>
          <p className="text-muted" style={{ margin: 0 }}>
            {active
              ? `${active.title} · travel day`
              : `Coming up: ${heroTrip.title}`}
          </p>
        </div>
        <span className="tag tag-accent" style={{ marginLeft: "auto" }}>
          {heroTrip.title} · {tripStateBadge(heroTrip, today)}
        </span>
      </header>

      {pendingImports}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
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
          <IdleTripHero trip={heroTrip} today={today} />
        )}
        <NextBestActions api={api} today={today} />
      </div>

      <hr className="hr" />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))",
          gap: 14,
        }}
      >
        {ordered.map((t) => (
          <TripCard
            key={t.id}
            trip={t}
            bookings={t.id === active?.id ? bookings : []}
            people={people}
            today={today}
          />
        ))}
      </div>
    </>
  );
}
