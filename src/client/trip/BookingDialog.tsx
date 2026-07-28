import { useState } from "react";
import { AirplaneTakeoff, Bed, Car, ForkKnife, Ticket } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type {
  Booking,
  BookingStatus,
  Person,
  Trip,
  UpdateBookingInput,
} from "../api/types.js";
import { utcToZonedLocal, zonedToUtc } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "../components/Dialog.js";
import { TravelerToggles } from "../components/TravelerToggles.js";

/**
 * Exploration 1g: one dialog, a kind segmented control that morphs the middle
 * fieldset, "who's on it" per booking (not per trip), cost, and a
 * Planned/Booked status control.
 *
 * It is also the EDIT form (pass `booking`), so there is exactly one place
 * that knows which field belongs to which kind. A second, read-only-shaped
 * "edit booking" dialog is how the add form and the edit form end up
 * disagreeing about what a car rental has.
 *
 * The kind list matches BOOKING_KINDS on the server, "other" included: every
 * booking parsed out of a calendar attachment lands as `other`, and an edit
 * form that cannot show that kind would silently retype an imported excursion
 * as a flight the moment it was saved.
 */
const KINDS = [
  { id: "flight", label: "Flight", Icon: AirplaneTakeoff },
  { id: "lodging", label: "Stay", Icon: Bed },
  { id: "car", label: "Car", Icon: Car },
  { id: "activity", label: "Activity", Icon: Ticket },
  // ForkKnife is the icon OverviewTab already gives an unrecognised kind, so
  // the row a freeform booking gets and the option that produces it match.
  { id: "other", label: "Other", Icon: ForkKnife },
] as const;

type Kind = (typeof KINDS)[number]["id"];

/** The kinds whose logistics are "be standing here at this time". */
const EXCURSION_KINDS = new Set<Kind>(["activity", "other"]);

/**
 * A short, curated zone list rather than `Intl.supportedValuesOf("timeZone")`
 * — that returns ~600 entries, which is an unusable <select>, and it is not
 * available on every runtime (the server code avoids it for the same reason).
 * The viewer's own zone is prepended so the common case is one click.
 */
const COMMON_ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Boise",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Honolulu",
  "UTC",
];

/**
 * The viewer's zone, then the curated list, then whatever zones this booking
 * is actually stored in — an imported booking can carry a zone that is on
 * neither list, and a <select> without its own value silently reassigns it.
 */
function zoneOptions(booking?: Booking): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stored = [booking?.startsAtTz, booking?.endsAtTz].filter(
    (zone): zone is string => typeof zone === "string" && zone !== "",
  );
  return [...new Set([local, ...COMMON_ZONES, ...stored])];
}

/** "684.30" -> 68430. Returns undefined for blank, null for unparseable. */
function toCents(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** "15" -> 15. Returns undefined for blank, null for unparseable/negative. */
function toMinutes(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > 720) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A stored detail as form text. Numbers included — `arriveMinutesBefore`. */
function detailText(details: unknown, key: string): string {
  const value = asRecord(details)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function seedKind(booking: Booking | undefined): Kind {
  const match = KINDS.find((k) => k.id === booking?.kind);
  return match?.id ?? "flight";
}

/** A stored UTC instant as the wall clock its own zone shows. */
function seedLocal(at: string | null | undefined, tz: string | null | undefined): string {
  return at && tz ? utcToZonedLocal(at, tz) : "";
}

export function BookingDialog({
  trip,
  booking,
  people,
  api = defaultApi,
  onSaved,
  onClose,
}: {
  /** Required to CREATE — the trip the new booking is added to. */
  trip?: Trip;
  /** Present to EDIT. The booking's own tripId is used, so `trip` is optional
   *  here: the detail dialog that launches an edit has the booking, not the
   *  trip. */
  booking?: Booking;
  /** The trip's travellers, so the toggles list who is actually on this trip. */
  people: Person[];
  api?: typeof defaultApi;
  onSaved: () => void;
  onClose: () => void;
}) {
  const editing = booking !== undefined;

  const [kind, setKind] = useState<Kind>(() => seedKind(booking));
  const [title, setTitle] = useState(booking?.title ?? "");
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [location, setLocation] = useState(booking?.location ?? "");

  // Per-kind detail fields. Held flat and assembled per kind at submit time,
  // so switching kinds does not discard what was typed.
  const [carrier, setCarrier] = useState(() => detailText(booking?.details, "carrier"));
  const [flightNumber, setFlightNumber] = useState(() =>
    detailText(booking?.details, "flightNumber"),
  );
  const [originIata, setOriginIata] = useState(() => detailText(booking?.details, "originIata"));
  const [destinationIata, setDestinationIata] = useState(() =>
    detailText(booking?.details, "destinationIata"),
  );
  const [propertyName, setPropertyName] = useState(() =>
    detailText(booking?.details, "propertyName"),
  );
  const [vendor, setVendor] = useState(() => detailText(booking?.details, "vendor"));
  const [venue, setVenue] = useState(() => detailText(booking?.details, "venue"));

  // Excursion (and car) logistics: the pickup and the return. Wall-clock text,
  // not timestamps — see the note on `activityDetails` in the server's
  // booking-kinds schema for why an operator's "Approximate return time: 5:00"
  // must not be promoted to an instant.
  const [pickupTime, setPickupTime] = useState(() => detailText(booking?.details, "pickupTime"));
  const [pickupLocation, setPickupLocation] = useState(() =>
    detailText(booking?.details, "pickupLocation"),
  );
  const [arriveEarly, setArriveEarly] = useState(() =>
    detailText(booking?.details, "arriveMinutesBefore"),
  );
  const [returnTime, setReturnTime] = useState(() =>
    detailText(booking?.details, "returnTime") || detailText(booking?.details, "dropoffTime"),
  );
  const [dropoffLocation, setDropoffLocation] = useState(() =>
    detailText(booking?.details, "dropoffLocation"),
  );
  const [description, setDescription] = useState(() =>
    detailText(booking?.details, "description"),
  );

  const [startsAt, setStartsAt] = useState(() =>
    seedLocal(booking?.startsAt, booking?.startsAtTz),
  );
  const [startsAtTz, setStartsAtTz] = useState(booking?.startsAtTz ?? "");
  const [endsAt, setEndsAt] = useState(() => seedLocal(booking?.endsAt, booking?.endsAtTz));
  const [endsAtTz, setEndsAtTz] = useState(booking?.endsAtTz ?? "");

  const [selected, setSelected] = useState<string[]>(booking?.personIds ?? []);
  const [cost, setCost] = useState(() =>
    booking?.costCents === null || booking?.costCents === undefined
      ? ""
      : (booking.costCents / 100).toFixed(2),
  );
  const [status, setStatus] = useState<BookingStatus>(booking?.status ?? "booked");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zones = zoneOptions(booking);
  const showExcursion = EXCURSION_KINDS.has(kind);
  const showPickup = showExcursion || kind === "car";

  /**
   * Planned/Booked, plus whatever this booking already is. A draft import
   * edited here must not be silently promoted, and a cancelled booking must
   * not be silently revived, just because the control had nowhere to show it.
   */
  const statuses: BookingStatus[] = [
    ...new Set<BookingStatus>(["planned", "booked", ...(booking ? [booking.status] : [])]),
  ];

  function toggle(personId: string) {
    setSelected((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId],
    );
  }

  /**
   * Per-kind `details`, validated server-side by the matching Zod schema in
   * `src/server/schemas/booking-kinds.ts`. Required fields there (carrier,
   * flightNumber, the two IATA codes, propertyName, vendor) are required
   * here too, because a ZodError from the server surfaces as a bare
   * "Invalid request" the operator cannot act on.
   *
   * When editing, the stored record is the starting point rather than an empty
   * object: `details` is replaced wholesale by the API, and rebuilding it from
   * this form alone would drop every key the form does not draw (a flight's
   * `seat`, an imported excursion's `duration`). Clearing a field the form DOES
   * draw still removes its key — that is the point of being able to edit.
   */
  function details(): Record<string, unknown> {
    const next: Record<string, unknown> = { ...asRecord(booking?.details) };
    const put = (key: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed === "") delete next[key];
      else next[key] = trimmed;
    };

    switch (kind) {
      case "flight":
        put("carrier", carrier);
        put("flightNumber", flightNumber);
        put("originIata", originIata);
        put("destinationIata", destinationIata);
        break;
      case "lodging":
        put("propertyName", propertyName);
        break;
      case "car":
        put("vendor", vendor);
        put("pickupLocation", pickupLocation);
        put("pickupTime", pickupTime);
        put("dropoffLocation", dropoffLocation);
        // A car's return field is spelled dropoffTime; an excursion's is
        // returnTime. One control, the key the kind's schema actually has.
        put("dropoffTime", returnTime);
        delete next.returnTime;
        break;
      case "activity":
      case "other":
        put("venue", venue);
        put("pickupTime", pickupTime);
        put("pickupLocation", pickupLocation);
        put("returnTime", returnTime);
        put("dropoffLocation", dropoffLocation);
        put("description", description);
        delete next.dropoffTime;
        if (arriveEarly.trim() === "") delete next.arriveMinutesBefore;
        else next.arriveMinutesBefore = Number(arriveEarly.trim());
        break;
    }
    return next;
  }

  function detailsProblem(): string | null {
    if (kind === "flight") {
      if (carrier.trim() === "" || flightNumber.trim() === "") {
        return "A flight needs an airline and a flight number.";
      }
      if (originIata.trim().length !== 3 || destinationIata.trim().length !== 3) {
        return "From and To must each be a three-letter airport code.";
      }
    }
    if (kind === "lodging" && propertyName.trim() === "") return "A stay needs a property name.";
    if (kind === "car" && vendor.trim() === "") return "A car needs a rental company.";
    if (showExcursion && toMinutes(arriveEarly) === null) {
      return "Arrive early must be a whole number of minutes.";
    }
    return null;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setError("A title is required.");
      return;
    }
    const problem = detailsProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    // A timestamp without its zone renders every cross-timezone itinerary
    // wrong, so the server rejects the pair outright. Catch it here, where
    // the message can name the field.
    if (startsAt !== "" && startsAtTz === "") {
      setError("Pick a timezone for the start time.");
      return;
    }
    if (endsAt !== "" && endsAtTz === "") {
      setError("Pick a timezone for the end time.");
      return;
    }
    const cents = toCents(cost);
    if (cents === null) {
      setError("Cost must be a number.");
      return;
    }

    let startsUtc: string | undefined;
    let endsUtc: string | undefined;
    try {
      if (startsAt !== "") startsUtc = zonedToUtc(startsAt, startsAtTz);
      if (endsAt !== "") endsUtc = zonedToUtc(endsAt, endsAtTz);
    } catch (err) {
      setError(err instanceof RangeError ? err.message : errorMessage(err));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (booking) {
        await saveEdit(booking, startsUtc, endsUtc, cents);
      } else {
        await saveNew(startsUtc, endsUtc, cents);
      }
      onSaved();
    } catch (err) {
      // Never close on failure. A 400 from a per-kind schema or a 403 for a
      // viewer must leave the typed booking on screen.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveNew(
    startsUtc: string | undefined,
    endsUtc: string | undefined,
    cents: number | undefined,
  ) {
    if (!trip) throw new Error("No trip to add this booking to.");
    const created = await api.trips.createBooking(trip.id, {
      kind,
      title: title.trim(),
      status,
      details: details(),
      ...(location.trim() === "" ? {} : { location: location.trim() }),
      ...(confirmationNumber.trim() === ""
        ? {}
        : { confirmationNumber: confirmationNumber.trim() }),
      ...(startsUtc ? { startsAt: startsUtc, startsAtTz } : {}),
      ...(endsUtc ? { endsAt: endsUtc, endsAtTz } : {}),
      ...(cents === undefined ? {} : { costCents: cents }),
    });
    for (const personId of selected) {
      await api.bookings.assignPerson(created.id, personId);
    }
  }

  /**
   * `null` where the field was emptied, so clearing a date or a cost in the
   * form actually clears it. The confirmation number is the exception: the
   * form is never seeded with the stored one (it is masked, and echoing a
   * masked value back is a deliberate 400), so blank means "leave it alone"
   * and clearing it has its own control.
   */
  async function saveEdit(
    current: Booking,
    startsUtc: string | undefined,
    endsUtc: string | undefined,
    cents: number | undefined,
  ) {
    const patch: UpdateBookingInput = {
      kind,
      title: title.trim(),
      status,
      details: details(),
      location: location.trim() === "" ? null : location.trim(),
      startsAt: startsUtc ?? null,
      startsAtTz: startsUtc ? startsAtTz : null,
      endsAt: endsUtc ?? null,
      endsAtTz: endsUtc ? endsAtTz : null,
      costCents: cents ?? null,
      ...(confirmationNumber.trim() === ""
        ? {}
        : { confirmationNumber: confirmationNumber.trim() }),
    };
    await api.bookings.update(current.id, patch);

    // Travellers are a join table, not a column, so they move separately —
    // one call per actual change, never a blanket re-assign.
    for (const personId of selected) {
      if (!current.personIds.includes(personId)) {
        await api.bookings.assignPerson(current.id, personId);
      }
    }
    for (const personId of current.personIds) {
      if (!selected.includes(personId)) {
        await api.bookings.unassignPerson(current.id, personId);
      }
    }
  }

  return (
    <Dialog
      title={editing ? "Edit booking" : "Add booking"}
      subtitle={booking?.title ?? trip?.title}
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div className="seg" role="radiogroup" aria-label="Booking kind" style={{ width: "100%" }}>
          {KINDS.map(({ id, label, Icon }) => (
            <label key={id} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
              <input
                type="radio"
                name="booking-kind"
                value={id}
                checked={kind === id}
                onChange={() => setKind(id)}
              />
              <Icon size={14} /> {label}
            </label>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-title">Title</label>
            <input
              id="bd-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-conf">Confirmation #</label>
            <input
              id="bd-conf"
              className="input"
              autoComplete="off"
              placeholder="ABC123"
              value={confirmationNumber}
              onChange={(e) => setConfirmationNumber(e.target.value)}
            />
            {editing && booking.confirmationNumberMasked && (
              <p className="text-muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                Leave blank to keep {booking.confirmationNumberMasked}.
              </p>
            )}
          </div>
        </div>

        {kind === "flight" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="bd-carrier">Airline</label>
                <input
                  id="bd-carrier"
                  className="input"
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="bd-flightno">Flight number</label>
                <input
                  id="bd-flightno"
                  className="input"
                  value={flightNumber}
                  onChange={(e) => setFlightNumber(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="bd-from">From</label>
                <input
                  id="bd-from"
                  className="input"
                  maxLength={3}
                  placeholder="BOI"
                  value={originIata}
                  onChange={(e) => setOriginIata(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="bd-to">To</label>
                <input
                  id="bd-to"
                  className="input"
                  maxLength={3}
                  placeholder="STS"
                  value={destinationIata}
                  onChange={(e) => setDestinationIata(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        {kind === "lodging" && (
          <div className="field">
            <label htmlFor="bd-property">Property name</label>
            <input
              id="bd-property"
              className="input"
              value={propertyName}
              onChange={(e) => setPropertyName(e.target.value)}
            />
          </div>
        )}

        {kind === "car" && (
          <div className="field">
            <label htmlFor="bd-vendor">Rental company</label>
            <input
              id="bd-vendor"
              className="input"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </div>
        )}

        {showExcursion && (
          <div className="field">
            <label htmlFor="bd-venue">Venue or operator</label>
            <input
              id="bd-venue"
              className="input"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
            />
          </div>
        )}

        {/*
          The excursion's whole point. A tour confirmation's useful content is
          "1:30pm at Quarter Circle/West Side Parking Lot, be there 15 minutes
          early, back around 5" — none of which is a start/end instant, and all
          of which used to be unrepresentable without hand-editing JSON.
        */}
        {showPickup && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="bd-pickup-time">Pickup time</label>
                <input
                  id="bd-pickup-time"
                  className="input"
                  placeholder="1:30 PM"
                  value={pickupTime}
                  onChange={(e) => setPickupTime(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="bd-pickup-place">Pickup location</label>
                <input
                  id="bd-pickup-place"
                  className="input"
                  placeholder="Quarter Circle/West Side Parking Lot"
                  value={pickupLocation}
                  onChange={(e) => setPickupLocation(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="bd-return-time">
                  {kind === "car" ? "Drop-off time" : "Return time"}
                </label>
                <input
                  id="bd-return-time"
                  className="input"
                  placeholder="5:00 PM"
                  value={returnTime}
                  onChange={(e) => setReturnTime(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="bd-return-place">
                  {kind === "car" ? "Drop-off location" : "Return location"}
                </label>
                <input
                  id="bd-return-place"
                  className="input"
                  value={dropoffLocation}
                  onChange={(e) => setDropoffLocation(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        {showExcursion && (
          <>
            <div className="field">
              <label htmlFor="bd-arrive-early">Arrive early (minutes)</label>
              <input
                id="bd-arrive-early"
                className="input"
                inputMode="numeric"
                placeholder="15"
                value={arriveEarly}
                onChange={(e) => setArriveEarly(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="bd-description">Description</label>
              <textarea
                id="bd-description"
                className="input"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="bd-location">Location</label>
          <input
            id="bd-location"
            className="input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-starts">Departs / starts</label>
            <input
              id="bd-starts"
              className="input"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-starts-tz">Departs timezone</label>
            <select
              id="bd-starts-tz"
              className="input"
              value={startsAtTz}
              onChange={(e) => setStartsAtTz(e.target.value)}
            >
              <option value="">Pick a timezone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-ends">Arrives / ends</label>
            <input
              id="bd-ends"
              className="input"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-ends-tz">Arrives timezone</label>
            <select
              id="bd-ends-tz"
              className="input"
              value={endsAtTz}
              onChange={(e) => setEndsAtTz(e.target.value)}
            >
              <option value="">Pick a timezone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="bd-who">Who's on it</label>
          <div id="bd-who">
            <TravelerToggles people={people} selected={selected} onToggle={toggle} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-cost">Cost</label>
            <input
              id="bd-cost"
              className="input"
              inputMode="decimal"
              placeholder="684.30"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-status">Status</label>
            <div className="seg" role="radiogroup" aria-label="Status" style={{ width: "100%" }}>
              {statuses.map((s) => (
                <label key={s} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input
                    type="radio"
                    name="booking-status"
                    value={s}
                    checked={status === s}
                    onChange={() => setStatus(s)}
                  />
                  {STATUS_LABELS[s]}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing ? "Save changes" : "Save booking"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const STATUS_LABELS: Record<BookingStatus, string> = {
  draft: "Draft",
  planned: "Planned",
  booked: "Booked",
  cancelled: "Cancelled",
};
