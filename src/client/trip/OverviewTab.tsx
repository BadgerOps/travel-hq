import { useEffect, useState } from "react";
import {
  AirplaneTakeoff,
  Bed,
  Car,
  CheckSquare,
  Confetti,
  Square,
  Ticket,
  WarningCircle,
} from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type {
  Booking,
  ChecklistItem,
  ItineraryDay,
  Person,
  Trip,
  TripRollup,
} from "../api/types.js";
import {
  formatBookingWhen,
  formatDayLabel,
  formatLongDate,
} from "../lib/dates.js";
import { formatMoney } from "../lib/money.js";
import { errorMessage } from "../lib/errors.js";
import { passportStatus, passportWarningText } from "../lib/passport.js";
import { PersonChip, PersonChips } from "../components/PersonChip.js";
import { MaskedValue } from "../components/MaskedValue.js";

const GROUPS = [
  { heading: "Flights", kinds: ["flight"] },
  { heading: "Stay & car", kinds: ["lodging", "car"] },
  { heading: "Events", kinds: ["activity", "other"] },
];

const ICONS: Record<string, typeof AirplaneTakeoff> = {
  flight: AirplaneTakeoff,
  lodging: Bed,
  car: Car,
  activity: Confetti,
  other: Ticket,
};

/** The Events group takes the second accent, per 1b (and SharedAgenda). */
const EVENT_KINDS = new Set(["activity", "other"]);

const number = new Intl.NumberFormat("en-US");

/** Filler day-rows are capped: an epic trip renders only its scheduled days
 * rather than a wall of "nothing planned". */
const MAX_FILLER_DAYS = 45;

type RailTab = "days" | "costs" | "travelers" | "checklist";

export function OverviewTab({
  trip,
  bookings,
  people,
  api,
  onStatusChanged,
  onBookingClick,
  travelers,
  rollup,
  onOpenTab,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  trip: Trip;
  bookings: Booking[];
  people: Person[];
  api: typeof defaultApi;
  /**
   * Optional so plan 3's existing OverviewTab tests, which do not supply it,
   * keep passing unchanged. When absent, Book → is not rendered — the same
   * "no dead controls" rule, applied to a component used in two places.
   */
  onStatusChanged?: () => void;
  onBookingClick?: (booking: Booking) => void;
  /** Trip roster for the right rail's Travelers card; without it (the
   * standalone test harnesses) the card simply doesn't render. */
  travelers?: Person[];
  /** The same rollup the Costs tab renders, fetched once by TripDetail. */
  rollup?: TripRollup | null;
  /** Switches the trip-detail tab the same way the seg control does. */
  onOpenTab?: (tab: RailTab) => void;
  today?: string;
}) {
  // Cancelled bookings are not part of the trip. Keep this event-focused
  // overview aligned with the itinerary and the separate Costs tab.
  const visible = bookings.filter((b) => b.status !== "cancelled");

  const [failed, setFailed] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The day-breakdown strip's data. The server owns the timezone-correct
  // grouping and sort (ItineraryRepo) — this component only merges in the
  // trip's empty calendar days. Null until loaded; stays null (strip hidden)
  // when the endpoint is unavailable or errors — the Day by day tab is the
  // place that reports itinerary failures.
  const [itinerary, setItinerary] = useState<ItineraryDay[] | null>(null);
  useEffect(() => {
    const fetchItinerary = api.trips?.itinerary;
    if (typeof fetchItinerary !== "function") return;
    let cancelled = false;
    fetchItinerary(trip.id).then(
      (days) => {
        if (!cancelled) setItinerary(days);
      },
      () => {
        // Progressive enhancement only: the grouped bookings below carry the
        // same facts, so a failed strip degrades to no strip.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, trip]);

  // Rail checklist card. Same tripId filter as ChecklistTab (the endpoint is
  // cross-trip); same silent degrade as the strip — the Checklist tab owns
  // error reporting.
  const [checklist, setChecklist] = useState<ChecklistItem[] | null>(null);
  useEffect(() => {
    const list = api.checklist?.list;
    if (typeof list !== "function") return;
    let cancelled = false;
    list().then(
      (all) => {
        if (!cancelled) setChecklist(all.filter((i) => i.tripId === trip.id));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, trip]);

  async function book(bookingId: string) {
    setBusyId(bookingId);
    try {
      await api.bookings.setStatus(bookingId, "booked");
      setFailed(null);
      onStatusChanged?.();
    } catch (err) {
      // A 403 (viewer) or 404 (deleted in another tab) must say so. Silently
      // re-enabling the button is the failure mode this plan exists to avoid.
      setFailed(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  const stripDays = itinerary === null ? [] : mergeTripDays(trip, itinerary);
  const doneCount = checklist?.filter((i) => i.doneAt !== null).length ?? 0;
  const showTravelers = travelers !== undefined && travelers.length > 0;
  const showChecklist = checklist !== null && checklist.length > 0;
  const showCost =
    rollup != null && (rollup.totalCents > 0 || rollup.points.length > 0);
  const hasRail = showTravelers || showChecklist || showCost;

  const main = (
    <div className="overview-main">
      {failed && (
        <p className="warning" role="alert" style={{ margin: 0 }}>
          {failed}
        </p>
      )}

      {stripDays.length > 0 && (
        <section className="card trip-days" aria-label="Day by day summary">
          <h6 className="section-kicker">Day by day</h6>
          <div>
            {stripDays.map(({ date, bookings: dayBookings }) => (
              <DayRow
                key={date}
                date={date}
                bookings={dayBookings}
                onOpen={onOpenTab && (() => onOpenTab("days"))}
              />
            ))}
          </div>
        </section>
      )}

      {visible.length === 0 ? (
        <p className="text-muted" style={{ margin: 0 }}>
          Nothing booked yet for this trip.
        </p>
      ) : (
        GROUPS.map(({ heading, kinds }) => {
          const group = visible.filter((b) => kinds.includes(b.kind));
          if (group.length === 0) return null;
          return (
            <section key={heading}>
              <h6 className="section-kicker">{heading}</h6>
              <div className="booking-group">
                {group.map((b) => (
                  <BookingRow
                    key={b.id}
                    booking={b}
                    trip={trip}
                    people={people}
                    api={api}
                    busy={busyId === b.id}
                    onBook={onStatusChanged ? () => void book(b.id) : undefined}
                    onBookingClick={onBookingClick}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );

  if (!hasRail) return main;

  return (
    <div className="split-main-rail">
      {main}
      <div className="rail">
        {showTravelers && (
          <section className="card" aria-label="Travelers">
            <h6 className="card-kicker">Travelers</h6>
            <div>
              {travelers.map((p) => (
                <RailPerson
                  key={p.id}
                  person={p}
                  arrivalOn={trip.startsOn}
                  today={today}
                />
              ))}
            </div>
            {onOpenTab && (
              <button
                type="button"
                className="btn btn-ghost rail-card-link"
                onClick={() => onOpenTab("travelers")}
              >
                Manage travelers →
              </button>
            )}
          </section>
        )}

        {showChecklist && (
          <section className="card" aria-label="Checklist">
            <h6 className="card-kicker">
              {doneCount} of {checklist.length} done
            </h6>
            <div style={{ display: "grid", gap: 6 }}>
              {checklist.slice(0, 4).map((item) => {
                const done = item.doneAt !== null;
                const Box = done ? CheckSquare : Square;
                return (
                  <div
                    key={item.id}
                    className={
                      done ? "rail-check-row rail-check-row--done" : "rail-check-row"
                    }
                  >
                    <Box size={14} />
                    <span className="rail-check-label">{item.label}</span>
                  </div>
                );
              })}
            </div>
            {onOpenTab && (
              <button
                type="button"
                className="btn btn-ghost rail-card-link"
                onClick={() => onOpenTab("checklist")}
              >
                Full checklist →
              </button>
            )}
          </section>
        )}

        {showCost && (
          <section className="card" aria-label="Trip cost">
            <h6 className="card-kicker">Trip cost</h6>
            <div className="stat-big">
              {formatMoney(rollup.totalCents)}
              {rollup.points.length > 0 && (
                <span className="stat-note">
                  {" "}
                  +{" "}
                  {rollup.points
                    .map((p) => `${number.format(p.used)} ${p.program}`)
                    .join(", ")}
                </span>
              )}
            </div>
            {onOpenTab && (
              <button
                type="button"
                className="btn btn-ghost rail-card-link"
                onClick={() => onOpenTab("costs")}
              >
                Cost details →
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function bookingHighlights(booking: Booking): string[] {
  const details = detailRecord(booking.details);
  const highlights: string[] = [];
  const location = usefulLocation(booking.title, booking.location);
  if (location) highlights.push(location);

  switch (booking.kind) {
    case "flight":
      pushParts(highlights, [
        joined(details.carrier, details.flightNumber),
        route(details.originIata, details.destinationIata),
        labeled("Seat", details.seat),
        text(details.cabin),
      ]);
      break;
    case "lodging":
      pushParts(highlights, [
        labeled("Site", first(details.siteNumber, details.site)),
        text(first(details.siteType, details.type)),
        text(first(details.campsite, details.product, details.roomType)),
        count(details.nights, "night"),
      ]);
      break;
    case "car":
      pushParts(highlights, [
        text(details.vendor),
        text(details.vehicleClass),
        labeled("Pickup", details.pickupLocation),
      ]);
      break;
    case "activity":
      pushParts(highlights, [
        text(details.venue),
        count(details.partySize, "traveler"),
        count(first(details.ticketQuantity, details.quantity), "ticket"),
      ]);
      break;
    default:
      pushParts(highlights, [
        labeled("Site", first(details.siteNumber, details.site)),
        text(first(details.siteType, details.type)),
        text(first(details.campsite, details.product, details.roomType)),
        count(details.nights, "night"),
      ]);
  }

  return [...new Set(highlights)].slice(0, 4);
}

function detailRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function usefulLocation(title: string, location: string | null): string | undefined {
  const value = location?.trim();
  if (!value) return undefined;
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const normalizedLocation = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalizedLocation !== "" && !normalizedTitle.includes(normalizedLocation)
    ? truncate(value)
    : undefined;
}

function pushParts(target: string[], values: Array<string | undefined>): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized === "" ? undefined : truncate(normalized);
}

function labeled(label: string, value: unknown): string | undefined {
  const rendered = text(value);
  return rendered ? `${label} ${rendered}` : undefined;
}

function joined(firstValue: unknown, secondValue: unknown): string | undefined {
  const values = [text(firstValue), text(secondValue)].filter(Boolean);
  return values.length > 0 ? values.join(" ") : undefined;
}

function route(origin: unknown, destination: unknown): string | undefined {
  const from = text(origin);
  const to = text(destination);
  return from && to ? `${from.toUpperCase()} → ${to.toUpperCase()}` : undefined;
}

function count(value: unknown, singular: string): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function truncate(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}…` : value;
}

/** One 1b booking row: kind icon, title + dual-tz/conf sub, chips + cost +
 * status tag (+ Book → on provisional rows) on the right. */
function BookingRow({
  booking: b,
  trip,
  people,
  api,
  busy,
  onBook,
  onBookingClick,
}: {
  booking: Booking;
  trip: Trip;
  people: Person[];
  api: typeof defaultApi;
  busy: boolean;
  onBook?: () => void;
  onBookingClick?: (booking: Booking) => void;
}) {
  const Icon = ICONS[b.kind] ?? Ticket;
  const highlights = bookingHighlights(b);
  // Three distinct states, not two. `planned` is a decision the family has
  // made but not yet paid for; `draft` is an unreviewed email import that no
  // one has confirmed is even real, and which the Costs tab deliberately
  // ignores.
  const isDraft = b.status === "draft";
  const needsBooking = b.status === "planned";
  const provisional = isDraft || needsBooking;

  const rowClass = [
    "booking-row",
    provisional && "booking-row--planned",
    EVENT_KINDS.has(b.kind) && "booking-row--event",
    onBookingClick && "booking-row--click",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClass} onClick={onBookingClick && (() => onBookingClick(b))}>
      <Icon size={19} />
      <div className="booking-main">
        <div className="booking-title">
          {onBookingClick ? (
            <button
              type="button"
              className="booking-title-btn"
              aria-label={`View details for ${b.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onBookingClick(b);
              }}
            >
              {b.title}
            </button>
          ) : (
            b.title
          )}
        </div>
        <div className="booking-sub">
          {highlights.map((highlight) => (
            <span key={highlight}>{highlight}</span>
          ))}
          <span>{bookingWhenLine(b)}</span>
          {b.confirmationNumberMasked && (
            <span onClick={(event) => event.stopPropagation()}>
              Confirmation{" "}
              <MaskedValue
                masked={b.confirmationNumberMasked}
                onReveal={async () =>
                  (await api.trips.revealConfirmation(trip.id, b.id)).value
                }
              />
            </span>
          )}
        </div>
      </div>
      <div className="booking-meta">
        <PersonChips people={people.filter((p) => b.personIds.includes(p.id))} />
        {/* No per-row price: the overview stays event-focused (tested product
            decision) — money lives in the rail's Trip cost card and the Costs
            tab, not beside every booking. */}
        {b.status === "booked" && <span className="tag tag-accent">Booked</span>}
        {isDraft && <span className="tag tag-neutral">Draft</span>}
        {needsBooking && <span className="tag tag-neutral">Needs booking</span>}
        {provisional && onBook && (
          <button
            type="button"
            className="btn btn-ghost"
            aria-label={`Book ${b.title}`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onBook();
            }}
          >
            Book →
          </button>
        )}
      </div>
    </div>
  );
}

/** One strip row: "Fri 9" gutter, then the day's items (planned/draft in
 * warning amber) or a muted "nothing planned". Clicking jumps to the
 * Day by day tab when the page wires `onOpenTab`. */
function DayRow({
  date,
  bookings,
  onOpen,
}: {
  date: string;
  bookings: Booking[];
  onOpen?: () => void;
}) {
  const content = (
    <>
      <span className="trip-day-label">{formatDayLabel(date)}</span>
      <span className="trip-day-items">
        {bookings.length === 0 ? (
          <span className="trip-day-empty">nothing planned</span>
        ) : (
          bookings.map((b) => {
            const Icon = ICONS[b.kind] ?? Ticket;
            const amber = b.status !== "booked";
            return (
              <span
                key={b.id}
                className={amber ? "trip-day-item warning" : "trip-day-item"}
              >
                <Icon size={12} />
                {b.title}
              </span>
            );
          })
        )}
      </span>
    </>
  );

  if (!onOpen) return <div className="trip-day-row">{content}</div>;
  return (
    <button
      type="button"
      className="trip-day-row"
      aria-label={`Open ${formatLongDate(date)} in the day-by-day view`}
      onClick={onOpen}
    >
      {content}
    </button>
  );
}

/** Rail traveler row: chip, name, one doc-status line. The warning wording
 * comes from lib/passport — the same sentence PersonCard and TripWarnings
 * render, so the rail cannot disagree with them. */
function RailPerson({
  person,
  arrivalOn,
  today,
}: {
  person: Person;
  arrivalOn: string | null;
  today: string;
}) {
  const status = passportStatus(person, arrivalOn, today);
  const warning = passportWarningText(person, status);
  return (
    <div className="rail-person">
      <PersonChip person={person} />
      <div style={{ minWidth: 0 }}>
        <div className="rail-person-name">{person.displayName}</div>
        {warning ? (
          <div className="card-meta warning">
            <WarningCircle size={12} /> {warning}
          </div>
        ) : status.kind === "none" || !status.expiry ? (
          <div className="card-meta">No passport on file</div>
        ) : (
          <div className="card-meta">
            Passport expires {formatCalendarDate(status.expiry)}
          </div>
        )}
      </div>
    </div>
  );
}

/** "Fri, Oct 9 · 11:30 PM MDT → 7:00 AM EDT" — the row's sub line: the
 * booking's calendar day in its own zone, then the shared dual-tz time. */
function bookingWhenLine(b: Booking): string {
  const when = formatBookingWhen(b, "");
  if (!b.startsAt) return when || "No date yet";
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: b.startsAtTz ?? "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(b.startsAt));
  return when ? `${day} · ${when}` : day;
}

/** "Jan 15, 2027" — passport expiries carry a year, unlike trip-local dates. */
function formatCalendarDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/**
 * The strip's rows: every calendar day of the trip, with the server's
 * itinerary days (already grouped and sorted by ItineraryRepo — never
 * regrouped here) merged in. Scheduled days outside the trip's dates still
 * appear; empty filler days are capped so a mis-dated trip cannot render
 * hundreds of blank rows.
 */
function mergeTripDays(
  trip: Trip,
  itinerary: ItineraryDay[],
): { date: string; bookings: Booking[] }[] {
  const byDate = new Map(itinerary.map((d) => [d.date, d.bookings]));
  const dates = new Set(itinerary.map((d) => d.date));
  for (const date of tripDateRange(trip)) dates.add(date);
  return [...dates]
    .sort()
    .map((date) => ({ date, bookings: byDate.get(date) ?? [] }));
}

function tripDateRange(trip: Trip): string[] {
  if (!trip.startsOn) return [];
  const end = trip.endsOn ?? trip.startsOn;
  let cursor = Date.parse(`${trip.startsOn}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(last) || cursor > last) return [];
  if ((last - cursor) / 86_400_000 > MAX_FILLER_DAYS) return [];
  const dates: string[] = [];
  while (cursor <= last) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return dates;
}
