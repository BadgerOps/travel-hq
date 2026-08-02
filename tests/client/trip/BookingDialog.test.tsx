import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookingDialog } from "../../../src/client/trip/BookingDialog.js";

/**
 * `userEvent.type()` into native date/time inputs is unreliable under
 * jsdom — it types character by character against a control jsdom does not
 * implement segment editing for, and frequently leaves the value empty, which
 * would make the two timezone assertions below pass or fail for reasons
 * unrelated to what they test. `fireEvent.change` sets the value the way the
 * browser would have and fires the one React `onChange` the component reads.
 *
 * Do not "modernise" this back to userEvent.type.
 */
function setField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
  photoUrl: null,
};

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function makeApi() {
  return {
    trips: { createBooking: vi.fn(async () => ({ id: "b1" })) },
    bookings: {
      assignPerson: vi.fn(async () => undefined),
      // Reached on the create path only when a reminder override was chosen —
      // the create route cannot carry one. See the reminder tests below.
      update: vi.fn(async () => ({ id: "b1" })),
    },
  };
}

function renderDialog(api = makeApi(), onSaved = vi.fn()) {
  render(
    <BookingDialog
      trip={TRIP}
      people={PEOPLE as never}
      api={api as never}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );
  return { api, onSaved };
}

describe("BookingDialog", () => {
  it("opens on Flight with the flight fieldset", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: "Flight" })).toBeChecked();
    expect(screen.getByLabelText(/Airline/)).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
  });

  it("morphs the middle fieldset when the kind changes", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: "Stay" }));
    expect(screen.getByLabelText(/Property/)).toBeInTheDocument();
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
  });

  it("switches kinds from the keyboard", async () => {
    // A native radio group, as in plan 3's tab strip — arrow keys come from
    // the platform, and a test that only clicks would pass against a broken
    // custom widget.
    renderDialog();
    const flight = screen.getByRole("radio", { name: "Flight" });
    flight.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Stay" })).toBeChecked();
  });

  it("sends a UTC instant and its zone, not the raw wall clock", async () => {
    const { api } = renderDialog();
    await userEvent.type(screen.getByLabelText("Title"), "DL2214 BOI → STS");
    await userEvent.type(screen.getByLabelText(/Airline/), "Delta");
    await userEvent.type(screen.getByLabelText(/Flight number/), "2214");
    await userEvent.type(screen.getByLabelText("From"), "BOI");
    await userEvent.type(screen.getByLabelText("To"), "STS");
    setField("Start date", "2026-10-09");
    setField("Start time", "09:40");
    await userEvent.selectOptions(screen.getByLabelText("Timezone"), "America/Boise");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));

    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        kind: "flight",
        startsAt: "2026-10-09T15:40:00.000Z",
        startsAtTz: "America/Boise",
      }),
    );
  });

  it("never sends a timestamp without its zone", async () => {
    // assertTimezonePaired rejects this server-side with a 400, but a form
    // that can compose the invalid request will do it to a real operator at
    // the worst moment. Refuse locally and say why.
    const { api } = renderDialog();
    await userEvent.type(screen.getByLabelText("Title"), "DL2214");
    await userEvent.type(screen.getByLabelText(/Airline/), "Delta");
    await userEvent.type(screen.getByLabelText(/Flight number/), "2214");
    await userEvent.type(screen.getByLabelText("From"), "BOI");
    await userEvent.type(screen.getByLabelText("To"), "STS");
    setField("Start date", "2026-10-09");
    setField("Start time", "09:40");
    await userEvent.selectOptions(screen.getByLabelText("Timezone"), "");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/timezone/i);
  });

  it("attaches every toggled traveller to the created booking", async () => {
    const { api } = renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.bookings.assignPerson).toHaveBeenCalledWith("b1", "p1");
    expect(api.bookings.assignPerson).toHaveBeenCalledWith("b1", "p2");
  });

  it("defaults the status to Booked and sends the chosen one", async () => {
    const { api } = renderDialog();
    expect(screen.getByRole("radio", { name: "Booked" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Planned" }));
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "planned" }),
    );
  });

  it("sends cost as integer cents", async () => {
    const { api } = renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.type(screen.getByLabelText("Cost"), "684.30");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ costCents: 68430 }),
    );
  });

  it("refuses to submit without a title", async () => {
    const { api } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/title/i);
  });

  it("keeps the dialog open and reports a rejected save", async () => {
    const api = makeApi();
    api.trips.createBooking = vi.fn(async () => {
      throw new Error("400");
    });
    const { onSaved } = renderDialog(api);
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

/**
 * The per-booking reminder override (#61).
 *
 * The property under test throughout is that `off` and a lead of `0` stay
 * different things. They are the same shape — "no positive number of minutes"
 * — and a form that let them blur is how someone who asked to be told at
 * departure ends up told nothing at all.
 */
const BOOKING = {
  id: "b1",
  tripId: "t1",
  kind: "flight",
  title: "DL2214 BOI → STS",
  location: null,
  startsAt: null,
  startsAtTz: null,
  endsAt: null,
  endsAtTz: null,
  confirmationNumberMasked: null,
  costCents: null,
  pointsUsed: null,
  pointsProgram: null,
  status: "booked" as const,
  details: { carrier: "Delta", flightNumber: "2214", originIata: "BOI", destinationIata: "STS" },
  personIds: [],
  sourceInboundEmailId: null,
  reminderMode: "inherit" as const,
  reminderLeadMinutes: null,
};

function renderEdit(booking: Record<string, unknown> = {}) {
  const api = {
    trips: { createBooking: vi.fn(async () => ({ id: "b1" })) },
    bookings: {
      assignPerson: vi.fn(async () => undefined),
      unassignPerson: vi.fn(async () => undefined),
      update: vi.fn(async () => ({ ...BOOKING, ...booking })),
    },
  };
  render(
    <BookingDialog
      booking={{ ...BOOKING, ...booking } as never}
      people={PEOPLE as never}
      api={api as never}
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return api;
}

describe("BookingDialog — reminder override", () => {
  it("opens on 'My default' for a booking that has no opinion", () => {
    renderEdit();
    expect(screen.getByRole("radio", { name: "My default" })).toBeChecked();
    // No number field until one is actually being overridden: an empty box
    // labelled "minutes" beside "use my default" invites exactly the confusion
    // this control exists to prevent.
    expect(screen.queryByLabelText(/minutes before it starts/i)).toBeNull();
  });

  it("seeds a stored custom override, including a lead of 0", () => {
    renderEdit({ reminderMode: "custom", reminderLeadMinutes: 0 });
    expect(screen.getByRole("radio", { name: "Custom" })).toBeChecked();
    expect(screen.getByLabelText(/minutes before it starts/i)).toHaveValue("0");
    expect(screen.getByText(/0 means right when it starts/i)).toBeInTheDocument();
  });

  it("saves 0 as the number 0, not as 'off' and not as blank", async () => {
    const api = renderEdit();
    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await userEvent.type(screen.getByLabelText(/minutes before it starts/i), "0");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(api.bookings.update).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({ reminderMode: "custom", reminderLeadMinutes: 0 }),
    );
  });

  it("saves 'off' as a mode with no minutes, which is a different thing entirely", async () => {
    const api = renderEdit({ reminderMode: "custom", reminderLeadMinutes: 90 });
    await userEvent.click(screen.getByRole("radio", { name: "No reminder" }));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(api.bookings.update).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({ reminderMode: "off", reminderLeadMinutes: null }),
    );
  });

  it("returns to the account default, clearing the stored minutes with it", async () => {
    const api = renderEdit({ reminderMode: "custom", reminderLeadMinutes: 90 });
    await userEvent.click(screen.getByRole("radio", { name: "My default" }));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(api.bookings.update).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({ reminderMode: "inherit", reminderLeadMinutes: null }),
    );
  });

  it("refuses a negative lead time rather than sending it", async () => {
    const api = renderEdit();
    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await userEvent.type(screen.getByLabelText(/minutes before it starts/i), "-5");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/whole number of minutes/i);
    expect(api.bookings.update).not.toHaveBeenCalled();
  });

  /**
   * The create route's schema does not accept the reminder columns and, being
   * a non-strict Zod object, would silently DROP them. So a new booking with
   * an override is created and then patched — and one with no override sends
   * no patch at all, keeping the ordinary create byte-identical to what it was.
   */
  it("patches a new booking's override in rather than posting it to create", async () => {
    const { api } = renderDialog();
    await userEvent.type(screen.getByLabelText("Title"), "DL2214");
    await userEvent.type(screen.getByLabelText(/Airline/), "Delta");
    await userEvent.type(screen.getByLabelText(/Flight number/), "2214");
    await userEvent.type(screen.getByLabelText("From"), "BOI");
    await userEvent.type(screen.getByLabelText("To"), "STS");
    await userEvent.click(screen.getByRole("radio", { name: "No reminder" }));
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));

    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.not.objectContaining({ reminderMode: expect.anything() }),
    );
    expect(api.bookings.update).toHaveBeenCalledWith("b1", {
      reminderMode: "off",
      reminderLeadMinutes: null,
    });
  });

  it("sends no patch at all when the new booking keeps the default", async () => {
    const { api } = renderDialog();
    await userEvent.type(screen.getByLabelText("Title"), "DL2214");
    await userEvent.type(screen.getByLabelText(/Airline/), "Delta");
    await userEvent.type(screen.getByLabelText(/Flight number/), "2214");
    await userEvent.type(screen.getByLabelText("From"), "BOI");
    await userEvent.type(screen.getByLabelText("To"), "STS");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.bookings.update).not.toHaveBeenCalled();
  });
});
