import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { OverviewTab } from "../../../src/client/trip/OverviewTab.js";
import { DayView } from "../../../src/client/dayview/DayView.js";

/**
 * Finding 2: OverviewTab renders against the household's full `people` list;
 * DayView/SharedAgenda render against `travelers` (trip_person). Before this
 * wave's fix, BookingRepo.assignPerson could put someone on a booking
 * without adding them to trip_person, so the same booking would show a
 * chip on Overview and silently omit it in the day view. The fix
 * (assignPerson also does `INSERT OR IGNORE INTO trip_person`) means every
 * personId that appears on a booking is guaranteed to be in `travelers` --
 * this test locks in the consequence: given the same bookings and a
 * `travelers` list built the way the fixed assignPerson guarantees it (a
 * superset of every booking's personIds), the two tabs must agree on which
 * bookings exist for the trip.
 */

const TRIP = {
  id: "t1", title: "Wedding", destination: "Guerneville, CA",
  startsOn: "2026-10-09", endsOn: "2026-10-11",
  status: "planning" as const, notes: null,
};

const TRAVELERS = [
  { id: "p-badger", displayName: "Badger" },
  { id: "p-ava", displayName: "Ava" },
];

// OverviewTab is given the whole household, which may include people not on
// this trip at all -- that's the point of the split. It must not affect
// which *bookings* render.
const HOUSEHOLD_PEOPLE = [...TRAVELERS, { id: "p-guest", displayName: "Guest" }];

function booking(id: string, title: string, personIds: string[]) {
  return {
    id, tripId: "t1", kind: "other" as const, title, location: null,
    startsAt: "2026-10-09T15:00:00Z", startsAtTz: "America/Boise",
    endsAt: null, endsAtTz: null, confirmationNumberMasked: null,
    costCents: null, pointsUsed: null, pointsProgram: null,
    status: "booked" as const, details: {}, personIds,
  };
}

const BOOKINGS = [
  booking("b1", "Shared flight", ["p-badger", "p-ava"]),
  booking("b2", "Rehearsal dinner", ["p-badger"]),
];

describe("Overview and day-view booking-set parity", () => {
  it("renders the same booking titles in Overview and the day view for the same trip", async () => {
    const overview = render(
      <OverviewTab
        trip={TRIP}
        bookings={BOOKINGS as never}
        people={HOUSEHOLD_PEOPLE as never}
        api={{ trips: { revealConfirmation: vi.fn() } } as never}
      />,
    );
    expect(within(overview.container).getByText("Shared flight")).toBeInTheDocument();
    expect(within(overview.container).getByText("Rehearsal dinner")).toBeInTheDocument();

    const api = {
      trips: {
        itinerary: vi.fn(async () => [{ date: "2026-10-09", bookings: BOOKINGS }]),
      },
    };
    const dayView = render(<DayView tripId="t1" people={TRAVELERS as never} api={api as never} />);

    expect(await within(dayView.container).findByText("Shared flight")).toBeInTheDocument();
    expect(within(dayView.container).getByText("Rehearsal dinner")).toBeInTheDocument();
  });
});
