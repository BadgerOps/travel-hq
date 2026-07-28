import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TripDetail } from "../../../src/client/pages/TripDetail.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";

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

function makeApi(trip: Record<string, unknown> = TRIP, bookings: unknown[] = []) {
  return {
    trips: {
      get: vi.fn(async () => trip),
      bookings: vi.fn(async () => bookings),
      travelers: vi.fn(async () => PEOPLE),
      itinerary: vi.fn(async () => []),
      rollup: vi.fn(async () => ({
        bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 0, points: [],
      })),
      revealConfirmation: vi.fn(),
      update: vi.fn(async () => ({ ...trip, status: "cancelled" })),
      delete: vi.fn(async () => undefined),
      addTraveler: vi.fn(async () => undefined),
      removeTraveler: vi.fn(async () => undefined),
    },
    people: { list: vi.fn(async () => PEOPLE), reveal: vi.fn() },
    checklist: { list: vi.fn(async () => []), create: vi.fn(), setDone: vi.fn() },
  };
}

function renderDetail(api = makeApi(), role?: "owner" | "viewer") {
  const { hook } = memoryLocation({ path: "/trips/t1" });
  const page = (
    <Router hook={hook}>
      <TripDetail id="t1" api={api as never} today="2026-07-21" />
    </Router>
  );
  if (!role) return render(page);
  const me = vi.fn(async () => ({ userId: "u1", email: "x@example.com", householdId: "hh", role }));
  return render(<IdentityProvider api={{ me } as never}>{page}</IdentityProvider>);
}

beforeEach(() => {
  window.history.replaceState(null, "", "/trips/t1");
});

describe("TripDetail management", () => {
  it("opens the edit form from the header pencil, seeded from the trip", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: "Edit trip" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Title")).toHaveValue(TRIP.title);
    expect(within(dialog).getByRole("radio", { name: "Auto (planning)" })).toBeChecked();
  });

  it("saving the edit form PUTs a partial update and reloads the trip", async () => {
    const api = makeApi();
    api.trips.update = vi.fn(async () => ({ ...TRIP, title: "Wedding weekend" }));
    renderDetail(api);
    await userEvent.click(await screen.findByRole("button", { name: "Edit trip" }));
    const getCalls = api.trips.get.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(api.trips.update).toHaveBeenCalledWith("t1", expect.objectContaining({ title: TRIP.title }));
    // The page reloads rather than hand-patching state.
    await waitFor(() => expect(api.trips.get.mock.calls.length).toBeGreaterThan(getCalls));
  });

  it("cancels the trip behind a confirm", async () => {
    const api = makeApi();
    renderDetail(api);
    await screen.findByText(TRIP.title);
    await userEvent.click(screen.getByRole("button", { name: "Cancel trip" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/can be restored/i)).toBeInTheDocument();
    // Nothing sent yet — the footer click only opened the confirm.
    expect(api.trips.update).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel trip" }));
    expect(api.trips.update).toHaveBeenCalledWith("t1", { status: "cancelled" });
  });

  it("offers Restore on a cancelled trip and sends it back to planning", async () => {
    const api = makeApi({ ...TRIP, status: "cancelled" });
    renderDetail(api);
    await screen.findByText(TRIP.title);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel trip" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore trip" }));
    expect(api.trips.update).toHaveBeenCalledWith("t1", { status: "planning" });
  });

  it("hard-deletes only after the double confirm, with the cascade warning", async () => {
    const api = makeApi(TRIP, [{ id: "b1", status: "booked", personIds: [], kind: "flight", title: "F", location: null, startsAt: null, startsAtTz: null, endsAt: null, endsAtTz: null, confirmationNumberMasked: null, costCents: null, pointsUsed: null, pointsProgram: null, details: {}, tripId: "t1" }, { id: "b2", status: "planned", personIds: [], kind: "lodging", title: "L", location: null, startsAt: null, startsAtTz: null, endsAt: null, endsAtTz: null, confirmationNumberMasked: null, costCents: null, pointsUsed: null, pointsProgram: null, details: {}, tripId: "t1" }]);
    renderDetail(api);
    await screen.findByText(TRIP.title);
    await userEvent.click(screen.getByRole("button", { name: "Delete trip" }));
    const dialog = screen.getByRole("dialog");
    // The cascade warning names what goes with the trip.
    expect(within(dialog).getByText(/removes 2 bookings/i)).toBeInTheDocument();

    // First confirm click only arms the button.
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete trip" }));
    expect(api.trips.delete).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: /permanently delete/i }));
    expect(api.trips.delete).toHaveBeenCalledWith("t1");
  });

  it("removes a traveller behind a confirm that names the booking unassignment", async () => {
    const api = makeApi();
    renderDetail(api);
    await screen.findByText(TRIP.title);
    await userEvent.click(screen.getByRole("radio", { name: "Travelers" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove Badger from trip" }));
    expect(screen.getByText(/off this trip's bookings/i)).toBeInTheDocument();
    // Nothing sent yet — and Keep backs out.
    expect(api.trips.removeTraveler).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove Badger" }));
    expect(api.trips.removeTraveler).toHaveBeenCalledWith("t1", "p1");
  });

  it("adds selected people to an existing trip and reloads its roster", async () => {
    const api = makeApi();
    api.people.list = vi.fn(async () => [
      ...PEOPLE,
      { id: "p2", displayName: "Ava" },
    ]);
    renderDetail(api);
    await screen.findByText(TRIP.title);
    await userEvent.click(screen.getByRole("radio", { name: "Travelers" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Add travelers" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    const travelerCalls = api.trips.travelers.mock.calls.length;
    await userEvent.click(
      screen.getByRole("button", { name: "Add selected travelers" }),
    );

    expect(api.trips.addTraveler).toHaveBeenCalledWith("t1", "p2");
    await waitFor(() =>
      expect(api.trips.travelers.mock.calls.length).toBeGreaterThan(travelerCalls),
    );
  });

  it("offers a viewer none of the management affordances", async () => {
    renderDetail(makeApi(), "viewer");
    await screen.findByText(TRIP.title);
    // useCanWrite fails open while /api/me is in flight, so wait for the
    // resolved viewer identity to strip the controls.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: `Edit ${TRIP.title}` })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Cancel trip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete trip" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Travelers" }));
    expect(await screen.findByText("Badger")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Badger from trip" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the page and reports a rejected cancel rather than String(err)", async () => {
    const api = makeApi();
    api.trips.update = vi.fn(async () => {
      throw new Error("boom");
    });
    renderDetail(api);
    await screen.findByText(TRIP.title);
    await userEvent.click(screen.getByRole("button", { name: "Cancel trip" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel trip" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/something went wrong/i);
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    // The trip itself is still on screen.
    expect(screen.getByText(TRIP.title)).toBeInTheDocument();
  });
});
