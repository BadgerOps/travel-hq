import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewTab } from "../../../src/client/trip/OverviewTab.js";
import type { Booking } from "../../../src/client/api/types.js";

const TRIP = {
  id: "t1", title: "Wedding", destination: "Guerneville, CA",
  startsOn: "2026-10-09", endsOn: "2026-10-11",
  status: "planning" as const, notes: null, photoUrl: null,
};

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1", tripId: "t1", kind: "flight", title: "DL1422 BOI → ATL",
    location: null,
    startsAt: "2026-10-10T05:30:00Z", startsAtTz: "America/Boise",
    endsAt: "2026-10-10T11:00:00Z", endsAtTz: "America/New_York",
    confirmationNumberMasked: "••••X4T2", costCents: 42_000,
    pointsUsed: null, pointsProgram: null,
    status: "booked" as const, details: {}, personIds: ["p1"],
    ...over,
  };
}

const PEOPLE = [{ id: "p1", displayName: "Badger" }];
function renderTab(bookings: unknown[], onBookingClick?: (booking: Booking) => void) {
  return render(
    <OverviewTab
      trip={TRIP}
      bookings={bookings as never}
      people={PEOPLE as never}
      api={{ trips: { revealConfirmation: vi.fn() } } as never}
      onBookingClick={onBookingClick}
    />,
  );
}

describe("OverviewTab", () => {
  it("groups bookings under kind headings", () => {
    renderTab([booking(), booking({ id: "b2", kind: "lodging", title: "Highlands Resort" })]);
    expect(screen.getByText("Flights")).toBeInTheDocument();
    expect(screen.getByText("Stay & car")).toBeInTheDocument();
  });

  it("renders both timezones when they differ", () => {
    renderTab([booking()]);
    expect(screen.getByText(/MDT → .*EDT/)).toBeInTheDocument();
  });

  it("masks the confirmation number", () => {
    renderTab([booking()]);
    expect(screen.getByText("••••X4T2")).toBeInTheDocument();
    expect(screen.getByText(/Confirmation/)).toBeInTheDocument();
  });

  it("surfaces site details so separate RV reservations are distinguishable", () => {
    renderTab([booking({
      kind: "lodging",
      title: "Silverwood RV Park Reservation",
      location: "Silverwood RV Park",
      details: { propertyName: "Silverwood RV Park", site: "11", type: "RV" },
    })]);

    expect(screen.getByText("Stay & car")).toBeInTheDocument();
    expect(screen.getByText("Site 11")).toBeInTheDocument();
    expect(screen.getByText("RV")).toBeInTheDocument();
  });

  it("keeps prices out of the event-focused overview", () => {
    renderTab([booking({ costCents: 42_000 })]);
    expect(screen.queryByText("$420.00")).not.toBeInTheDocument();
  });

  it("tags a planned booking as needing booking", () => {
    renderTab([booking({ status: "planned" })]);
    expect(screen.getByText("Needs booking")).toBeInTheDocument();
  });

  it("tags a draft booking as a draft rather than as needing booking", () => {
    // A draft is an unreviewed email import, not a decision the family has
    // made. RollupRepo excludes it from the cost panel on this same screen,
    // so presenting it as "needs booking" would have the booking list and the
    // cost panel disagreeing about what exists.
    renderTab([booking({ status: "draft" })]);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.queryByText("Needs booking")).not.toBeInTheDocument();
  });

  it("omits cancelled bookings entirely", () => {
    renderTab([booking({ status: "cancelled", title: "Cancelled hotel" })]);
    expect(screen.queryByText("Cancelled hotel")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing booked yet/i)).toBeInTheDocument();
  });

  it("renders an empty state with no bookings", () => {
    renderTab([]);
    expect(screen.getByText(/Nothing booked yet/i)).toBeInTheDocument();
  });

  it("opens booking details from the booking card", async () => {
    const onBookingClick = vi.fn();
    renderTab([booking()], onBookingClick);
    await userEvent.click(
      screen.getByRole("button", { name: "View details for DL1422 BOI → ATL" }),
    );
    expect(onBookingClick).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
  });
});
