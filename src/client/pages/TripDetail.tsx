import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  CalendarBlank,
  CopySimple,
  DotsThree,
  MapPin,
  PencilSimple,
  Plus,
  ShareNetwork,
} from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import { TripRoleBoundary, useCanWrite } from "../api/identity.js";
import type { Booking, Person, Trip, TripRollup } from "../api/types.js";
import { formatDateRange, resolveTripState, tripStateBadge } from "../lib/dates.js";
import { TripCoverPhoto } from "../components/TripCoverPhoto.js";
import "../trip/trip.css";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "../components/Dialog.js";
import { PersonChips } from "../components/PersonChip.js";
import { TripForm } from "../components/TripForm.js";
import { OverviewTab } from "../trip/OverviewTab.js";
import { TravelersTab } from "../trip/TravelersTab.js";
import { TripWarnings } from "../trip/TripWarnings.js";
import { DuplicatesCard } from "../trip/DuplicatesCard.js";
import { ChecklistTab } from "../trip/ChecklistTab.js";
import { DayView } from "../dayview/DayView.js";
import { BookingDialog } from "../trip/BookingDialog.js";
import { BookingDetailDialog } from "../components/BookingDetailDialog.js";
import { CostAnalysisTab } from "../trip/CostAnalysisTab.js";
import { TripAccessDialog } from "../trip/TripAccessDialog.js";

type Api = typeof defaultApi;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "days", label: "Day by day" },
  { id: "costs", label: "Costs" },
  { id: "travelers", label: "Travelers" },
  { id: "checklist", label: "Checklist" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const DEFAULT_TAB: TabId = "overview";

/** What the hash says this page should be showing. `date` is meaningful only
 * for the day view; it is null everywhere else. */
type HashView = { tab: TabId; date: string | null };

/**
 * The banner's ⋯ menu. This was a native `<details>` with an absolutely
 * positioned panel, which failed three ways: the panel was clipped out of
 * existence by the banner's cover-photo `overflow: hidden` (dead button on a
 * phone, cut off on desktop — the reason this component exists), it stayed
 * open behind whatever dialog an item opened, and nothing outside it could
 * dismiss it. Same disclosure pattern as Shell's AccountMenu instead: a real
 * button with `aria-expanded`, outside-pointer and Escape to close, and every
 * item closing the popup on its way to its action.
 *
 * Disclosure, not `role="menu"` — three items don't warrant arrow-key
 * roving focus, and buttons already announce themselves.
 */
function TripMenu({
  tripTitle,
  canShare,
  onEdit,
  onShare,
  onCheckDuplicates,
}: {
  tripTitle: string;
  canShare: boolean;
  onEdit: () => void;
  onShare: () => void;
  onCheckDuplicates: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /* Every item is a one-shot: run it, and the popup's job is done. */
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className="btn btn-secondary btn-icon"
        aria-label={`Trip menu for ${tripTitle}`}
        aria-expanded={open}
        aria-controls="trip-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <DotsThree size={18} />
      </button>
      {open && (
        <div className="menu-pop" id="trip-menu" data-testid="trip-menu">
          <button type="button" className="btn btn-ghost" onClick={choose(onEdit)}>
            <PencilSimple size={14} /> Edit trip
          </button>
          {canShare && (
            <button type="button" className="btn btn-ghost" onClick={choose(onShare)}>
              <ShareNetwork size={14} /> Share trip
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={choose(onCheckDuplicates)}>
            <CopySimple size={14} /> Check duplicates
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The tab lives in the URL hash so a trip view is linkable ("open the
 * checklist for the wedding"), back-button-able, and survives a reload —
 * TripDetail is exactly the page someone sends a family member.
 *
 * The day view needs one more thing than a tab id: *which* day. It rides in
 * the same hash as `#days:2026-10-08`, for the same three reasons — clicking
 * a day on Overview must be reloadable, back-able, and sendable ("here's the
 * wedding day"). Colon rather than a query string or a second `#`: a hash may
 * legally hold one, it keeps `#days` a plain prefix of `#days:<date>`, and it
 * leaves the bare form the dashboard's "Open day view" button has always
 * linked to working unchanged.
 *
 * Parsing is total — this reads whatever a person or an old bookmark left in
 * the address bar. An unknown tab, a missing date, a mistyped one and an
 * impossible one all resolve to a view that renders, never to a throw.
 */
function parseHash(hash: string): HashView {
  const raw = hash.replace(/^#/, "");
  const separator = raw.indexOf(":");
  const id = separator === -1 ? raw : raw.slice(0, separator);
  const match = TABS.find((t) => t.id === id);
  if (!match) return { tab: DEFAULT_TAB, date: null };
  // A suffix on any other tab is meaningless rather than disqualifying: the
  // tab is still the thing the reader asked for.
  const suffix = separator === -1 ? "" : raw.slice(separator + 1);
  return {
    tab: match.id,
    date: match.id === "days" ? calendarDate(suffix) : null,
  };
}

/** `value` as a YYYY-MM-DD calendar date, or null if it isn't one. The shape
 * check alone would pass 2026-02-30, which `Date` silently rolls forward to
 * March 2nd — so the parse is round-tripped, and only a date that survives
 * unchanged is a real day. */
function calendarDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

/** The hash for a view, inverse of `parseHash`. */
function hashFor({ tab, date }: HashView): string {
  return tab === "days" && date ? `${tab}:${date}` : tab;
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
  const [rollupLoading, setRollupLoading] = useState(false);
  const [rollupFailed, setRollupFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<HashView>(() => parseHash(window.location.hash));
  const tab = view.tab;
  const [addingBooking, setAddingBooking] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [duplicateCheck, setDuplicateCheck] = useState(0);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The delete dialog's second step: the first click arms, the second fires.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const householdCanWrite = useCanWrite();
  const [, navigate] = useLocation();
  // Bumped after any write, to re-run the core trip load. The Costs tab owns
  // its rollup request separately so opening Overview does not pay for cost
  // analysis the user may never inspect.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRollup(null);
    setRollupFailed(false);
    (async () => {
      try {
        const [loadedTrip, p, t, b] = await Promise.all([
          api.trips.get(id),
          api.people.list(),
          // Trip membership, from trip_person. Deriving travelers from
          // `bookings.flatMap(b => b.personIds)` instead would be *booking*
          // membership: a person added to the trip but not yet on any booking
          // would vanish from the header chips and from the Travelers tab —
          // precisely the pre-booking state that tab exists to show.
          api.trips.travelers(id),
          api.trips.bookings(id),
        ]);
        if (cancelled) return;
        setTrip(loadedTrip);
        setPeople(p);
        setTravelers(t);
        setBookings(b);
      } catch {
        // Trip-specific endpoints 404 on an unknown or other-household id —
        // i.e. on any stale link. Without this catch the page sits
        // on "Loading…" forever and the rejection goes unhandled.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id, reloadKey]);

  useEffect(() => {
    // Overview's rail cost card shares this rollup; other tabs stay lazy.
    if ((tab !== "costs" && tab !== "overview") || rollup !== null) return;
    let cancelled = false;
    setRollupLoading(true);
    setRollupFailed(false);
    api.trips.rollup(id).then(
      (result) => {
        if (!cancelled) setRollup(result);
      },
      () => {
        if (!cancelled) setRollupFailed(true);
      },
    ).finally(() => {
      if (!cancelled) setRollupLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [api, id, reloadKey, rollup, tab]);

  // Back/forward and hand-edited URLs both arrive as `hashchange`.
  useEffect(() => {
    const sync = () => setView(parseHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function selectTab(next: TabId, date?: string) {
    const target: HashView = { tab: next, date: next === "days" ? date ?? null : null };
    setView(target);
    // Assigning to location.hash pushes a history entry, which is what makes
    // the back button walk tabs — and what makes Back out of a day opened
    // from Overview return to Overview. Guarded so re-selecting the view
    // already in the URL does not pile up duplicate entries.
    const current = parseHash(window.location.hash);
    if (current.tab !== target.tab || current.date !== target.date) {
      window.location.hash = hashFor(target);
    }
  }

  /**
   * The day view moved itself (the pager). This *replaces* the current entry
   * rather than pushing one: flipping Oct 9 → 10 → 11 would otherwise bury
   * Overview under three entries and turn Back into "walk the days again"
   * — while the point of Back from a day view is to get back to where the
   * day was chosen. Replacing still leaves the URL copyable and reload-proof,
   * which is the whole reason the date is in it.
   *
   * `view` is deliberately left alone. It records what the last *navigation*
   * asked for, and re-rendering DayView with a new `requestedDate` on every
   * page flip would be this component telling the day view what it just told
   * us. The two only need to agree again on the next hashchange, which
   * re-reads the URL from scratch.
   */
  function showDay(date: string) {
    const target = `#${hashFor({ tab: "days", date })}`;
    if (window.location.hash !== target) window.history.replaceState(null, "", target);
  }

  /**
   * Soft cancel and its reversal are the same partial PUT — only the status
   * changes hands. The full reload (reloadKey) keeps the badge, footer, and
   * grid pages honest without hand-patching local state.
   */
  async function setTripStatus(status: "cancelled" | "planning") {
    setActionBusy(true);
    try {
      await api.trips.update(id, { status });
      setActionError(null);
      setConfirmingCancel(false);
      setReloadKey((n) => n + 1);
    } catch (err) {
      // A 403 (role changed under us) or 404 must say so — never a silent
      // no-op, never String(err).
      setActionError(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteTrip() {
    setActionBusy(true);
    try {
      await api.trips.delete(id);
      // The trip is gone; this page has nothing left to show.
      navigate("/trips");
    } catch (err) {
      setActionError(errorMessage(err));
      setActionBusy(false);
      setConfirmingDelete(false);
      setDeleteArmed(false);
    }
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

  const state = resolveTripState(trip, today);
  const accessRole = trip.accessRole ?? (householdCanWrite ? "owner" : "viewer");
  const canWrite = accessRole !== "viewer";

  return (
    <TripRoleBoundary role={accessRole}>
      <>
      {/*
        The current page's name isn't repeated as a breadcrumb crumb: the
        heading right below already carries it, and this component is tested
        with `findByText(trip.title)` — a query that requires a unique match,
        which a repeated crumb would break.
      */}
      <div className="trip-breadcrumb">
        <Link href="/trips">Trips</Link>
      </div>

      {/* Photo banner (spec: photo headers everywhere trips appear). The
          cover art sits behind a bottom scrim so the title stays legible on
          any photo; without a photo the deterministic fallback art renders. */}
      <header className="detail-banner">
        {/* The art and its scrim are wrapped so the rounded corners clip them
            and nothing else — see .banner-media. The banner itself must not
            clip, or it eats the ⋯ menu's popup. */}
        <div className="banner-media" aria-hidden="true">
          <TripCoverPhoto photoUrl={trip.photoUrl} tripId={trip.id} />
          <div className="banner-scrim" />
        </div>
        <div className="banner-content">
          <div className="banner-title-block">
            <div className="banner-title-row">
              <h2>{trip.title}</h2>
              <span className={state === "cancelled" ? "tag tag-neutral" : "tag tag-accent"}>
                {tripStateBadge(trip, today)}
              </span>
            </div>
            {(trip.startsOn || trip.destination) && (
              <p className="banner-sub">
                {trip.startsOn && (
                  <>
                    <CalendarBlank size={13} />
                    <span>{formatDateRange(trip.startsOn, trip.endsOn, today)}</span>
                  </>
                )}
                {trip.startsOn && trip.destination && (
                  <span className="banner-sub-sep">·</span>
                )}
                {trip.destination && (
                  <>
                    <MapPin size={13} />
                    <span>{trip.destination}</span>
                  </>
                )}
              </p>
            )}
            <PersonChips people={travelers} />
          </div>
          <div className="banner-actions">
            {canWrite && (
              <TripMenu
                tripTitle={trip.title}
                canShare={accessRole === "owner"}
                onEdit={() => setEditing(true)}
                onShare={() => setSharing(true)}
                onCheckDuplicates={() => setDuplicateCheck((value) => value + 1)}
              />
            )}
            {canWrite && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAddingBooking(true)}
              >
                <Plus size={14} /> Add booking
              </button>
            )}
          </div>
        </div>
      </header>

      <TripWarnings people={travelers} arrivalOn={trip.startsOn} today={today} />

      {/* Duplicate imports are trip-level news for the same reason an expiring
          passport is: a doubled flight is wrong in the day view, the cost
          rollup, and the checklist alike, so it cannot live inside one tab. */}
      <DuplicatesCard
        tripId={trip.id}
        people={people}
        api={api}
        reloadKey={reloadKey}
        checkRequest={duplicateCheck}
        onResolved={() => setReloadKey((n) => n + 1)}
      />

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
          api={api}
          onStatusChanged={() => setReloadKey((n) => n + 1)}
          onBookingClick={setSelectedBooking}
          travelers={travelers}
          rollup={rollup}
          onOpenTab={selectTab}
          today={today}
        />
      )}
      {tab === "days" && (
        <DayView
          tripId={trip.id}
          tripTitle={trip.title}
          people={travelers}
          api={api}
          onBookingClick={setSelectedBooking}
          requestedDate={view.date}
          onDateChange={showDay}
        />
      )}
      {tab === "costs" && rollup && (
        <CostAnalysisTab trip={trip} bookings={bookings} rollup={rollup} />
      )}
      {tab === "costs" && rollupLoading && (
        <p className="text-muted" role="status">Loading cost analysis…</p>
      )}
      {tab === "costs" && rollupFailed && (
        <p className="warning" role="alert">Couldn't load this trip's cost analysis.</p>
      )}
      {tab === "travelers" && (
        <TravelersTab
          people={travelers}
          arrivalOn={trip.startsOn}
          today={today}
          api={api}
          tripId={trip.id}
          allPeople={people}
          onAdded={() => setReloadKey((n) => n + 1)}
          onRemoved={() => setReloadKey((n) => n + 1)}
        />
      )}
      {tab === "checklist" && <ChecklistTab tripId={trip.id} people={people} api={api} />}

      {/*
        The manage footer renders for writers only: every control in it is a
        guaranteed 403 for a viewer, and a button that can only fail is the
        same false offer MaskedValue exists to avoid.
      */}
      {canWrite && (
        <footer style={{ marginTop: 28 }}>
          <hr className="hr" />
          {actionError && (
            <p className="warning" role="alert">
              {actionError}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {state === "cancelled" ? (
              <>
                <span className="text-muted" style={{ fontSize: 12.5 }}>
                  This trip is cancelled. It is hidden from the dashboard until restored.
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={actionBusy}
                  onClick={() => void setTripStatus("planning")}
                >
                  Restore trip
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmingCancel(true)}
              >
                Cancel trip
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                setDeleteArmed(false);
                setConfirmingDelete(true);
              }}
            >
              Delete trip
            </button>
          </div>
        </footer>
      )}

      {editing && (
        <TripForm
          // Remount per trip, the same rule People applies to PersonForm:
          // TripForm seeds its state from props once.
          key={trip.id}
          people={people}
          trip={trip}
          api={api}
          onSaved={() => {
            setEditing(false);
            setReloadKey((n) => n + 1);
          }}
          onClose={() => setEditing(false)}
        />
      )}

      {sharing && (
        <TripAccessDialog trip={trip} api={api} onClose={() => setSharing(false)} />
      )}

      {confirmingCancel && (
        <Dialog title="Cancel this trip?" onClose={() => setConfirmingCancel(false)}>
          <p style={{ margin: 0, fontSize: 13.5 }}>
            {trip.title} stays here and can be restored later. Nothing is deleted.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmingCancel(false)}
            >
              Keep trip
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={actionBusy}
              onClick={() => void setTripStatus("cancelled")}
            >
              Cancel trip
            </button>
          </div>
        </Dialog>
      )}

      {confirmingDelete && (
        <Dialog
          title={`Delete ${trip.title}?`}
          onClose={() => {
            setConfirmingDelete(false);
            setDeleteArmed(false);
          }}
        >
          <p style={{ margin: 0, fontSize: 13.5 }}>
            This permanently deletes the trip and also removes {bookings.length}{" "}
            {bookings.length === 1 ? "booking" : "bookings"}, its checklist, and its
            traveller list. It cannot be undone — cancelling instead keeps everything.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setConfirmingDelete(false);
                setDeleteArmed(false);
              }}
            >
              Keep trip
            </button>
            {deleteArmed ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={actionBusy}
                onClick={() => void deleteTrip()}
              >
                Yes, permanently delete
              </button>
            ) : (
              // The second confirm: the first click only arms the button.
              <button type="button" className="btn btn-primary" onClick={() => setDeleteArmed(true)}>
                Delete trip
              </button>
            )}
          </div>
        </Dialog>
      )}

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

      {selectedBooking && (
        <BookingDetailDialog
          booking={selectedBooking}
          people={people}
          api={api}
          onPeopleChanged={() => setReloadKey((n) => n + 1)}
          onSaved={() => {
            // The dialog holds a snapshot of the booking as it was when the
            // row was clicked. After an edit that snapshot is wrong, and
            // re-rendering the detail view from it would show the operator
            // their old values back. Close and reload instead.
            setSelectedBooking(null);
            setReloadKey((n) => n + 1);
          }}
          onDeleted={() => {
            // Same shape as onSaved, for the same reason — except here the
            // snapshot describes a row that no longer exists at all.
            setSelectedBooking(null);
            setReloadKey((n) => n + 1);
          }}
          onClose={() => setSelectedBooking(null)}
        />
      )}
      </>
    </TripRoleBoundary>
  );
}
