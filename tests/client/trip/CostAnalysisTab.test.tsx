import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CostAnalysisTab } from "../../../src/client/trip/CostAnalysisTab.js";
import type { Booking, Trip, TripRollup } from "../../../src/client/api/types.js";

const trip: Trip = {
  id: "trip-1",
  title: "Wedding",
  destination: "California",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning",
  notes: null,
};

function booking(
  id: string,
  title: string,
  kind: string,
  date: string,
  costCents: number,
  status: Booking["status"],
): Booking {
  return {
    id,
    tripId: trip.id,
    sourceInboundEmailId: null,
    kind,
    title,
    location: null,
    startsAt: `${date}T18:00:00.000Z`,
    startsAtTz: "UTC",
    endsAt: null,
    endsAtTz: null,
    confirmationNumberMasked: null,
    costCents,
    pointsUsed: null,
    pointsProgram: null,
    status,
    details: {},
    personIds: [],
  };
}

const bookings = [
  booking("flight", "Wedding flight", "flight", "2026-10-09", 60_000, "booked"),
  booking("hotel", "Wedding hotel", "lodging", "2026-10-10", 40_000, "planned"),
  booking("draft", "Unreviewed dinner", "activity", "2026-10-11", 20_000, "draft"),
];

const rollup: TripRollup = {
  bookedCents: 60_000,
  plannedCents: 40_000,
  totalCents: 100_000,
  draftCount: 1,
  points: [{ program: "SkyMiles", used: 18_500, balance: 60_000 }],
};

describe("CostAnalysisTab", () => {
  it("shows authoritative totals and useful status/category breakdowns", () => {
    render(<CostAnalysisTab trip={trip} bookings={bookings} rollup={rollup} />);

    const summary = screen.getByRole("region", { name: "Trip cost summary" });
    expect(within(summary).getByText("Total trip cost")).toBeInTheDocument();
    expect(within(summary).getByText("$1,000.00")).toBeInTheDocument();
    expect(within(summary).getByText("$600.00")).toBeInTheDocument();
    expect(within(summary).getByText("$400.00")).toBeInTheDocument();

    const categories = screen.getByRole("region", { name: "Cost by category" });
    expect(within(categories).getByText("Flights")).toBeInTheDocument();
    expect(within(categories).getByText("$600.00 · 60%")).toBeInTheDocument();
    expect(within(categories).getByText("Lodging")).toBeInTheDocument();
    expect(screen.getByText(/excludes 1 unreviewed draft/i)).toBeInTheDocument();
    expect(screen.getByText("18,500").closest(".card-meta"))
      .toHaveTextContent("18,500 SkyMiles · 60,000 available");
  });

  it("graphs the whole trip and filters the booking breakdown to one day", async () => {
    const { container } = render(
      <CostAnalysisTab trip={trip} bookings={bookings} rollup={rollup} />,
    );

    expect(
      screen.getByRole("img", {
        name: "Line graph of booking costs across the whole trip",
      }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll("circle[data-date]")).toHaveLength(3);
    expect(
      container.querySelector('circle[data-date="2026-10-11"]'),
    ).toHaveAttribute("data-cost-cents", "0");

    await userEvent.selectOptions(screen.getByLabelText("Cost day"), "2026-10-10");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sat, Oct 10 total: $400.00",
    );
    const dayBookings = screen.getByRole("region", {
      name: "Bookings on Sat, Oct 10",
    });
    expect(within(dayBookings).getByText("Wedding hotel")).toBeInTheDocument();
    expect(within(dayBookings).queryByText("Wedding flight")).not.toBeInTheDocument();

    // Selecting a day focuses the breakdown; the graph still contains every
    // trip day so the selected point keeps its full-trip context.
    expect(container.querySelectorAll("circle[data-date]")).toHaveLength(3);
  });
});
