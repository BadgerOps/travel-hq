import type { ExtractedBooking } from "../api/types.js";

export function DraftBookingCard({ booking }: { booking: ExtractedBooking }) {
  const timing = [formatDate(booking.startsAt), formatDate(booking.endsAt)]
    .filter(Boolean)
    .join(" – ");
  return (
    <article className="card" style={{ alignItems: "flex-start", gap: 6 }}>
      <span className="card-kicker">{booking.kind}</span>
      <strong className="card-title">{booking.title}</strong>
      {booking.location && <span className="card-body">{booking.location}</span>}
      {timing && <span className="card-meta">{timing}</span>}
      {booking.confirmationNumber && (
        <span className="card-meta">Confirmation {booking.confirmationNumber}</span>
      )}
    </article>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
