import { Link } from "wouter";
import {
  AirplaneTakeoff,
  ArrowRight,
  Bed,
  Car,
  Confetti,
  Ticket,
} from "@phosphor-icons/react";
import type { Booking, ItineraryDay, Person, Trip } from "../api/types.js";
import { formatTimeInZone } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";
import { MaskedValue } from "../components/MaskedValue.js";

const KIND_ICON = {
  flight: AirplaneTakeoff,
  lodging: Bed,
  car: Car,
  activity: Confetti,
  other: Ticket,
} as const;

function iconFor(kind: string) {
  return KIND_ICON[kind as keyof typeof KIND_ICON] ?? Ticket;
}

function minutesUntil(startsAt: string, now: Date): number {
  return Math.round((Date.parse(startsAt) - now.getTime()) / 60_000);
}

/**
 * `minutes` can no longer be negative — everything past has been filtered out
 * before this is called — so "now" is reserved for the event that is starting
 * this minute rather than being pinned on anything already over. That
 * mislabelling was the bug: on day 2 of a trip the hero announced day 1's
 * departed flight as happening NOW.
 */
function untilLabel(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.round(minutes / 60)} h`;
}

/** The two 2a buttons — shared by the with-next and nothing-left states. */
function HeroActions({ tripId }: { tripId: string }) {
  return (
    <div className="hero-actions">
      <Link href={`/trips/${tripId}#days`} className="btn btn-primary">
        Open day view <ArrowRight size={14} />
      </Link>
      <Link href={`/trips/${tripId}`} className="btn btn-secondary">
        Trip details
      </Link>
    </div>
  );
}

export function ActiveTripHero({
  trip,
  day,
  people,
  now,
  onReveal,
}: {
  trip: Trip;
  /**
   * Today's `ItineraryDay` from GET /api/trips/:id/itinerary, or undefined if
   * today has no entries. The server has already grouped bookings into
   * calendar days in each booking's own timezone and sorted them ascending —
   * do not regroup or re-sort here.
   */
  day: ItineraryDay | undefined;
  people: Pick<Person, "id" | "displayName">[];
  now: Date;
  onReveal: (bookingId: string) => Promise<string | null>;
}) {
  // The only client-side filter, and it needs no timezone reasoning: both
  // sides are absolute instants. Everything still ahead of us today, in
  // order; the server's ORDER BY starts_at is preserved.
  const upcoming = (day?.bookings ?? []).filter(
    (b) => b.startsAt !== null && Date.parse(b.startsAt) >= now.getTime(),
  );

  const [next, ...rest] = upcoming;
  if (!next) {
    return (
      <div className="hero-active hero-main">
        <h6 style={{ color: "var(--color-accent-300)" }}>{trip.title}</h6>
        <p className="text-muted">
          {day && day.bookings.length > 0
            ? "Nothing else scheduled today."
            : "Nothing scheduled today."}
        </p>
        <HeroActions tripId={trip.id} />
      </div>
    );
  }

  const NextIcon = iconFor(next.kind);
  const peopleOn = (b: Booking) => people.filter((p) => b.personIds.includes(p.id));

  return (
    <div className="hero-active hero-main">
      <div className="hero-kicker-row">
        <h6 style={{ color: "var(--color-accent-300)" }}>
          Next up · {untilLabel(minutesUntil(next.startsAt!, now))}
        </h6>
        {rest.length > 0 && (
          <span className="hero-more">
            then {rest.length} more today
          </span>
        )}
      </div>

      <div className="hero-next">
        <NextIcon size={30} color="var(--color-accent)" />
        <div className="hero-next-main">
          <div className="hero-next-title">{next.title}</div>
          <div className="hero-next-sub">
            {formatTimeInZone(next.startsAt!, next.startsAtTz ?? "UTC")}
            {next.confirmationNumberMasked && (
              <>
                {" · conf "}
                <MaskedValue
                  masked={next.confirmationNumberMasked}
                  onReveal={() => onReveal(next.id)}
                />
              </>
            )}
          </div>
        </div>
        <div className="hero-next-chips">
          <PersonChips people={peopleOn(next)} />
        </div>
      </div>

      <hr className="hr" />

      {/* The rest of TODAY, not the rest of the trip: `rest` is what remains
          of `upcoming`, which was already scoped to today's ItineraryDay. */}
      <div className="hero-rest">
        {rest.slice(0, 3).map((b) => {
          const Icon = iconFor(b.kind);
          return (
            <div key={b.id} className="hero-rest-row">
              <span className="time-gutter">
                {formatTimeInZone(b.startsAt!, b.startsAtTz ?? "UTC")}
              </span>
              <Icon size={16} color="var(--color-accent)" />
              <span style={{ fontSize: 13 }}>{b.title}</span>
              <span className="hero-rest-chips">
                <PersonChips people={peopleOn(b)} />
              </span>
            </div>
          );
        })}
      </div>

      <HeroActions tripId={trip.id} />
    </div>
  );
}
