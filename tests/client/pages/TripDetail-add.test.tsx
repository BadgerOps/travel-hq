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

  it("still offers no trip-edit control", async () => {
    // Deliberate: there is no trip-update endpoint, so design 1b's pencil
    // stays absent rather than becoming a second inert affordance.
    renderDetail();
    await screen.findByRole("button", { name: /add booking/i });
    expect(screen.queryByRole("button", { name: /edit trip/i })).not.toBeInTheDocument();
  });

  it("reloads bookings without eagerly loading the unopened cost tab", async () => {
    const api = renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /add booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    // Once on mount, once after the save. The cost rollup remains deferred
    // until its tab is opened.
    await vi.waitFor(() => expect(api.trips.bookings).toHaveBeenCalledTimes(2));
    expect(api.trips.rollup).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
