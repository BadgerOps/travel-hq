import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Booking, Person, Trip } from "../api/types.js";
import { compareTrips, resolveTripState } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { TripCard } from "../home/TripCard.js";
import { TripForm } from "../components/TripForm.js";
import { PendingImportCard } from "../imports/PendingImportCard.js";
import { useCanWrite } from "../api/identity.js";
import "../home/home.css";

export function Trips({
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  api?: typeof defaultApi;
  today?: string;
}) {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [bookingsByTrip, setBookingsByTrip] = useState<Record<string, Booking[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canWrite = useCanWrite();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, p] = await Promise.all([api.trips.list(), api.people.list()]);
        if (cancelled) return;
        setTrips(t);
        setPeople(p);

        // Each visible trip's bookings feed its card's day-by-day teaser and
        // booked count. Cancelled trips render badge-only cards, so they are
        // not worth a request; a failed fetch degrades that one trip to a
        // card without a teaser rather than erroring the page.
        const pairs = await Promise.all(
          t
            .filter((trip) => resolveTripState(trip, today) !== "cancelled")
            .map(async (trip) => {
              try {
                return [trip.id, await api.trips.bookings(trip.id)] as const;
              } catch {
                return [trip.id, [] as Booking[]] as const;
              }
            }),
        );
        if (!cancelled) setBookingsByTrip(Object.fromEntries(pairs));
      } catch (err) {
        // Same rule as every other fetching component in this app: no silent
        // "Loading…" forever, and no unhandled rejection.
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, today]);

  // The shared state-aware comparator (lib/dates.ts), same as the Home grid:
  // active, then upcoming soonest-first, then past/complete most-recent-first,
  // cancelled last. Unlike Home this page shows cancelled trips — it is the
  // page you restore one from — with their "Cancelled" badge.
  const ordered = (trips ?? []).slice().sort((a, b) => compareTrips(a, b, today));

  return (
    <>
      <header className="page-header">
        <div className="page-title-group">
          <h3>Trips</h3>
          <p className="page-subline">Everything upcoming and past.</p>
        </div>
        <div className="page-actions">
          {canWrite && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New trip
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="warning" role="alert">
          {notice}
        </p>
      )}

      <PendingImportCard
        api={api}
        existingTrips={trips}
        style={{ marginBottom: 14 }}
        onTripCreated={(trip) =>
          setTrips((current) => [...(current ?? []), trip])
        }
      />

      {!error && trips === null && <p className="text-muted">Loading…</p>}

      {!error && trips !== null && ordered.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">No trips yet</span>
          <p className="card-body" style={{ margin: 0 }}>
            Create one and add flights, lodging, and a car to it. Add the family under People
            first if you have not — a trip with no travellers has no day view.
          </p>
          {canWrite && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New trip
            </button>
          )}
        </div>
      )}

      {!error && ordered.length > 0 && (
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
      )}

      {creating && (
        <TripForm
          people={people}
          api={api}
          onSaved={(trip) => {
            setTrips((prev) => [...(prev ?? []), trip]);
            setCreating(false);
          }}
          onRosterError={setNotice}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
