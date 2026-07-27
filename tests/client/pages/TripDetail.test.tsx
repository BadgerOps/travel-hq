import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TripDetail } from "../../../src/client/pages/TripDetail.js";

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
};

const PEOPLE = [{ id: "p1", displayName: "Badger" }];

function makeApi() {
  return {
    trips: {
      list: vi.fn(async () => [TRIP]),
      bookings: vi.fn(async () => []),
      travelers: vi.fn(async () => PEOPLE),
      itinerary: vi.fn(async () => []),
      rollup: vi.fn(async () => ({
        bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 0, points: [],
      })),
      revealConfirmation: vi.fn(),
    },
    people: { list: vi.fn(async () => PEOPLE), reveal: vi.fn() },
    checklist: { list: vi.fn(async () => []), create: vi.fn(), setDone: vi.fn() },
  };
}

function renderDetail(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/trips/t1" });
  return render(
    <Router hook={hook}>
      <TripDetail id="t1" api={api as never} today="2026-07-21" />
    </Router>,
  );
}

beforeEach(() => {
  // The tab lives in the real `window.location.hash` (wouter's memoryLocation
  // owns the path only), so it leaks between tests unless reset.
  window.history.replaceState(null, "", "/trips/t1");
});

describe("TripDetail", () => {
  it("renders the trip title and destination", async () => {
    renderDetail();
    expect(await screen.findByText("Mary & Winter Wedding")).toBeInTheDocument();
    expect(screen.getByText("Guerneville, CA")).toBeInTheDocument();
  });

  it("renders all five tabs", async () => {
    renderDetail();
    for (const tab of ["Overview", "Day by day", "Costs", "Travelers", "Checklist"]) {
      expect(await screen.findByRole("radio", { name: tab })).toBeInTheDocument();
    }
  });

  it("opens on Overview", async () => {
    renderDetail();
    expect(await screen.findByRole("radio", { name: "Overview" })).toBeChecked();
  });

  it("switches tabs on click", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("radio", { name: "Day by day" }));
    expect(screen.getByRole("radio", { name: "Day by day" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Overview" })).not.toBeChecked();
  });

  it("switches tabs from the keyboard", async () => {
    // The whole point of keeping the native radio group: arrow keys move
    // between options with no roving-tabindex code of our own. A test that
    // only clicks would pass just as well against a broken custom widget.
    renderDetail();
    const overview = await screen.findByRole("radio", { name: "Overview" });
    overview.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Day by day" })).toBeChecked();
    expect(overview).not.toBeChecked();
  });

  it("opens on the tab named in the URL hash", async () => {
    window.history.replaceState(null, "", "/trips/t1#travelers");
    renderDetail();
    expect(await screen.findByRole("radio", { name: "Travelers" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Overview" })).not.toBeChecked();
  });

  it("writes the selected tab to the URL hash", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("radio", { name: "Checklist" }));
    expect(window.location.hash).toBe("#checklist");
  });

  it("reports a missing trip rather than rendering blank", async () => {
    const api = makeApi();
    api.trips.list = vi.fn(async () => []);
    renderDetail(api);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than spinning forever", async () => {
    // Drives an actual rejection. The previous version of this suite only
    // ever resolved its mocks, so a component with no `.catch` passed it
    // while, in production, any 404 (stale link, other household's trip)
    // left the page on "Loading…" plus an unhandled promise rejection.
    const api = makeApi();
    api.trips.bookings = vi.fn(async () => {
      throw new Error("404 Not found");
    });
    renderDetail(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load|could not load/i);
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });
});
