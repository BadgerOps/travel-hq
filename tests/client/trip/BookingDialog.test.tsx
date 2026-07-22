import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookingDialog } from "../../../src/client/trip/BookingDialog.js";

/**
 * `userEvent.type()` into `<input type="datetime-local">` is unreliable under
 * jsdom — it types character by character against a control jsdom does not
 * implement segment editing for, and frequently leaves the value empty, which
 * would make the two timezone assertions below pass or fail for reasons
 * unrelated to what they test. `fireEvent.change` sets the value the way the
 * browser would have and fires the one React `onChange` the component reads.
 *
 * Do not "modernise" this back to userEvent.type.
 */
function setDateTime(label: string, value: string): void {
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
};

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function makeApi() {
  return {
    trips: { createBooking: vi.fn(async () => ({ id: "b1" })) },
    bookings: { assignPerson: vi.fn(async () => undefined) },
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
    // Exact strings, not /^Departs/: the dialog has BOTH "Departs / starts"
    // and "Departs timezone", and Testing Library throws on a multiple match.
    setDateTime("Departs / starts", "2026-10-09T09:40");
    await userEvent.selectOptions(screen.getByLabelText("Departs timezone"), "America/Boise");
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
    setDateTime("Departs / starts", "2026-10-09T09:40");
    await userEvent.selectOptions(screen.getByLabelText("Departs timezone"), "");
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
