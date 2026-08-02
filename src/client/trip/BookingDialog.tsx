import { useState } from "react";
import { AirplaneTakeoff, Bed, Car, Suitcase, Ticket } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type {
  Booking,
  BookingStatus,
  PendingImportDraft,
  Person,
  ReminderMode,
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
 * And it is the IMPORT-CORRECTION form (pass `draft`), for the same reason
 * again: a reviewer fixing an extracted flight number before accepting it is
 * filling in the same fields, validated by the same per-kind schemas, as
 * someone typing that flight in by hand. A separate draft form would be a
 * third opinion about what a flight has, and the one most likely to drift —
 * it is edited least often and every extractor change lands on it first.
 *
 * The three modes stay legible because they differ in exactly three places,
 * each marked below: what the form is SEEDED from (`seed`), which sections are
 * drawn (a draft has no travellers of its own and no status yet), and which
 * save runs. Everything between — the kind control, every per-kind fieldset,
 * the schedule, the cost — is shared verbatim, which is the entire point.
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
  { id: "other", label: "Other", Icon: Suitcase },
] as const;

type Kind = (typeof KINDS)[number]["id"];

/**
 * The per-booking reminder override (#61), as three named states rather than a
 * number that sometimes means "none".
 *
 * The distinction the control exists to protect: `off` means no reminder at
 * all, and a lead of `0` means "tell me the moment it starts" — a real choice
 * for a dinner reservation you are already standing outside. A single nullable
 * minutes field would make those two indistinguishable to anyone filling the
 * form in, which is exactly how someone ends up hearing nothing about a flight
 * they meant to be reminded of at departure.
 */
const REMINDER_CHOICES = [
  { id: "inherit", label: "My default" },
  { id: "custom", label: "Custom" },
  { id: "off", label: "No reminder" },
] as const;

/** Kept in sync by hand with MAX_REMINDER_LEAD_MINUTES in repos/booking.ts. */
const MAX_REMINDER_LEAD = 7 * 24 * 60;

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
 * Everything this form seeds itself from, whether that is a stored booking or
 * a pending import. Both shapes already carry these fields under these names —
 * `Booking` because it is the row, `PendingImportDraft` because the queue was
 * built to be pre-fillable — so the seeding code below reads ONE object and
 * never asks which mode it is in.
 */
type BookingSeed = {
  kind: string;
  title: string;
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  costCents: number | null;
  details: unknown;
};

/**
 * The viewer's zone, then the curated list, then whatever zones this booking
 * is actually stored in — an imported booking can carry a zone that is on
 * neither list, and a <select> without its own value silently reassigns it.
 */
function zoneOptions(seed?: BookingSeed): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stored = [seed?.startsAtTz, seed?.endsAtTz].filter(
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

function seedKind(seed: BookingSeed | undefined): Kind {
  const match = KINDS.find((k) => k.id === seed?.kind);
  return match?.id ?? "flight";
}

/** A stored UTC instant as the wall clock its own zone shows. */
function seedLocal(at: string | null | undefined, tz: string | null | undefined): string {
  return at && tz ? utcToZonedLocal(at, tz) : "";
}

export function BookingDialog({
  trip,
  booking,
  draft,
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
  /**
   * Present to CORRECT A PENDING IMPORT, before it becomes a booking at all.
   * It has no trip yet — which trip it lands on is the accept's decision, made
   * separately in the review queue — so `trip` stays absent here too.
   */
  draft?: PendingImportDraft;
  /** The trip's travellers, so the toggles list who is actually on this trip. */
  people: Person[];
  api?: typeof defaultApi;
  onSaved: () => void;
  onClose: () => void;
}) {
  const editing = booking !== undefined;
  const editingDraft = draft !== undefined;
  /** MODE DIFFERENCE 1 of 3: what the fields below are pre-filled from. */
  const seed: BookingSeed | undefined = booking ?? draft;

  const [kind, setKind] = useState<Kind>(() => seedKind(seed));
  const [title, setTitle] = useState(seed?.title ?? "");
  // A stored booking's number is masked (see the hint under the field), so the
  // form starts blank and blank means "leave it". A draft's is held in the
  // clear — nothing has encrypted it yet — so it is seeded like any other
  // field, and clearing it means clearing it.
  const [confirmationNumber, setConfirmationNumber] = useState(
    draft?.confirmationNumber ?? "",
  );
  const [location, setLocation] = useState(seed?.location ?? "");

  // Per-kind detail fields. Held flat and assembled per kind at submit time,
  // so switching kinds does not discard what was typed.
  const [carrier, setCarrier] = useState(() => detailText(seed?.details, "carrier"));
  const [flightNumber, setFlightNumber] = useState(() =>
    detailText(seed?.details, "flightNumber"),
  );
  const [originIata, setOriginIata] = useState(() => detailText(seed?.details, "originIata"));
  const [destinationIata, setDestinationIata] = useState(() =>
    detailText(seed?.details, "destinationIata"),
  );
  const [propertyName, setPropertyName] = useState(() =>
    detailText(seed?.details, "propertyName"),
  );
  const [vendor, setVendor] = useState(() => detailText(seed?.details, "vendor"));
  const [venue, setVenue] = useState(() => detailText(seed?.details, "venue"));

  // Excursion (and car) logistics: the pickup and the return. Wall-clock text,
  // not timestamps — see the note on `activityDetails` in the server's
  // booking-kinds schema for why an operator's "Approximate return time: 5:00"
  // must not be promoted to an instant.
  const [pickupTime, setPickupTime] = useState(() => detailText(seed?.details, "pickupTime"));
  const [pickupLocation, setPickupLocation] = useState(() =>
    detailText(seed?.details, "pickupLocation"),
  );
  const [arriveEarly, setArriveEarly] = useState(() =>
    detailText(seed?.details, "arriveMinutesBefore"),
  );
  const [returnTime, setReturnTime] = useState(() =>
    detailText(seed?.details, "returnTime") || detailText(seed?.details, "dropoffTime"),
  );
  const [dropoffLocation, setDropoffLocation] = useState(() =>
    detailText(seed?.details, "dropoffLocation"),
  );
  const [description, setDescription] = useState(() =>
    detailText(seed?.details, "description"),
  );

  const seededStart = seedLocal(seed?.startsAt, seed?.startsAtTz);
  const seededEnd = seedLocal(seed?.endsAt, seed?.endsAtTz);
  const [startDate, setStartDate] = useState(
    () => detailText(seed?.details, "checkInDate") || seededStart.slice(0, 10),
  );
  const [startTime, setStartTime] = useState(() => seededStart.slice(11, 16));
  const [startsAtTz, setStartsAtTz] = useState(seed?.startsAtTz ?? "");
  const [endDate, setEndDate] = useState(
    () => detailText(seed?.details, "checkOutDate") || seededEnd.slice(0, 10),
  );
  const [endTime, setEndTime] = useState(() => seededEnd.slice(11, 16));
  const [endsAtTz, setEndsAtTz] = useState(seed?.endsAtTz ?? "");
  const startsAt = startDate && startTime ? `${startDate}T${startTime}` : "";
  const endsAt = endDate && endTime ? `${endDate}T${endTime}` : "";

  const [selected, setSelected] = useState<string[]>(booking?.personIds ?? []);
  const [cost, setCost] = useState(() =>
    seed?.costCents === null || seed?.costCents === undefined
      ? ""
      : (seed.costCents / 100).toFixed(2),
  );
  const [status, setStatus] = useState<BookingStatus>(booking?.status ?? "booked");
  // Real COLUMNS (reminder_mode / reminder_lead_minutes), not `details` keys,
  // so they have their own state and their own place in the patch rather than
  // riding along in details().
  const [reminderMode, setReminderMode] = useState<ReminderMode>(
    booking?.reminderMode ?? "inherit",
  );
  const [reminderLead, setReminderLead] = useState(
    booking?.reminderLeadMinutes === null || booking?.reminderLeadMinutes === undefined
      ? ""
      : String(booking.reminderLeadMinutes),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zones = zoneOptions(seed);
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
    const next: Record<string, unknown> = { ...asRecord(seed?.details) };
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
        put("checkInDate", startDate);
        put("checkOutDate", endDate);
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

  /**
   * The minutes to store, or null to let `custom` fall back to the account
   * default. Only meaningful when the mode IS custom — the other two modes
   * store null, because a lead time attached to "off" is a number nothing
   * reads and everything is confused by.
   */
  function reminderLeadValue(): number | null {
    if (reminderMode !== "custom") return null;
    const trimmed = reminderLead.trim();
    if (trimmed === "") return null;
    return Number(trimmed);
  }

  function reminderProblem(): string | null {
    if (reminderMode !== "custom") return null;
    const trimmed = reminderLead.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    // `< 0`, not `<= 0`: zero minutes is "when it starts", which is the whole
    // reason this is a mode plus a number instead of one nullable number.
    if (!Number.isInteger(value) || value < 0 || value > MAX_REMINDER_LEAD) {
      return `Reminder lead time must be a whole number of minutes from 0 to ${MAX_REMINDER_LEAD}.`;
    }
    return null;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setError("A title is required.");
      return;
    }
    const problem = detailsProblem() ?? reminderProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    // A timestamp without its zone renders every cross-timezone itinerary
    // wrong, so the server rejects the pair outright. Catch it here, where
    // the message can name the field.
    if (startTime !== "" && startDate === "") {
      setError("Pick a start date for the start time.");
      return;
    }
    if (endTime !== "" && endDate === "") {
      setError("Pick an end date for the end time.");
      return;
    }
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
      // MODE DIFFERENCE 3 of 3: where the typed values go.
      if (draft) {
        await saveDraft(draft, startsUtc, endsUtc, cents);
      } else if (booking) {
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
    // A follow-up patch rather than a key on the create body: the create route
    // is the one schema that does not accept the reminder columns, and a
    // non-strict Zod object would SILENTLY DROP them — an override the operator
    // watched themselves set and that never existed. A new booking defaults to
    // 'inherit' server-side, so nothing is sent unless something was chosen.
    if (reminderMode !== "inherit") {
      await api.bookings.update(created.id, {
        reminderMode,
        reminderLeadMinutes: reminderLeadValue(),
      });
    }
  }

  /**
   * The correction path: the draft row is patched in place and stays pending,
   * so the reviewer can fix a wrong time now and decide which trip it belongs
   * to later. Nothing here creates a booking — the accept still does that, and
   * it will read exactly these values.
   *
   * `null` where a field was emptied, including the confirmation number: a
   * draft's is shown in the clear, so blank is an instruction rather than the
   * "leave the masked value alone" it means for a stored booking.
   *
   * Travellers are absent on purpose. A draft has no `booking_person` rows to
   * move; the accept matches the extractor's traveller NAMES against the
   * household's people, and those names are not this form's to rewrite.
   */
  async function saveDraft(
    current: PendingImportDraft,
    startsUtc: string | undefined,
    endsUtc: string | undefined,
    cents: number | undefined,
  ) {
    await api.imports.updateDraft(current.id, {
      kind,
      title: title.trim(),
      details: details(),
      location: location.trim() === "" ? null : location.trim(),
      startsAt: startsUtc ?? null,
      startsAtTz: startsUtc ? startsAtTz : null,
      endsAt: endsUtc ?? null,
      endsAtTz: endsUtc ? endsAtTz : null,
      costCents: cents ?? null,
      confirmationNumber:
        confirmationNumber.trim() === "" ? null : confirmationNumber.trim(),
    });
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
      reminderMode,
      reminderLeadMinutes: reminderLeadValue(),
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
      title={editingDraft ? "Edit import" : editing ? "Edit booking" : "Add booking"}
      subtitle={seed?.title ?? trip?.title}
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

        <fieldset className="card" style={{ display: "grid", gap: 12, padding: 12 }}>
          <legend style={{ padding: "0 6px", fontWeight: 650 }}>
            {kind === "lodging" ? "Stay dates" : "Schedule"}
          </legend>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(150px, 1fr) minmax(110px, .7fr)",
              gap: 12,
            }}
          >
            <div className="field">
              <label htmlFor="bd-start-date">
                {kind === "lodging" ? "Check-in date" : "Start date"}
              </label>
              <input
                id="bd-start-date"
                className="input"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (!e.target.value) setStartTime("");
                  if (!endDate) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="bd-start-time">
                {kind === "lodging" ? "Check-in time (optional)" : "Start time"}
              </label>
              <input
                id="bd-start-time"
                className="input"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="bd-end-date">
                {kind === "lodging" ? "Check-out date" : "End date"}
              </label>
              <input
                id="bd-end-date"
                className="input"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  if (!e.target.value) setEndTime("");
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="bd-end-time">
                {kind === "lodging" ? "Check-out time (optional)" : "End time"}
              </label>
              <input
                id="bd-end-time"
                className="input"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="bd-starts-tz">Timezone</label>
            <select
              id="bd-starts-tz"
              className="input"
              value={startsAtTz}
              onChange={(e) => {
                setStartsAtTz(e.target.value);
                if (kind !== "flight") setEndsAtTz(e.target.value);
              }}
            >
              <option value="">Pick a timezone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          {kind === "flight" && (
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
          )}
          {kind === "lodging" && (
            <p className="text-muted" style={{ margin: 0 }}>
              Times are optional. The stay will still appear on every day from check-in through check-out.
            </p>
          )}
        </fieldset>

        {/*
          The reminder override. Absent for a pending import, which has no
          reminder columns at all — a draft is not schedulable until it becomes
          a booking, so a control here would edit nothing.
        */}
        {!editingDraft && (
          <fieldset className="card" style={{ display: "grid", gap: 12, padding: 12 }}>
            <legend style={{ padding: "0 6px", fontWeight: 650 }}>Reminder</legend>
            <div className="seg" role="radiogroup" aria-label="Reminder" style={{ width: "100%" }}>
              {REMINDER_CHOICES.map(({ id, label }) => (
                <label key={id} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input
                    type="radio"
                    name="booking-reminder"
                    value={id}
                    checked={reminderMode === id}
                    onChange={() => setReminderMode(id)}
                  />
                  {label}
                </label>
              ))}
            </div>
            {reminderMode === "custom" && (
              <div className="field">
                <label htmlFor="bd-reminder-lead">Minutes before it starts</label>
                <input
                  id="bd-reminder-lead"
                  className="input"
                  inputMode="numeric"
                  placeholder="60"
                  value={reminderLead}
                  onChange={(e) => setReminderLead(e.target.value)}
                />
                <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                  0 means right when it starts. Leave blank to use your default. To get no
                  reminder at all, choose “No reminder” above.
                </p>
              </div>
            )}
            {reminderMode === "inherit" && (
              <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                Uses the lead time from your notification settings.
              </p>
            )}
            {reminderMode === "off" && (
              <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                Nobody is reminded about this booking, whatever their own settings say.
              </p>
            )}
          </fieldset>
        )}

        {/*
          MODE DIFFERENCE 2 of 3: a pending import has neither of these yet.
          Travellers are `booking_person` rows that do not exist until the
          accept creates them (it matches the extractor's names against the
          household's people), and a draft's status is pending/accepted/
          dismissed — a queue, not Planned/Booked — resolved by accepting or
          dismissing it rather than by a control in this form.
        */}
        {!editingDraft && (
          <div className="field">
            <label htmlFor="bd-who">Who's on it</label>
            <div id="bd-who">
              <TravelerToggles people={people} selected={selected} onToggle={toggle} />
            </div>
          </div>
        )}

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
          {!editingDraft && (
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
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editingDraft ? "Save import" : editing ? "Save changes" : "Save booking"}
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
