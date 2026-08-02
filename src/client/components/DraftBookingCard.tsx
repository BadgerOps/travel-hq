import { AirplaneTakeoff, Bed, Car, Confetti, Suitcase } from "@phosphor-icons/react";
import type { ExtractedBooking, PendingImportDraft } from "../api/types.js";
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

/**
 * How a draft came to exist, in the words the rest of the app already uses for
 * it (see `InboundEmailDetailDialog`). It matters to a reviewer because it says
 * how much to trust the fields underneath: a calendar attachment was written by
 * the airline, while an AI reading of prose is a suggestion that might have put
 * the gate time in the wrong zone. Same distinction, same wording, so the two
 * screens cannot drift apart.
 */
const SOURCE_LABEL: Record<PendingImportDraft["extractionSource"], string> = {
  ics: "from calendar",
  ai: "from AI",
};

export function DraftBookingCard({
  booking,
  /**
   * Optional because the freshly-uploaded preview on `/import` and Settings'
   * "Test extraction" render extractions that are not draft rows yet and have
   * no recorded source. The chip is simply absent there rather than guessed at.
   */
  source,
}: {
  booking: ExtractedBooking;
  source?: PendingImportDraft["extractionSource"];
}) {
  const { Icon, start, end } = KIND_META[booking.kind] ?? KIND_META.other;
  const starts = formatStamp(booking.startsAt, booking.startsAtTz);
  const ends = formatStamp(booking.endsAt, booking.endsAtTz);
  const cost =
    typeof booking.costCents === "number" ? formatMoney(booking.costCents) : null;
  const highlights = detailHighlights(booking.details);
  const hasFields = Boolean(starts || ends || booking.confirmationNumber || cost || highlights.length);

  return (
    <article className="card draft-card">
      <header className="draft-head">
        <Icon size={20} aria-hidden="true" />
        <div className="draft-titles">
          <span className="card-kicker">{booking.kind}</span>
          <strong className="draft-title">{booking.title}</strong>
          {booking.location && <span className="draft-location">{booking.location}</span>}
        </div>
        <span className="draft-tags">
          {source && (
            <span className="tag tag-neutral draft-tag">{SOURCE_LABEL[source]}</span>
          )}
          <span className="tag tag-accent draft-tag">Draft</span>
        </span>
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
            {highlights.map(([label, value]) => (
              <div className="draft-field" key={label}>
                <span className="draft-field-label">{label}</span>
                {value}
              </div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

function detailHighlights(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const details = value as Record<string, unknown>;
  const wanted: Array<[string, string]> = [
    ["checkInDate", "Check-in date"],
    ["checkOutDate", "Check-out date"],
    ["nights", "Nights"],
    ["siteNumber", "Site"],
    ["siteType", "Site type"],
    ["roomType", "Room"],
    ["partySize", "Party size"],
    ["ticketQuantity", "Tickets"],
    ["pickupTime", "Pickup"],
    ["pickupLocation", "Pickup location"],
    ["returnTime", "Return"],
    ["operator", "Operator"],
  ];
  return wanted.flatMap(([key, label]) => {
    const item = details[key];
    return typeof item === "string" || typeof item === "number"
      ? [[label, detailValue(key, item)] as [string, string]]
      : [];
  }).slice(0, 8);
}

function detailValue(key: string, value: string | number): string {
  if ((key === "checkInDate" || key === "checkOutDate") && typeof value === "string") {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(date.valueOf())) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
    }
  }
  return String(value);
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
