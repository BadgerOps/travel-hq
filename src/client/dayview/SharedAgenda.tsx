import { Fragment } from "react";
import {
  AirplaneLanding,
  AirplaneTakeoff,
  Bed,
  Car,
  ForkKnife,
  Ticket,
  type Icon,
} from "@phosphor-icons/react";
import type { Booking, Person } from "../api/types.js";
import { formatTimeInZone } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";

/**
 * Day view shape 1c — one shared timeline for the whole family, with a person
 * filter above it. Shape 1d (column per person) is backlogged as a desktop-only
 * toggle; keep this component's props free of anything shape-specific so it
 * stays swappable behind DayView.
 *
 * Layout is the shared `.timeline` grid (styles.css): a 150px right-aligned
 * time gutter, an accent-800 spine with a dot per item, and a `.booking-row`
 * card per booking. At ≤760px the grid folds to one column and each card
 * grows a leading `.timeline-inline-time` block — the 1e phone shape — all
 * handled by the stylesheet, not by branching here.
 */
export function SharedAgenda({
  bookings,
  people,
  onBookingClick,
}: {
  bookings: Booking[];
  people: Pick<Person, "id" | "displayName">[];
  onBookingClick?: (booking: Booking) => void;
}) {
  return (
    <div className="timeline">
      {bookings.map((b) => {
        // Same three-state vocabulary as OverviewTab: a hollow dot and a
        // dashed card mean "not confirmed" (planned or draft). The server's
        // itinerary query already excludes cancelled bookings.
        const provisional = b.status !== "booked";
        const { Icon: KindIcon, alt } = bookingIcon(b);
        const time = timeParts(b);

        const dotClass = provisional
          ? "timeline-dot timeline-dot--hollow"
          : alt
            ? "timeline-dot timeline-dot--alt"
            : "timeline-dot";
        const iconColor = provisional
          ? "var(--color-neutral-500)"
          : alt
            ? "var(--color-accent-2)"
            : "var(--color-accent)";
        const rowClass = provisional ? "booking-row booking-row--planned" : "booking-row";

        const sub = [
          b.location,
          b.confirmationNumberMasked ? `conf ${b.confirmationNumberMasked}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

        const content = (
          <>
            {/* display:none on desktop; the ≤760px fold reveals it as the
                52px leading gutter of the 1e list rows. Rendered even when
                the booking has no time yet, so undated cards stay aligned. */}
            <div className="timeline-inline-time">
              {time && (
                <>
                  <div className="t">{time.clock}</div>
                  <div className="tz">{[time.period, time.abbr].filter(Boolean).join(" ")}</div>
                </>
              )}
            </div>
            <KindIcon size={19} color={iconColor} />
            <div className="booking-main">
              <div className="booking-title">{b.title}</div>
              {sub && <div className="booking-sub">{sub}</div>}
            </div>
            <div className="booking-meta">
              <PersonChips people={people.filter((p) => b.personIds.includes(p.id))} />
            </div>
          </>
        );

        return (
          <Fragment key={b.id}>
            {/* An undated booking keeps an empty gutter cell — the grid
                needs both columns per row, and a label here would misalign
                the timeline (same reasoning as the old emptyLabel=""). */}
            <div className="timeline-time">
              {time && (
                <>
                  <div className="t">
                    {time.start} {time.abbr && <span className="tz">{time.abbr}</span>}
                  </div>
                  {time.crossZone && <div className="t2">{time.crossZone}</div>}
                </>
              )}
            </div>
            <div className="timeline-lane">
              <span className={dotClass} />
              {onBookingClick ? (
                <button
                  type="button"
                  className={rowClass}
                  aria-label={`View details for ${b.title}`}
                  onClick={() => onBookingClick(b)}
                >
                  {content}
                </button>
              ) : (
                <div className={rowClass}>{content}</div>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * Icon per booking kind, plus which accent it takes: accent for the
 * logistics kinds, accent-2 for events (the Overview "Events" group,
 * activity + other) and for arrivals. Our schema stores one flight booking
 * per leg, not separate takeoff/landing items, so an arrival-shaped flight
 * ("Alex lands · DL 2688") is recognised by its title — a word-boundary
 * match, so "Portland" doesn't read as a landing.
 */
function bookingIcon(b: Booking): { Icon: Icon; alt: boolean } {
  switch (b.kind) {
    case "flight":
      return /\b(?:land|arriv)/i.test(b.title)
        ? { Icon: AirplaneLanding, alt: true }
        : { Icon: AirplaneTakeoff, alt: false };
    case "lodging":
      return { Icon: Bed, alt: false };
    case "car":
      return { Icon: Car, alt: false };
    case "activity":
      return { Icon: Ticket, alt: true };
    default:
      return { Icon: ForkKnife, alt: true };
  }
}

/** "MDT" — dates.ts keeps its own copy private, and this file can't widen
 * that module's surface, so the three-line Intl dance is restated here. */
function zoneAbbrev(utcInstant: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(new Date(utcInstant));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/**
 * Everything the two time gutters need, from one place so desktop and
 * mobile can never disagree:
 * - `start` + `abbr` — "9:40 AM" / "MDT", the desktop `.t` line;
 * - `clock` + `period` — "9:40" / "AM", stacked in the 52px mobile block;
 * - `crossZone` — "lands 12:55 PM PDT", only when the booking ends in a
 *   different zone than it starts (flights), the desktop `.t2` line.
 */
function timeParts(b: Booking): {
  start: string;
  abbr: string;
  clock: string;
  period: string;
  crossZone: string | null;
} | null {
  if (!b.startsAt) return null;
  const start = formatTimeInZone(b.startsAt, b.startsAtTz ?? "UTC");
  const abbr = b.startsAtTz ? zoneAbbrev(b.startsAt, b.startsAtTz) : "";
  const cut = start.lastIndexOf(" ");
  const clock = cut === -1 ? start : start.slice(0, cut);
  const period = cut === -1 ? "" : start.slice(cut + 1);

  let crossZone: string | null = null;
  if (b.startsAtTz && b.endsAt && b.endsAtTz) {
    const endAbbr = zoneAbbrev(b.endsAt, b.endsAtTz);
    if (endAbbr !== abbr) {
      const verb = b.kind === "flight" ? "lands" : "ends";
      crossZone = `${verb} ${formatTimeInZone(b.endsAt, b.endsAtTz)} ${endAbbr}`;
    }
  }
  return { start, abbr, clock, period, crossZone };
}
