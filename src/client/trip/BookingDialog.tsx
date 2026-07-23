import { useState } from "react";
import { AirplaneTakeoff, Bed, Car, Ticket } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { BookingStatus, Person, Trip } from "../api/types.js";
import { zonedToUtc } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { zoneOptions } from "../lib/timezones.js";
import { Dialog } from "../components/Dialog.js";
import { TravelerToggles } from "../components/TravelerToggles.js";

/**
 * Exploration 1g: one dialog, a kind segmented control that morphs the middle
 * fieldset, "who's on it" per booking (not per trip), cost, and a
 * Planned/Booked status control.
 *
 * The kind list matches BOOKING_KINDS on the server minus "other", which is
 * the freeform escape hatch and has no fields of its own to draw.
 */
const KINDS = [
  { id: "flight", label: "Flight", Icon: AirplaneTakeoff },
  { id: "lodging", label: "Stay", Icon: Bed },
  { id: "car", label: "Car", Icon: Car },
  { id: "activity", label: "Activity", Icon: Ticket },
] as const;

type Kind = (typeof KINDS)[number]["id"];

// The curated timezone list lives in ../lib/timezones.js, shared with the
// import review's edit form; zoneOptions() prepends the viewer's own zone so
// the common case is one click.

/** "684.30" -> 68430. Returns undefined for blank, null for unparseable. */
function toCents(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function BookingDialog({
  trip,
  people,
  api = defaultApi,
  onSaved,
  onClose,
}: {
  trip: Trip;
  /** The trip's travellers, so the toggles list who is actually on this trip. */
  people: Person[];
  api?: typeof defaultApi;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("flight");
  const [title, setTitle] = useState("");
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [location, setLocation] = useState("");

  // Per-kind detail fields. Held flat and assembled per kind at submit time,
  // so switching kinds does not discard what was typed.
  const [carrier, setCarrier] = useState("");
  const [flightNumber, setFlightNumber] = useState("");
  const [originIata, setOriginIata] = useState("");
  const [destinationIata, setDestinationIata] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [vendor, setVendor] = useState("");
  const [venue, setVenue] = useState("");

  const [startsAt, setStartsAt] = useState("");
  const [startsAtTz, setStartsAtTz] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [endsAtTz, setEndsAtTz] = useState("");

  const [selected, setSelected] = useState<string[]>([]);
  const [cost, setCost] = useState("");
  const [status, setStatus] = useState<BookingStatus>("booked");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zones = zoneOptions();

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
   */
  function details(): Record<string, unknown> {
    switch (kind) {
      case "flight":
        return {
          carrier: carrier.trim(),
          flightNumber: flightNumber.trim(),
          originIata: originIata.trim(),
          destinationIata: destinationIata.trim(),
        };
      case "lodging":
        return { propertyName: propertyName.trim() };
      case "car":
        return { vendor: vendor.trim() };
      case "activity":
        return venue.trim() === "" ? {} : { venue: venue.trim() };
    }
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
      const booking = await api.trips.createBooking(trip.id, {
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
        await api.bookings.assignPerson(booking.id, personId);
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

  return (
    <Dialog title="Add booking" subtitle={trip.title} onClose={onClose}>
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

        {kind === "activity" && (
          <div className="field">
            <label htmlFor="bd-venue">Venue</label>
            <input
              id="bd-venue"
              className="input"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
            />
          </div>
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
              {(["planned", "booked"] as const).map((s) => (
                <label key={s} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input
                    type="radio"
                    name="booking-status"
                    value={s}
                    checked={status === s}
                    onChange={() => setStatus(s)}
                  />
                  {s === "planned" ? "Planned" : "Booked"}
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
            Save booking
          </button>
        </div>
      </form>
    </Dialog>
  );
}
