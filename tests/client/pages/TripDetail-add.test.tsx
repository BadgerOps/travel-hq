import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TripDetail } from "../../../src/client/pages/TripDetail.js";

const TRIP = {
  id: "t1", title: "Mary & Winter Wedding", destination: "Guerneville, CA",
  startsOn: "2026-10-09", endsOn: "2026-10-11",
  status: "planning" as const, notes: null,
};
const PEOPLE = [{ id: "p1", displayName: "Badger" }];
const ZERO = { bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 0, points: [] };

function makeApi() {
  return {
    trips: {
      get: vi.fn(async () => TRIP),
      bookings: vi.fn(async () => []),
      travelers: vi.fn(async () => PEOPLE),
      itinerary: vi.fn(async () => []),
      rollup: vi.fn(async () => ZERO),
      revealConfirmation: vi.fn(),
      createBooking: vi.fn(async () => ({ id: "b1" })),
    },
    people: { list: vi.fn(async () => PEOPLE), reveal: vi.fn() },
    bookings: { assignPerson: vi.fn(), setStatus: vi.fn() },
    checklist: { list: vi.fn(async () => []), create: vi.fn(), setDone: vi.fn() },
  };
}

function renderDetail(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/trips/t1" });
  render(
    <Router hook={hook}>
      <TripDetail id="t1" api={api as never} today="2026-07-21" />
    </Router>,
  );
  return api;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/trips/t1");
});

describe("TripDetail — add booking", () => {
  it("offers Add booking in the header", async () => {
    renderDetail();
    expect(await screen.findByRole("button", { name: /add booking/i })).toBeInTheDocument();
  });

  it("opens the booking dialog", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /add booking/i }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add booking");
  });

  it("offers trip management from the header menu", async () => {
    renderDetail();
    await screen.findByRole("button", { name: /add booking/i });
    // The management actions are behind the ⋯ disclosure, so they are absent
    // until it is opened — and present once it is.
    expect(screen.queryByRole("button", { name: /check duplicates/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/trip menu/i));
    expect(screen.getByRole("button", { name: /check duplicates/i })).toBeInTheDocument();
  });

  it("reloads bookings and refreshes the rail cost rollup after a save", async () => {
    const api = renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /add booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    // Bookings: once on mount, once after the save. Rollup: same — Overview's
    // rail cost card loads it with the tab and must not go stale after the
    // save adds a cost.
    await vi.waitFor(() => expect(api.trips.bookings).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(api.trips.rollup).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
