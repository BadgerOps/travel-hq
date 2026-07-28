import { AirplaneTakeoff, Bed, Car, Confetti, Suitcase } from "@phosphor-icons/react";
import type { ExtractedBooking } from "../api/types.js";
import { formatMoney } from "../lib/money.js";
// The draft-card styles live with the Import page (2b anatomy), but this card
// also renders inside Settings' "Test extraction" preview — import the sheet
// here so the anatomy holds wherever the card appears.
import "../pages/import.css";

/* Per-kind icon plus the 2b field-label pairs: Departs/Arrives for flights,
   Check-in/Check-out for lodging, Pickup/Drop-off for cars. */
const KIND_META: Record<
  string,
  { Icon: typeof AirplaneTakeoff; start: string; end: string }
> = {
  flight: { Icon: AirplaneTakeoff, start: "Departs", end: "Arrives" },
  lodging: { Icon: Bed, start: "Check-in", end: "Check-out" },
  car: { Icon: Car, start: "Pickup", end: "Drop-off" },
  activity: { Icon: Confetti, start: "Starts", end: "Ends" },
  other: { Icon: Suitcase, start: "Starts", end: "Ends" },
};

export function DraftBookingCard({ booking }: { booking: ExtractedBooking }) {
  const { Icon, start, end } = KIND_META[booking.kind] ?? KIND_META.other;
  const starts = formatStamp(booking.startsAt, booking.startsAtTz);
  const ends = formatStamp(booking.endsAt, booking.endsAtTz);
  const cost =
    typeof booking.costCents === "number" ? formatMoney(booking.costCents) : null;
  const hasFields = Boolean(starts || ends || booking.confirmationNumber || cost);

  return (
    <article className="card draft-card">
      <header className="draft-head">
        <Icon size={20} aria-hidden="true" />
        <div className="draft-titles">
          <span className="card-kicker">{booking.kind}</span>
          <strong className="draft-title">{booking.title}</strong>
          {booking.location && <span className="draft-location">{booking.location}</span>}
        </div>
        <span className="tag tag-accent draft-tag">Draft</span>
      </header>
      {hasFields && (
        <>
          <hr className="hr draft-rule" />
          <div className="draft-fields">
            {starts && <Field label={start} stamp={starts} />}
            {ends && <Field label={end} stamp={ends} />}
            {booking.confirmationNumber && (
              <div className="draft-field">
                <span className="draft-field-label">Confirmation</span>
                {booking.confirmationNumber}{" "}
                <span className="draft-field-note">· stored masked</span>
              </div>
            )}
            {cost && (
              <div className="draft-field">
                <span className="draft-field-label">Cost</span>
                {cost}
              </div>
            )}
          </div>
        </>
      )}
    </article>
  );
}

function Field({ label, stamp }: { label: string; stamp: Stamp }) {
  return (
    <div className="draft-field">
      <span className="draft-field-label">{label}</span>
      {stamp.text}
      {stamp.note && <span className="draft-field-note"> {stamp.note}</span>}
    </div>
  );
}

type Stamp = { text: string; note: string | null };

/**
 * Render the timestamp in the booking's own timezone with a short zone note
 * ("MDT"), per the dual-timezone rule. Unparseable values pass through
 * verbatim; an invalid zone falls back to the viewer's local time.
 */
function formatStamp(
  value: string | null | undefined,
  tz: string | null | undefined,
): Stamp | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return { text: value, note: null };
  try {
    const text = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    }).format(date);
    const note = tz
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
          .formatToParts(date)
          .find((part) => part.type === "timeZoneName")?.value ?? null
      : null;
    return { text, note };
  } catch {
    return { text: date.toLocaleString(), note: null };
  }
}
