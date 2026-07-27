import { useState } from "react";
import { AirplaneTakeoff, Bed, Car, Confetti, ForkKnife } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type { Booking, Person, Trip, TripRollup } from "../api/types.js";
import { formatBookingWhen } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { formatMoney } from "../lib/money.js";
import { PersonChips } from "../components/PersonChip.js";
import { MaskedValue } from "../components/MaskedValue.js";
import { CostRollup } from "./CostRollup.js";

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
};

export function OverviewTab({
  trip,
  bookings,
  people,
  rollup,
  api,
  onStatusChanged,
  onBookingClick,
}: {
  trip: Trip;
  bookings: Booking[];
  people: Person[];
  rollup: TripRollup | null;
  api: typeof defaultApi;
  /**
   * Optional so plan 3's existing OverviewTab tests, which do not supply it,
   * keep passing unchanged. When absent, Book → is not rendered — the same
   * "no dead controls" rule, applied to a component used in two places.
   */
  onStatusChanged?: () => void;
  onBookingClick?: (booking: Booking) => void;
}) {
  // Cancelled bookings are not part of the trip. The server already excludes
  // them from listByTrip and RollupRepo excludes them from the totals; the
  // component agreeing is what stops a cancelled row from rendering as a
  // dashed "still to do" item next to a cost panel that has never heard of it.
  const visible = bookings.filter((b) => b.status !== "cancelled");

  const [failed, setFailed] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  if (visible.length === 0) {
    return <p className="text-muted">Nothing booked yet for this trip.</p>;
  }

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
      {failed && (
        <p className="warning" role="alert" style={{ flexBasis: "100%" }}>
          {failed}
        </p>
      )}
      <div style={{ flex: "2 1 520px", display: "flex", flexDirection: "column", gap: 20 }}>
        {GROUPS.map(({ heading, kinds }) => {
          const group = visible.filter((b) => kinds.includes(b.kind));
          if (group.length === 0) return null;

          return (
            <section key={heading}>
              <h6 className="card-kicker">{heading}</h6>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {group.map((b) => {
                  const Icon = ICONS[b.kind] ?? ForkKnife;
                  // Three distinct states, not two. `planned` is a decision
                  // the family has made but not yet paid for; `draft` is an
                  // unreviewed email import that no one has confirmed is even
                  // real, and which the cost rollup deliberately ignores.
                  const isDraft = b.status === "draft";
                  const needsBooking = b.status === "planned";
                  const provisional = isDraft || needsBooking;
                  return (
                    <div
                      key={b.id}
                      className="card"
                      onClick={() => onBookingClick?.(b)}
                      style={
                        provisional
                          ? {
                              border: "1px dashed var(--color-divider)",
                              background: "none",
                              cursor: onBookingClick ? "pointer" : undefined,
                            }
                          : { cursor: onBookingClick ? "pointer" : undefined }
                      }
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Icon size={18} />
                        {onBookingClick ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            aria-label={`View details for ${b.title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onBookingClick(b);
                            }}
                            style={{ fontSize: 15, fontWeight: 500, padding: 0 }}
                          >
                            {b.title}
                          </button>
                        ) : (
                          <span style={{ fontSize: 15, fontWeight: 500 }}>{b.title}</span>
                        )}
                        {isDraft && <span className="tag">Draft</span>}
                        {needsBooking && <span className="tag">Needs booking</span>}
                        <span style={{ marginLeft: "auto" }}>
                          <PersonChips
                            people={people.filter((p) => b.personIds.includes(p.id))}
                          />
                        </span>
                      </div>
                      <div className="card-meta">
                        <span>{formatBookingWhen(b, "No date yet")}</span>
                        {b.confirmationNumberMasked && (
                          <span onClick={(event) => event.stopPropagation()}>
                            <MaskedValue
                              masked={b.confirmationNumberMasked}
                              onReveal={async () =>
                                (await api.trips.revealConfirmation(trip.id, b.id)).value
                              }
                            />
                          </span>
                        )}
                        {b.costCents !== null && (
                          <span style={{ marginLeft: "auto" }}>
                            {formatMoney(b.costCents)}
                          </span>
                        )}
                        {provisional && onStatusChanged && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ fontSize: 11 }}
                            aria-label={`Book ${b.title}`}
                            disabled={busyId === b.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              void book(b.id);
                            }}
                          >
                            Book →
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <aside style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 14 }}>
        {rollup && <CostRollup rollup={rollup} />}
      </aside>
    </div>
  );
}
