import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Person, Trip } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { TripCard } from "../home/TripCard.js";
import { TripForm } from "../components/TripForm.js";

export function Trips({
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  api?: typeof defaultApi;
  today?: string;
}) {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, p] = await Promise.all([api.trips.list(), api.people.list()]);
        if (cancelled) return;
        setTrips(t);
        setPeople(p);
      } catch (err) {
        // Same rule as every other fetching component in this app: no silent
        // "Loading…" forever, and no unhandled rejection.
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Soonest first; undated trips last. Matches the API's own ordering and the
  // Home grid's.
  const ordered = (trips ?? []).slice().sort((a, b) => {
    if (a.startsOn === null) return b.startsOn === null ? 0 : 1;
    if (b.startsOn === null) return -1;
    return a.startsOn.localeCompare(b.startsOn);
  });

  return (
    <>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Trips</h3>
          <p className="text-muted" style={{ margin: 0 }}>
            Everything upcoming and past.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          onClick={() => setCreating(true)}
        >
          <Plus size={14} /> New trip
        </button>
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

      {!error && trips === null && <p className="text-muted">Loading…</p>}

      {!error && trips !== null && ordered.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">No trips yet</span>
          <p className="card-body" style={{ margin: 0 }}>
            Create one and add flights, lodging, and a car to it. Add the family under People
            first if you have not — a trip with no travellers has no day view.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New trip
          </button>
        </div>
      )}

      {!error && ordered.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))",
            gap: 14,
          }}
        >
          {ordered.map((t) => (
            <TripCard key={t.id} trip={t} bookings={[]} people={[]} today={today} />
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
