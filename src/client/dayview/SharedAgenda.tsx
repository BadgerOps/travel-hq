import type { Booking, Person } from "../api/types.js";
import type { CSSProperties } from "react";
import { formatBookingWhen } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";

/**
 * Day view shape 1c — one shared timeline for the whole family, with a person
 * filter above it. Shape 1d (column per person) is backlogged as a desktop-only
 * toggle; keep this component's props free of anything shape-specific so it
 * stays swappable behind DayView.
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
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {bookings.map((b) => {
        // Same three-state vocabulary as OverviewTab: a hollow dot and a
        // dashed card mean "not confirmed" (planned or draft). The server's
        // itinerary query already excludes cancelled bookings.
        const provisional = b.status !== "booked";
        const cardStyle: CSSProperties = {
          flex: 1,
          maxWidth: 760,
          margin: "6px 0",
          width: "100%",
          color: "inherit",
          font: "inherit",
          textAlign: "left",
          cursor: onBookingClick ? "pointer" : "default",
          ...(provisional
            ? { border: "1px dashed var(--color-divider)", background: "none" }
            : {}),
        };
        const content = (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 500 }}>{b.title}</span>
              <span style={{ marginLeft: "auto" }}>
                <PersonChips people={people.filter((p) => b.personIds.includes(p.id))} />
              </span>
            </div>
            {b.location && <div className="card-meta">{b.location}</div>}
          </>
        );
        return (
          <div key={b.id} style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
            <div
              className="time-gutter"
              style={{ width: 150, paddingTop: 14, fontSize: 12.5 }}
            >
              {formatBookingWhen(b, "")}
            </div>

            {/* The timeline spine: a continuous accent rule with a dot per event. */}
            <div
              style={{
                width: 1,
                background: "var(--color-accent-800)",
                position: "relative",
                flex: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 18,
                  left: -4,
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: provisional ? "transparent" : "var(--color-accent)",
                  border: provisional ? "1px solid var(--color-accent)" : "none",
                }}
              />
            </div>

            {onBookingClick ? (
              <button
                type="button"
                className="card"
                aria-label={`View details for ${b.title}`}
                onClick={() => onBookingClick(b)}
                style={cardStyle}
              >
                {content}
              </button>
            ) : (
              <div className="card" style={cardStyle}>{content}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
