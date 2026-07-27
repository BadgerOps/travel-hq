import { useEffect, useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type {
  Booking,
  BookingSourceArtifact,
} from "../api/types.js";
import { formatBookingWhen } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { formatMoney } from "../lib/money.js";
import { Dialog } from "./Dialog.js";
import { MaskedValue } from "./MaskedValue.js";
import { StructuredDetails } from "./StructuredDetails.js";

export function BookingDetailDialog({
  booking,
  api = defaultApi,
  onClose,
}: {
  booking: Booking;
  api?: typeof defaultApi;
  onClose: () => void;
}) {
  const [artifact, setArtifact] = useState<BookingSourceArtifact | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.bookings.artifact(booking.id).then(
      (result) => {
        if (!cancelled) setArtifact(result.artifact);
      },
      (err) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, booking.id]);

  return (
    <Dialog title={booking.title} subtitle="Booking details" onClose={onClose}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <span className="tag tag-accent">{booking.kind}</span>
          <span className="tag tag-neutral">{booking.status}</span>
        </div>
        <div className="card-meta">{formatBookingWhen(booking, "No date yet")}</div>
        {booking.location && <div className="card-body">{booking.location}</div>}
        {booking.confirmationNumberMasked && (
          <div className="card-meta">
            Confirmation{" "}
            <MaskedValue
              masked={booking.confirmationNumberMasked}
              onReveal={async () =>
                (await api.trips.revealConfirmation(booking.tripId, booking.id)).value
              }
            />
          </div>
        )}
        {booking.costCents !== null && (
          <div className="card-meta">Cost {formatMoney(booking.costCents)}</div>
        )}
        {hasDetails(booking.details) && (
          <>
            <h5 style={{ margin: "4px 0 0" }}>Booking details</h5>
            <StructuredDetails value={booking.details} />
          </>
        )}

        <hr className="hr" style={{ margin: "4px 0" }} />
        <h5 style={{ margin: 0 }}>Source artifact</h5>
        {error && <p className="warning" role="alert" style={{ margin: 0 }}>{error}</p>}
        {artifact === undefined && !error && (
          <p className="text-muted" role="status" style={{ margin: 0 }}>
            Loading parsed email…
          </p>
        )}
        {artifact === null && (
          <p className="text-muted" style={{ margin: 0 }}>
            This booking was entered manually and has no source email.
          </p>
        )}
        {artifact && (
          <div style={{ display: "grid", gap: 8 }}>
            <strong>{artifact.subject || "Untitled email"}</strong>
            <div className="card-meta">
              From {artifact.from} · {formatReceivedAt(artifact.receivedAt)}
            </div>
            {artifact.textBody ? (
              <pre style={artifactTextStyle}>{artifact.textBody}</pre>
            ) : (
              <p className="text-muted" style={{ margin: 0 }}>
                No readable message body was found.
              </p>
            )}
            {artifact.calendars.map((calendar, index) => (
              <details key={index}>
                <summary>
                  Calendar artifact {artifact.calendars.length > 1 ? index + 1 : ""}
                </summary>
                <pre style={artifactTextStyle}>{calendar}</pre>
              </details>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const artifactTextStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 320,
  overflow: "auto",
  margin: "6px 0 0",
  padding: 10,
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg)",
  fontSize: 12,
} as const;

function hasDetails(value: unknown): boolean {
  return value !== null &&
    typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length > 0;
}

function formatReceivedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
