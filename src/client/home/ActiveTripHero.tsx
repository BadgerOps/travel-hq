import { AirplaneTakeoff, Bed, Car, Ticket, Confetti } from "@phosphor-icons/react";
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
 * before this is called — so "NOW" is reserved for the event that is starting
 * this minute rather than being pinned on anything already over. That
 * mislabelling was the bug: on day 2 of a trip the hero announced day 1's
 * departed flight as happening NOW.
 */
function untilLabel(minutes: number): string {
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `IN ${minutes} MIN`;
  return `IN ${Math.round(minutes / 60)} HR`;
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
      <div className="hero-active" style={{ flex: "1.5 1 480px" }}>
        <h6 style={{ color: "var(--color-accent-300)" }}>{trip.title}</h6>
        <p className="text-muted">
          {day && day.bookings.length > 0
            ? "Nothing else scheduled today."
            : "Nothing scheduled today."}
        </p>
      </div>
    );
  }

  const NextIcon = iconFor(next.kind);
  const peopleOn = (b: Booking) => people.filter((p) => b.personIds.includes(p.id));

  return (
    <div className="hero-active" style={{ flex: "1.5 1 480px" }}>
      <h6 style={{ color: "var(--color-accent-300)" }}>
        NEXT UP · {untilLabel(minutesUntil(next.startsAt!, now))}
      </h6>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
        <NextIcon size={30} color="var(--color-accent)" />
        <div>
          <div style={{ fontSize: 18, fontWeight: 500 }}>{next.title}</div>
          <div style={{ fontSize: 12.5 }} className="text-muted">
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
        <div style={{ marginLeft: "auto" }}>
          <PersonChips people={peopleOn(next)} />
        </div>
      </div>

      <hr className="hr" />

      {/* The rest of TODAY, not the rest of the trip: `rest` is what remains
          of `upcoming`, which was already scoped to today's ItineraryDay. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rest.slice(0, 3).map((b) => {
          const Icon = iconFor(b.kind);
          return (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="time-gutter">
                {formatTimeInZone(b.startsAt!, b.startsAtTz ?? "UTC")}
              </span>
              <Icon size={16} />
              <span style={{ fontSize: 13 }}>{b.title}</span>
              <span style={{ marginLeft: "auto" }}>
                <PersonChips people={peopleOn(b)} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
