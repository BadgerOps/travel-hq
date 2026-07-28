import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DayView } from "../../../src/client/dayview/DayView.js";

const PEOPLE = [
  { id: "p-badger", displayName: "Badger" },
  { id: "p-ava", displayName: "Ava" },
];

function booking(id: string, title: string, personIds: string[]) {
  return {
    id, tripId: "t1", kind: "other", title, location: null,
    startsAt: "2026-10-09T15:00:00Z", startsAtTz: "America/Boise",
    endsAt: null, endsAtTz: null, confirmationNumberMasked: null,
    costCents: null, pointsUsed: null, pointsProgram: null,
    status: "booked" as const, details: {}, personIds,
  };
}

const DAYS = [
  {
    date: "2026-10-09",
    bookings: [
      booking("b1", "Shared flight", ["p-badger", "p-ava"]),
      booking("b2", "Badger's solo dinner", ["p-badger"]),
    ],
  },
  { date: "2026-10-10", bookings: [booking("b3", "Wedding", ["p-badger", "p-ava"])] },
];

function makeApi(days = DAYS) {
  return { trips: { itinerary: vi.fn(async () => days) } };
}

function renderDayView(api = makeApi()) {
  return render(<DayView tripId="t1" people={PEOPLE as never} api={api as never} />);
}

describe("DayView", () => {
  it("renders the first day's bookings", async () => {
    renderDayView();
    expect(await screen.findByText("Shared flight")).toBeInTheDocument();
    expect(screen.getByText("Badger's solo dinner")).toBeInTheDocument();
  });

  it("opens booking details from a daily card", async () => {
    const onBookingClick = vi.fn();
    render(
      <DayView
        tripId="t1"
        people={PEOPLE as never}
        api={makeApi() as never}
        onBookingClick={onBookingClick}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "View details for Shared flight" }),
    );
    expect(onBookingClick).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
  });

  it("offers a filter chip per traveller", async () => {
    renderDayView();
    for (const name of ["Badger", "Ava"]) {
      expect(await screen.findByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  it("refetches scoped to one person when a chip is selected", async () => {
    const api = makeApi();
    renderDayView(api);
    await screen.findByText("Shared flight");
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    expect(api.trips.itinerary).toHaveBeenLastCalledWith("t1", "p-ava");
  });

  it("returns to the whole-family view when the chip is deselected", async () => {
    const api = makeApi();
    renderDayView(api);
    await screen.findByText("Shared flight");
    const chip = screen.getByRole("button", { name: /Ava/ });
    await userEvent.click(chip);
    await userEvent.click(chip);
    expect(api.trips.itinerary).toHaveBeenLastCalledWith("t1", undefined);
  });

  it("pages between days", async () => {
    renderDayView();
    await screen.findByText("Shared flight");
    await userEvent.click(screen.getByRole("button", { name: /next day/i }));
    expect(screen.getByText("Wedding")).toBeInTheDocument();
    expect(screen.queryByText("Shared flight")).not.toBeInTheDocument();
  });

  it("renders an empty state when nothing is scheduled", async () => {
    renderDayView(makeApi([]));
    expect(await screen.findByText(/Nothing scheduled/i)).toBeInTheDocument();
  });

  // Finding 5: filtering by person refetches a (usually shorter) day list.
  // Clamping the array *index* instead of preserving the *date* means a date
  // that is still present in the filtered set -- just at a different array
  // position -- gets silently swapped out from under the viewer. Three
  // unfiltered days (index 2 = Oct 11); filtering drops Oct 9 but keeps Oct
  // 10 and Oct 11, at indices 0 and 1. Clamping index 2 to the new max index
  // (1) would land on Oct 10; preserving the date "2026-10-11" must not.
  it("stays on the same date after a refetch that still contains it, even at a new index", async () => {
    const threeDays = [
      { date: "2026-10-09", bookings: [booking("b1", "Day nine thing", ["p-badger"])] },
      { date: "2026-10-10", bookings: [booking("b2", "Day ten thing", ["p-badger", "p-ava"])] },
      { date: "2026-10-11", bookings: [booking("b3", "Day eleven thing", ["p-badger", "p-ava"])] },
    ];
    const filteredToAva = [
      { date: "2026-10-10", bookings: [booking("b2", "Day ten thing", ["p-badger", "p-ava"])] },
      { date: "2026-10-11", bookings: [booking("b3", "Day eleven thing", ["p-badger", "p-ava"])] },
    ];
    const api = {
      trips: {
        itinerary: vi.fn(async (_tripId: string, personId?: string) =>
          personId ? filteredToAva : threeDays,
        ),
      },
    };
    renderDayView(api as never);

    await screen.findByText("Day nine thing");
    await userEvent.click(screen.getByRole("button", { name: /next day/i }));
    await userEvent.click(screen.getByRole("button", { name: /next day/i }));
    expect(await screen.findByText("Day eleven thing")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));

    // Still Oct 11's booking, not Oct 10's -- an index-clamped refetch would
    // have landed on "Day ten thing" here instead.
    expect(await screen.findByText("Day eleven thing")).toBeInTheDocument();
    expect(screen.queryByText("Day ten thing")).not.toBeInTheDocument();
  });

  it("falls back to the nearest available day when the current date is filtered out entirely", async () => {
    const threeDays = [
      { date: "2026-10-09", bookings: [booking("b1", "Day nine thing", ["p-badger"])] },
      { date: "2026-10-10", bookings: [booking("b2", "Day ten thing", ["p-badger"])] },
      { date: "2026-10-11", bookings: [booking("b3", "Day eleven thing", ["p-badger", "p-ava"])] },
    ];
    // Ava is only ever on the Oct 11 booking.
    const filteredToAva = [
      { date: "2026-10-11", bookings: [booking("b3", "Day eleven thing", ["p-badger", "p-ava"])] },
    ];
    const api = {
      trips: {
        itinerary: vi.fn(async (_tripId: string, personId?: string) =>
          personId ? filteredToAva : threeDays,
        ),
      },
    };
    renderDayView(api as never);

    await screen.findByText("Day nine thing");
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));

    expect(await screen.findByText("Day eleven thing")).toBeInTheDocument();
  });

  it("reports a failed itinerary load rather than spinning forever", async () => {
    const api = { trips: { itinerary: vi.fn(async () => { throw new Error("404"); }) } };
    renderDayView(api as never);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load|could not load/i);
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  // Every other booking fixture in this file is America/Boise. A component
  // that (accidentally) formatted every time in one hardcoded or
  // viewer-local zone instead of each booking's own `startsAtTz` would still
  // pass all of the above.
  it("renders each booking's time in its own timezone rather than one shared zone", async () => {
    const boise = booking("b1", "Boise departure", ["p-badger"]);
    const tokyo = {
      ...booking("b2", "Tokyo dinner", ["p-ava"]),
      startsAt: "2026-10-09T11:00:00Z",
      startsAtTz: "Asia/Tokyo",
    };
    renderDayView(makeApi([{ date: "2026-10-09", bookings: [boise, tokyo] }]));

    // 2026-10-09T15:00:00Z in America/Boise (MDT, UTC-6) is 9:00 AM.
    expect(await screen.findByText("9:00 AM")).toBeInTheDocument();
    // 2026-10-09T11:00:00Z in Asia/Tokyo (UTC+9) is 8:00 PM the same UTC day.
    expect(screen.getByText("8:00 PM")).toBeInTheDocument();
  });

  // Finding 2: BookingRepo.assignPerson now also adds the assignee to
  // trip_person, so every personId on a booking is guaranteed to be in the
  // `travelers` list this component (and PersonFilter) is given -- this
  // locks in that every one of them actually gets a rendered chip, not just
  // the first or the ones that happen to already be traveler chips.
  it("resolves a person chip for every personId on a booking", async () => {
    renderDayView();
    await screen.findByText("Shared flight");
    const flightCard = screen.getByText("Shared flight").closest(".booking-row") as HTMLElement;
    expect(within(flightCard).getByTitle("Badger")).toBeInTheDocument();
    expect(within(flightCard).getByTitle("Ava")).toBeInTheDocument();
  });
});
