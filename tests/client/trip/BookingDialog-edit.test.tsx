import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookingDialog } from "../../../src/client/trip/BookingDialog.js";

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

/** The Red Bus excursion as an email import leaves it: half the facts. */
const TOUR = {
  id: "b1",
  tripId: "t1",
  sourceInboundEmailId: "mail-1",
  kind: "activity",
  title: "Going-to-the-Sun Road Red Bus tour",
  location: null,
  startsAt: "2026-10-09T19:30:00.000Z",
  startsAtTz: "America/Denver",
  endsAt: null,
  endsAtTz: null,
  confirmationNumberMasked: "••••US88",
  costCents: 12_500,
  pointsUsed: null,
  pointsProgram: null,
  status: "planned" as const,
  details: { venue: "Glacier Red Bus Tours", pickupTime: "1:30 PM", duration: "3.5 hours" },
  personIds: ["p1"],
};

function makeApi() {
  return {
    trips: { createBooking: vi.fn(async () => ({ id: "b1" })) },
    bookings: {
      // Parameters spelled out so the assertions below can read the patch
      // this dialog actually sent.
      update: vi.fn(async (_id: string, _patch: Record<string, unknown>) => TOUR),
      assignPerson: vi.fn(async (_id: string, _personId: string) => undefined),
      unassignPerson: vi.fn(async (_id: string, _personId: string) => undefined),
    },
  };
}

function renderEdit(booking: unknown = TOUR, api = makeApi(), onSaved = vi.fn()) {
  render(
    <BookingDialog
      booking={booking as never}
      people={PEOPLE as never}
      api={api as never}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );
  return { api, onSaved };
}

function patchOf(api: ReturnType<typeof makeApi>): Record<string, unknown> {
  return api.bookings.update.mock.calls[0]![1];
}

describe("BookingDialog in edit mode", () => {
  it("opens on the booking's own kind and values", () => {
    renderEdit();
    expect(screen.getByRole("radio", { name: "Activity" })).toBeChecked();
    expect(screen.getByLabelText("Title")).toHaveValue(
      "Going-to-the-Sun Road Red Bus tour",
    );
    expect(screen.getByLabelText(/Venue/)).toHaveValue("Glacier Red Bus Tours");
    expect(screen.getByLabelText("Pickup time")).toHaveValue("1:30 PM");
    expect(screen.getByLabelText("Cost")).toHaveValue("125.00");
    // The stored instant is shown as the wall clock in its OWN zone, not the
    // browser's and not UTC — saving it back must not move the booking.
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-10-09");
    expect(screen.getByLabelText("Start time")).toHaveValue("13:30");
    expect(screen.getByLabelText("Timezone")).toHaveValue("America/Denver");
    expect(screen.getByRole("radio", { name: "Planned" })).toBeChecked();
  });

  it("saves the pickup location and call time an import missed", async () => {
    const { api, onSaved } = renderEdit();

    await userEvent.type(
      screen.getByLabelText("Pickup location"),
      "Quarter Circle/West Side Parking Lot",
    );
    await userEvent.type(screen.getByLabelText("Return time"), "5:00 PM");
    await userEvent.type(screen.getByLabelText(/Arrive early/), "15");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.bookings.update).toHaveBeenCalledTimes(1);
    expect(api.bookings.update.mock.calls[0]![0]).toBe("b1");
    expect(patchOf(api).details).toEqual({
      venue: "Glacier Red Bus Tours",
      pickupTime: "1:30 PM",
      pickupLocation: "Quarter Circle/West Side Parking Lot",
      returnTime: "5:00 PM",
      arriveMinutesBefore: 15,
      // A key the form does not draw survives: details are replaced wholesale
      // by the API, so rebuilding them from the form alone would drop it.
      duration: "3.5 hours",
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("never sends the masked confirmation number back", async () => {
    // Echoing "••••US88" would encrypt the bullets over the real code; the
    // server answers 400, and the field is deliberately left blank instead.
    const { api } = renderEdit();
    expect(screen.getByLabelText(/Confirmation/)).toHaveValue("");
    expect(screen.getByText(/Leave blank to keep ••••US88/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(patchOf(api)).not.toHaveProperty("confirmationNumber");
  });

  it("clears a field that was emptied rather than leaving it stored", async () => {
    const { api } = renderEdit();
    await userEvent.clear(screen.getByLabelText("Cost"));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "" } });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const patch = patchOf(api);
    expect(patch.costCents).toBeNull();
    expect(patch.startsAt).toBeNull();
    expect(patch.startsAtTz).toBeNull();
    // Absent from the form's own state, so it must not be touched at all.
    expect(patch).not.toHaveProperty("pointsUsed");
  });

  it("moves only the travellers that actually changed", async () => {
    const { api } = renderEdit();
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.bookings.assignPerson).toHaveBeenCalledExactlyOnceWith("b1", "p2");
    expect(api.bookings.unassignPerson).toHaveBeenCalledExactlyOnceWith("b1", "p1");
  });

  it("keeps an imported freeform booking on Other instead of retyping it", async () => {
    // Every booking parsed out of a calendar attachment lands as `other`. A
    // dialog with no Other option would silently make this a flight.
    const { api } = renderEdit({
      ...TOUR,
      kind: "other",
      details: { pickupTime: "1:30 PM" },
    });
    expect(screen.getByRole("radio", { name: "Other" })).toBeChecked();
    expect(screen.getByLabelText("Pickup time")).toHaveValue("1:30 PM");

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(patchOf(api).kind).toBe("other");
  });

  it("offers the booking's current status even when it is not Planned or Booked", () => {
    renderEdit({ ...TOUR, status: "draft" as never });
    expect(screen.getByRole("radio", { name: "Draft" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Booked" })).toBeInTheDocument();
  });

  it("rejects a non-numeric call time before sending it", async () => {
    const { api } = renderEdit();
    await userEvent.type(screen.getByLabelText(/Arrive early/), "soon");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/whole number of minutes/);
    expect(api.bookings.update).not.toHaveBeenCalled();
  });

  it("stays open and reports the failure when the save is refused", async () => {
    const api = makeApi();
    api.bookings.update = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {
      throw new Error("nope");
    });
    const onSaved = vi.fn();
    renderEdit(TOUR, api, onSaved);

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
  });

  it("still creates when given a trip instead of a booking", async () => {
    // The add path is unchanged: one dialog, two modes.
    const api = makeApi();
    render(
      <BookingDialog
        trip={{ id: "t1", title: "Glacier" } as never}
        people={PEOPLE as never}
        api={api as never}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Red Bus tour");
    await userEvent.type(screen.getByLabelText("Pickup time"), "1:30 PM");
    await userEvent.click(screen.getByRole("button", { name: "Save booking" }));

    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        kind: "activity",
        title: "Red Bus tour",
        details: { pickupTime: "1:30 PM" },
      }),
    );
    expect(api.bookings.update).not.toHaveBeenCalled();
  });
});
