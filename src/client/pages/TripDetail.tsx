import { useEffect, useState } from "react";
import { Link } from "wouter";
import { MapPin, Plus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Booking, Person, Trip, TripRollup } from "../api/types.js";
import { countdownLabel } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";
import { OverviewTab } from "../trip/OverviewTab.js";
import { TravelersTab } from "../trip/TravelersTab.js";
import { TripWarnings } from "../trip/TripWarnings.js";
import { ChecklistTab } from "../trip/ChecklistTab.js";
import { DayView } from "../dayview/DayView.js";
import { BookingDialog } from "../trip/BookingDialog.js";

type Api = typeof defaultApi;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "days", label: "Day by day" },
  { id: "travelers", label: "Travelers" },
  { id: "checklist", label: "Checklist" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const DEFAULT_TAB: TabId = "overview";

/**
 * The tab lives in the URL hash so a trip view is linkable ("open the
 * checklist for the wedding"), back-button-able, and survives a reload —
 * TripDetail is exactly the page someone sends a family member.
 */
function tabFromHash(hash: string): TabId {
  const id = hash.replace(/^#/, "");
  const match = TABS.find((t) => t.id === id);
  return match ? match.id : DEFAULT_TAB;
}

export function TripDetail({
  id,
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  id: string;
  api?: Api;
  today?: string;
}) {
  const [trip, setTrip] = useState<Trip | null | undefined>(undefined);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [travelers, setTravelers] = useState<Person[]>([]);
  const [rollup, setRollup] = useState<TripRollup | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<TabId>(() => tabFromHash(window.location.hash));
  const [addingBooking, setAddingBooking] = useState(false);
  // Bumped after any write, to re-run the load effect. Simpler and less
  // error-prone than threading a refetch callback through four tab
  // components, and it reloads the rollup and the booking list together —
  // they are rendered side by side and must not disagree.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [trips, p, t, b, r] = await Promise.all([
          api.trips.list(),
          api.people.list(),
          // Trip membership, from trip_person. Deriving travelers from
          // `bookings.flatMap(b => b.personIds)` instead would be *booking*
          // membership: a person added to the trip but not yet on any booking
          // would vanish from the header chips and from the Travelers tab —
          // precisely the pre-booking state that tab exists to show.
          api.trips.travelers(id),
          api.trips.bookings(id),
          api.trips.rollup(id),
        ]);
        if (cancelled) return;
        setTrip(trips.find((x) => x.id === id) ?? null);
        setPeople(p);
        setTravelers(t);
        setBookings(b);
        setRollup(r);
      } catch {
        // Three of those five endpoints 404 on an unknown or other-household
        // trip id — i.e. on any stale link. Without this catch the page sits
        // on "Loading…" forever and the rejection goes unhandled.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id, reloadKey]);

  // Back/forward and hand-edited URLs both arrive as `hashchange`.
  useEffect(() => {
    const sync = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function selectTab(next: TabId) {
    setTab(next);
    // Assigning to location.hash pushes a history entry, which is what makes
    // the back button walk tabs. Guarded so re-selecting the current tab does
    // not pile up duplicate entries.
    if (tabFromHash(window.location.hash) !== next) window.location.hash = next;
  }

  if (failed) {
    return (
      <p className="text-muted" role="alert">
        Couldn't load this trip. It may have been deleted, or the link may be wrong.
      </p>
    );
  }
  if (trip === undefined) return <p className="text-muted">Loading…</p>;
  if (trip === null) return <p className="text-muted">Trip not found.</p>;

  return (
    <>
      {/*
        The current page's name isn't repeated as a breadcrumb crumb: the
        heading right below already carries it, and this component is tested
        with `findByText(trip.title)` — a query that requires a unique match,
        which a repeated crumb would break.
      */}
      <div className="card-meta" style={{ marginBottom: 8 }}>
        <Link href="/trips" style={{ color: "inherit" }}>
          Trips
        </Link>
      </div>

      <header style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>{trip.title}</h3>
          <span className="tag tag-accent">
            {countdownLabel(trip.startsOn, trip.endsOn, today)}
          </span>
          <PersonChips people={travelers} />
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => setAddingBooking(true)}
          >
            <Plus size={14} /> Add booking
          </button>
        </div>
        {trip.destination && (
          <div className="card-meta">
            <MapPin size={12} />
            <span>{trip.destination}</span>
          </div>
        )}
      </header>

      <TripWarnings people={travelers} arrivalOn={trip.startsOn} today={today} />

      {/*
        A native radio group, not an ARIA tablist — see this task's Interfaces
        note. `name="trip-tab"` is what gives arrow-key navigation and group
        semantics; the token sheet styles the visually-hidden input's checked
        and focus-visible states through `.seg-opt:has(...)`, so the visible
        label is both the hit target and the focus ring's host.
      */}
      <div
        className="seg"
        role="radiogroup"
        aria-label="Trip sections"
        style={{ marginBottom: 20 }}
      >
        {TABS.map(({ id: tabId, label }) => (
          <label key={tabId} className="seg-opt">
            <input
              type="radio"
              name="trip-tab"
              value={tabId}
              checked={tab === tabId}
              onChange={() => selectTab(tabId)}
            />
            {label}
          </label>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab
          trip={trip}
          bookings={bookings}
          people={people}
          rollup={rollup}
          api={api}
          onStatusChanged={() => setReloadKey((n) => n + 1)}
        />
      )}
      {tab === "days" && <DayView tripId={trip.id} people={travelers} api={api} />}
      {tab === "travelers" && (
        <TravelersTab people={travelers} arrivalOn={trip.startsOn} today={today} api={api} />
      )}
      {tab === "checklist" && <ChecklistTab tripId={trip.id} people={people} api={api} />}

      {addingBooking && (
        <BookingDialog
          trip={trip}
          people={travelers}
          api={api}
          onSaved={() => {
            setAddingBooking(false);
            setReloadKey((n) => n + 1);
          }}
          onClose={() => setAddingBooking(false)}
        />
      )}
    </>
  );
}
