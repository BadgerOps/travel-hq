import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookingDetailDialog } from "../../../src/client/components/BookingDetailDialog.js";

const booking = {
  id: "booking-1",
  tripId: "trip-1",
  sourceInboundEmailId: "mail-1",
  kind: "lodging",
  title: "Silverwood RV Park",
  location: "Athol, ID",
  startsAt: "2026-07-29T21:00:00.000Z",
  startsAtTz: "America/Boise",
  endsAt: null,
  endsAtTz: null,
  confirmationNumberMasked: "••••1234",
  costCents: 19_900,
  pointsUsed: null,
  pointsProgram: null,
  status: "planned" as const,
  details: { site: "A12" },
  personIds: [],
};

describe("BookingDetailDialog", () => {
  it("shows the parsed originating email and retained calendar artifact", async () => {
    const artifact = vi.fn(async () => ({
      artifact: {
        inboundEmailId: "mail-1",
        from: "reservations@silverwood.example",
        to: "trips@example.com",
        subject: "Your Silverwood RV Park Reservation",
        receivedAt: "2026-07-27T19:28:40.411Z",
        textBody: "Your site A12 is confirmed.",
        calendars: ["BEGIN:VCALENDAR\nSUMMARY:Silverwood RV Park\nEND:VCALENDAR"],
      },
    }));
    render(
      <BookingDetailDialog
        booking={booking}
        api={{ bookings: { artifact } } as never}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Your Silverwood RV Park Reservation"))
      .toBeInTheDocument();
    expect(screen.getByText("Your site A12 is confirmed.")).toBeInTheDocument();
    expect(screen.getByText(/Calendar artifact/)).toBeInTheDocument();
    expect(artifact).toHaveBeenCalledWith(booking.id);
    // Structured details render as readable rows, never as JSON.
    expect(screen.getByText("Site")).toBeInTheDocument();
    expect(screen.getByText("A12")).toBeInTheDocument();
    expect(screen.queryByText(/"site"/)).not.toBeInTheDocument();
  });

  it("reveals the full confirmation number on demand", async () => {
    const revealConfirmation = vi.fn(async () => ({ value: "SLVR-8088" }));
    render(
      <BookingDetailDialog
        booking={booking}
        api={{
          bookings: { artifact: vi.fn(async () => ({ artifact: null })) },
          trips: { revealConfirmation },
        } as never}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "••••1234" }));
    expect(await screen.findByText("SLVR-8088")).toBeInTheDocument();
    expect(revealConfirmation).toHaveBeenCalledWith(booking.tripId, booking.id);
  });

  it("explains when a manual booking has no email source", async () => {
    render(
      <BookingDetailDialog
        booking={{ ...booking, sourceInboundEmailId: null }}
        api={{ bookings: { artifact: vi.fn(async () => ({ artifact: null })) } } as never}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/entered manually/i)).toBeInTheDocument();
  });

  it("manually links and unlinks a traveler when their profile email was absent", async () => {
    const assignPerson = vi.fn(async () => undefined);
    const unassignPerson = vi.fn(async () => undefined);
    const changed = vi.fn();
    render(
      <BookingDetailDialog
        booking={booking}
        people={[{
          id: "person-david",
          displayName: "David Apsley",
          dob: null,
          email: "dapsley1@yahoo.com",
          phone: null,
          notes: null,
          passportExpiry: null,
          passportCountry: null,
          passportNumberMasked: null,
          knownTravelerNumberMasked: null,
          redressNumberMasked: null,
        }]}
        api={{
          bookings: {
            artifact: vi.fn(async () => ({ artifact: null })),
            assignPerson,
            unassignPerson,
          },
        } as never}
        onPeopleChanged={changed}
        onClose={vi.fn()}
      />,
    );

    const david = screen.getByRole("button", { name: /David Apsley/ });
    await userEvent.click(david);
    expect(assignPerson).toHaveBeenCalledWith(booking.id, "person-david");
    expect(david).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(david);
    expect(unassignPerson).toHaveBeenCalledWith(booking.id, "person-david");
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

/** The excursion this feature exists for. */
const tour = {
  ...booking,
  id: "booking-tour",
  kind: "other",
  title: "Going-to-the-Sun Road Red Bus tour",
  location: "West Glacier, MT",
  confirmationNumberMasked: null,
  costCents: null,
  details: {
    pickupTime: "1:30 PM",
    pickupLocation: "Quarter Circle/West Side Parking Lot",
    arriveMinutesBefore: 15,
    returnTime: "5:00 PM",
    duration: "3.5 hours",
  },
};

const noArtifact = { bookings: { artifact: vi.fn(async () => ({ artifact: null })) } };

describe("BookingDetailDialog excursion logistics", () => {
  it("puts the pickup, the call time and the return above the detail grid", async () => {
    render(<BookingDetailDialog booking={tour} api={noArtifact as never} onClose={vi.fn()} />);

    expect(await screen.findByText(/Quarter Circle\/West Side Parking Lot/))
      .toBeInTheDocument();
    expect(screen.getByText("Pickup")).toBeInTheDocument();
    expect(screen.getByText(/1:30 PM/)).toBeInTheDocument();
    expect(screen.getByText("Arrive 15 minutes early")).toBeInTheDocument();
    expect(screen.getByText("Return")).toBeInTheDocument();
    expect(screen.getByText(/5:00 PM/)).toBeInTheDocument();
    // Still shown once, and not a second time as a raw "Pickup time" row.
    expect(screen.queryByText("Pickup time")).not.toBeInTheDocument();
    expect(screen.queryByText("Arrive minutes before")).not.toBeInTheDocument();
    // Everything that is not logistics keeps its label–value row.
    expect(screen.getByText("Duration")).toBeInTheDocument();
  });

  it("shows no logistics block and no empty details heading for a booking with neither", async () => {
    render(
      <BookingDetailDialog
        booking={{ ...tour, details: {} }}
        api={noArtifact as never}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText(/entered manually/i);
    expect(screen.queryByText("Pickup")).not.toBeInTheDocument();
    // The dialog's own subtitle is also "Booking details"; the heading over
    // the (now empty) label–value grid is what must be gone.
    expect(
      screen.queryByRole("heading", { name: "Booking details" }),
    ).not.toBeInTheDocument();
  });

  it("swaps to the edit form and reports the save to its parent", async () => {
    const update = vi.fn(async () => tour);
    const onSaved = vi.fn();
    render(
      <BookingDetailDialog
        booking={tour}
        api={{ bookings: { ...noArtifact.bookings, update } } as never}
        onSaved={onSaved}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Edit / }));
    // The edit form replaces the detail view rather than stacking on it.
    expect(screen.queryByText("Source artifact")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Pickup location")).toHaveValue(
      "Quarter Circle/West Side Parking Lot",
    );

    await userEvent.clear(screen.getByLabelText("Pickup time"));
    await userEvent.type(screen.getByLabelText("Pickup time"), "2:00 PM");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0] as unknown[])[1]).toMatchObject({
      details: expect.objectContaining({ pickupTime: "2:00 PM" }),
    });
    expect(onSaved).toHaveBeenCalled();
  });
});

describe("BookingDetailDialog traveler edits before an edit", () => {
  it("does not undo a traveler linked from the detail view when the edit is saved", async () => {
    // The toggles write through immediately, so the `booking` prop is stale by
    // the time Edit is pressed. Seeding the edit form from it would diff the
    // new link away again.
    const assignPerson = vi.fn(async () => undefined);
    const unassignPerson = vi.fn(async () => undefined);
    const update = vi.fn(async () => tour);
    render(
      <BookingDetailDialog
        booking={{ ...tour, personIds: [] }}
        people={[{ id: "p1", displayName: "Badger" }] as never}
        api={{
          bookings: { ...noArtifact.bookings, assignPerson, unassignPerson, update },
        } as never}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Badger/ }));
    expect(assignPerson).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /^Edit / }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(update).toHaveBeenCalledTimes(1);
    expect(unassignPerson).not.toHaveBeenCalled();
    expect(assignPerson).toHaveBeenCalledTimes(1);
  });
});

/**
 * Following an event you are not travelling on (#61). The control states the
 * REASON as well as the state, because "you follow this trip" is what tells
 * someone that turning this one booking off is an exception rather than a
 * blanket mute.
 */
describe("BookingDetailDialog — notifications", () => {
  function renderWith(state: Record<string, unknown> | null, setBooking = vi.fn()) {
    const api = {
      bookings: { artifact: vi.fn(async () => ({ artifact: null })) },
      notifications: {
        forBooking: vi.fn(async () => {
          if (state === null) throw new Error("unavailable");
          return state;
        }),
        setBooking,
      },
    };
    render(<BookingDetailDialog booking={booking} api={api as never} onClose={vi.fn()} />);
    return api;
  }

  const base = { bookingId: "booking-1", tripId: "trip-1" };

  it("explains an implicit subscription for somebody travelling on it", async () => {
    renderWith({ ...base, implicit: true, bookingChoice: null, tripChoice: null, subscribed: true });
    expect(await screen.findByText(/you are travelling on this/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop notifying me/i })).toBeInTheDocument();
  });

  it("offers to follow a booking the reader is NOT on — the whole point of the feature", async () => {
    const setBooking = vi.fn(async () => ({
      ...base,
      implicit: false,
      bookingChoice: true,
      tripChoice: null,
      subscribed: true,
    }));
    renderWith(
      { ...base, implicit: false, bookingChoice: null, tripChoice: null, subscribed: false },
      setBooking,
    );
    await userEvent.click(await screen.findByRole("button", { name: /notify me about this/i }));
    expect(setBooking).toHaveBeenCalledWith("booking-1", true);
    expect(await screen.findByText(/you asked to be notified/i)).toBeInTheDocument();
  });

  it("names the trip-wide decision as the reason, when that is what it is", async () => {
    renderWith({ ...base, implicit: false, bookingChoice: null, tripChoice: true, subscribed: true });
    expect(await screen.findByText(/you follow this whole trip/i)).toBeInTheDocument();
    // No "use the default" while there is no per-booking decision to drop.
    expect(screen.queryByRole("button", { name: /use the default/i })).toBeNull();
  });

  it("offers a way back to the default once an explicit choice exists", async () => {
    const setBooking = vi.fn(async () => ({
      ...base,
      implicit: true,
      bookingChoice: null,
      tripChoice: null,
      subscribed: true,
    }));
    renderWith(
      { ...base, implicit: true, bookingChoice: false, tripChoice: null, subscribed: false },
      setBooking,
    );
    await userEvent.click(await screen.findByRole("button", { name: /use the default/i }));
    expect(setBooking).toHaveBeenCalledWith("booking-1", null);
  });

  it("hides the control entirely rather than stacking an error on the booking", async () => {
    renderWith(null);
    expect(await screen.findByText(/entered manually|no source email/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /notify me/i })).toBeNull();
  });
});

/**
 * `ensureMe()` links a pre-seeded person row or answers with nothing; it
 * stopped creating one. An account invited to a single shared trip has no row
 * at all, and "Add myself" used to assume a `Person` came back.
 */
describe("BookingDetailDialog — add myself with no profile", () => {
  function renderWithEnsureMe(ensureMe: () => Promise<unknown>) {
    const assignPerson = vi.fn(async () => undefined);
    const onPeopleChanged = vi.fn();
    render(
      <BookingDetailDialog
        booking={{ ...tour, personIds: [] }}
        people={[{ id: "p1", displayName: "Badger" }] as never}
        api={{
          bookings: { ...noArtifact.bookings, assignPerson },
          people: { ensureMe: vi.fn(ensureMe) },
        } as never}
        onPeopleChanged={onPeopleChanged}
        onClose={vi.fn()}
      />,
    );
    return { assignPerson, onPeopleChanged };
  }

  it("reports the missing profile rather than throwing or assigning somebody else", async () => {
    const { assignPerson, onPeopleChanged } = renderWithEnsureMe(async () => undefined);
    await userEvent.click(await screen.findByRole("button", { name: /add myself/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not on this household's list/i);
    // The dangerous alternative is silently linking whichever row happened to
    // be to hand — the wrong traveller on a booking, with a 200.
    expect(assignPerson).not.toHaveBeenCalled();
    expect(onPeopleChanged).not.toHaveBeenCalled();
  });

  it("still assigns the linked row when there is one", async () => {
    const { assignPerson } = renderWithEnsureMe(async () => ({ id: "p9", displayName: "Ava" }));
    await userEvent.click(await screen.findByRole("button", { name: /add myself/i }));
    expect(assignPerson).toHaveBeenCalledWith("booking-tour", "p9");
  });
});
