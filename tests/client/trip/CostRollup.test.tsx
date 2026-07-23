import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostRollup } from "../../../src/client/trip/CostRollup.js";

describe("CostRollup", () => {
  it("formats dollars from cents", () => {
    render(
      <CostRollup
        rollup={{
          bookedCents: 148_400, plannedCents: 0, totalCents: 148_400,
          draftCount: 0, points: [],
        }}
      />,
    );
    expect(screen.getByText("$1,484.00")).toBeInTheDocument();
  });

  it("lists points by program", () => {
    render(
      <CostRollup
        rollup={{
          bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 0,
          points: [{ program: "SkyMiles", used: 18_500 }],
        }}
      />,
    );
    expect(screen.getByText("18,500 SkyMiles")).toBeInTheDocument();
  });

  it("shows the card portfolio's balance beside a program when one is known", () => {
    render(
      <CostRollup
        rollup={{
          bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 0,
          points: [
            { program: "UR", used: 12_500, balance: 85_000 },
            { program: "SkyMiles", used: 18_500, balance: null },
          ],
        }}
      />,
    );
    expect(screen.getByText(/12,500 UR · of 85,000 available/)).toBeInTheDocument();
    // A null balance (no card carries the program) adds nothing.
    expect(screen.getByText("18,500 SkyMiles")).toBeInTheDocument();
  });

  it("separates planned from booked when both exist", () => {
    render(
      <CostRollup
        rollup={{
          bookedCents: 100_000, plannedCents: 48_400, totalCents: 148_400,
          draftCount: 0, points: [],
        }}
      />,
    );
    expect(screen.getByText(/\$484\.00 planned/)).toBeInTheDocument();
  });

  it("renders nothing when there is no cost, no points, and no drafts", () => {
    const { container } = render(
      <CostRollup
        rollup={{ bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 0, points: [] }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Finding 4: excluding drafts from the total is the recorded decision, but
  // a $200 total beside a $500 draft row + a $200 booked row with no
  // explanation reads as a bug, not a policy. The panel must say so.
  it("discloses excluded drafts when the total doesn't cover every visible row", () => {
    render(
      <CostRollup
        rollup={{
          bookedCents: 20_000, plannedCents: 0, totalCents: 20_000,
          draftCount: 1, points: [],
        }}
      />,
    );
    expect(screen.getByText(/excludes 1 draft/i)).toBeInTheDocument();
  });

  it("pluralizes the draft disclosure for more than one draft", () => {
    render(
      <CostRollup
        rollup={{
          bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 2, points: [],
        }}
      />,
    );
    expect(screen.getByText(/excludes 2 drafts/i)).toBeInTheDocument();
  });

  it("renders the panel to disclose drafts even when the total is otherwise zero", () => {
    // Without draftCount in the "render nothing" guard, a trip with only
    // draft bookings would render no panel at all, silently hiding the one
    // piece of information ("we found something, we're just not counting
    // it yet") this disclosure exists to surface.
    const { container } = render(
      <CostRollup
        rollup={{ bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 1, points: [] }}
      />,
    );
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText(/excludes 1 draft/i)).toBeInTheDocument();
  });
});
