import { useState } from "react";
import { AirplaneTakeoff, Bed, Car, Confetti, Ticket } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type { Booking, Person, Trip } from "../api/types.js";
import { formatBookingWhen } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { PersonChips } from "../components/PersonChip.js";
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

export function OverviewTab({
  trip,
  bookings,
  people,
  api,
  onStatusChanged,
  onBookingClick,
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
}) {
  // Cancelled bookings are not part of the trip. Keep this event-focused
  // overview aligned with the itinerary and the separate Costs tab.
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {failed && (
        <p className="warning" role="alert">
          {failed}
        </p>
      )}
      {GROUPS.map(({ heading, kinds }) => {
          const group = visible.filter((b) => kinds.includes(b.kind));
          if (group.length === 0) return null;

          return (
            <section key={heading}>
              <h6 className="card-kicker">{heading}</h6>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {group.map((b) => {
                  const Icon = ICONS[b.kind] ?? Ticket;
                  const highlights = bookingHighlights(b);
                  // Three distinct states, not two. `planned` is a decision
                  // the family has made but not yet paid for; `draft` is an
                  // unreviewed email import that no one has confirmed is even
                  // real, and which the Costs tab deliberately ignores.
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
                      {highlights.length > 0 && (
                        <div className="card-meta">
                          {highlights.map((highlight) => (
                            <span key={highlight}>{highlight}</span>
                          ))}
                        </div>
                      )}
                      <div className="card-meta">
                        <span>{formatBookingWhen(b, "No date yet")}</span>
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
