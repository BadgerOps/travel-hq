import { useEffect, useState } from "react";
import { Clock, MapPin, PencilSimple } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type {
  Booking,
  BookingSourceArtifact,
  Person,
} from "../api/types.js";
import { useCanWrite } from "../api/identity.js";
import { formatBookingWhen } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { formatMoney } from "../lib/money.js";
import { BookingDialog } from "../trip/BookingDialog.js";
import { Dialog } from "./Dialog.js";
import { MaskedValue } from "./MaskedValue.js";
import { StructuredDetails } from "./StructuredDetails.js";
import { TravelerToggles } from "./TravelerToggles.js";

/**
 * The logistics keys this dialog renders itself, in the order it renders
 * them. They are lifted out of the generic label–value grid because for an
 * excursion they ARE the booking: "Pickup 1:30 PM · Quarter Circle/West Side
 * Parking Lot" is what someone opens this dialog on the morning of the tour
 * to read, and "Arrive minutes before: 15" buried between "Operator" and
 * "Party size" is not that.
 *
 * Kept in sync by hand with `activityDetails`/`carDetails` in
 * src/server/schemas/booking-kinds.ts — the client may import types from the
 * server but not values, so there is nothing to share.
 */
const LOGISTICS_KEYS = [
  "pickupTime",
  "pickupLocation",
  "arriveMinutesBefore",
  "returnTime",
  "dropoffTime",
  "dropoffLocation",
] as const;

export function BookingDetailDialog({
  booking,
  people = [],
  api = defaultApi,
  onPeopleChanged,
  onSaved,
  onClose,
}: {
  booking: Booking;
  people?: Person[];
  api?: typeof defaultApi;
  onPeopleChanged?: () => void;
  /**
   * Called after an edit is saved. The booking this dialog was handed is a
   * snapshot the parent owns, so the parent — not this component — decides
   * how to refresh it (TripDetail reloads the trip and closes the dialog).
   */
  onSaved?: () => void;
  onClose: () => void;
}) {
  const [artifact, setArtifact] = useState<BookingSourceArtifact | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [personIds, setPersonIds] = useState(booking.personIds);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const canWrite = useCanWrite();

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

  async function togglePerson(personId: string) {
    if (peopleBusy) return;
    const assigned = personIds.includes(personId);
    setPeopleBusy(true);
    setPeopleError(null);
    try {
      if (assigned) {
        await api.bookings.unassignPerson(booking.id, personId);
        setPersonIds((current) => current.filter((id) => id !== personId));
      } else {
        await api.bookings.assignPerson(booking.id, personId);
        setPersonIds((current) => [...current, personId]);
      }
      onPeopleChanged?.();
    } catch (err) {
      setPeopleError(errorMessage(err));
    } finally {
      setPeopleBusy(false);
    }
  }

  // The edit form replaces this dialog rather than stacking a second one on
  // top of it: two nested modals share one Escape key and one scroll lock.
  if (editing) {
    return (
      <BookingDialog
        // `personIds`, not `booking.personIds`: the toggles above write
        // through to the server immediately, so the prop is already stale if
        // anyone was linked or unlinked before Edit was pressed — and the edit
        // form diffs against what it was seeded with, which would undo them.
        booking={{ ...booking, personIds }}
        people={people}
        api={api}
        onSaved={() => {
          setEditing(false);
          // The snapshot this dialog holds is now stale; the parent refreshes.
          (onSaved ?? onPeopleChanged)?.();
        }}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <Dialog title={booking.title} subtitle="Booking details" onClose={onClose}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          <span className="tag tag-accent">{booking.kind}</span>
          <span className="tag tag-neutral">{booking.status}</span>
          {canWrite && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: "auto" }}
              aria-label={`Edit ${booking.title}`}
              onClick={() => setEditing(true)}
            >
              <PencilSimple size={14} /> Edit
            </button>
          )}
        </div>
        <div className="card-meta">{formatBookingWhen(booking, "No date yet")}</div>
        {booking.location && <div className="card-body">{booking.location}</div>}
        <ExcursionLogistics details={booking.details} />
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
        {hasDetails(booking.details, LOGISTICS_KEYS) && (
          <>
            <h5 style={{ margin: "4px 0 0" }}>Booking details</h5>
            {/* The logistics are already rendered above, in their own block. */}
            <StructuredDetails value={booking.details} omit={[...LOGISTICS_KEYS]} />
          </>
        )}

        {people.length > 0 && (
          <>
            <hr className="hr" style={{ margin: "4px 0" }} />
            <h5 style={{ margin: 0 }}>Travelers</h5>
            <p className="text-muted" style={{ margin: 0 }}>
              Profile emails are linked automatically when the reservation identifies
              them. You can adjust this event manually.
            </p>
            {peopleError && (
              <p className="warning" role="alert" style={{ margin: 0 }}>
                {peopleError}
              </p>
            )}
            {canWrite ? (
              <div aria-busy={peopleBusy}>
                <TravelerToggles
                  people={people}
                  selected={personIds}
                  onToggle={(personId) => void togglePerson(personId)}
                />
              </div>
            ) : (
              <p className="card-meta" style={{ margin: 0 }}>
                {people
                  .filter((person) => personIds.includes(person.id))
                  .map((person) => person.displayName)
                  .join(", ") || "No travelers linked"}
              </p>
            )}
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

/**
 * The pickup/return block: where to stand, when, and how early. Rendered
 * above the fold for any booking that carries the keys, whatever its kind —
 * an excursion imported from a calendar attachment is stored as `other`, and
 * hiding its pickup behind a kind check would hide it for exactly the
 * bookings that need it most.
 */
function ExcursionLogistics({ details }: { details: unknown }) {
  const record = asRecord(details);
  const pickupTime = text(record.pickupTime);
  const pickupLocation = text(record.pickupLocation);
  const returnTime = text(record.returnTime) || text(record.dropoffTime);
  const returnLocation = text(record.dropoffLocation);
  const arriveEarly = typeof record.arriveMinutesBefore === "number"
    ? record.arriveMinutesBefore
    : null;

  if (!pickupTime && !pickupLocation && !returnTime && !returnLocation && arriveEarly === null) {
    return null;
  }

  return (
    <div className="booking-logistics">
      {(pickupTime || pickupLocation) && (
        <div className="booking-logistics-row">
          <Clock size={14} />
          <span>
            <strong>Pickup</strong>
            {pickupTime && ` ${pickupTime}`}
            {pickupLocation && (
              <>
                {" · "}
                <MapPin size={12} /> {pickupLocation}
              </>
            )}
          </span>
        </div>
      )}
      {arriveEarly !== null && (
        <div className="booking-logistics-row booking-logistics-row--note">
          <span>
            Arrive {arriveEarly} {arriveEarly === 1 ? "minute" : "minutes"} early
          </span>
        </div>
      )}
      {(returnTime || returnLocation) && (
        <div className="booking-logistics-row">
          <Clock size={14} />
          <span>
            <strong>Return</strong>
            {returnTime && ` ${returnTime}`}
            {returnLocation && (
              <>
                {" · "}
                <MapPin size={12} /> {returnLocation}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * True when there is anything left to show once `omit`ted keys are removed —
 * without the filter, a booking whose only details ARE its logistics renders
 * an empty "Booking details" heading under the block that already showed them.
 */
function hasDetails(value: unknown, omit: readonly string[]): boolean {
  return Object.entries(asRecord(value)).some(
    ([key, entry]) =>
      !omit.includes(key) && entry !== null && entry !== undefined && entry !== "",
  );
}

function formatReceivedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
