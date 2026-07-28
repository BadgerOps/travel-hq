import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Trips } from "../../../src/client/pages/Trips.js";

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
  photoUrl: null,
};

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

const BOOKING = {
  id: "b1",
  tripId: "t1",
  kind: "flight",
  title: "DL 2214 BOI → STS",
  location: null,
  startsAt: "2026-10-09T15:00:00Z",
  startsAtTz: "America/Boise",
  endsAt: null,
  endsAtTz: null,
  confirmationNumberMasked: null,
  costCents: null,
  pointsUsed: null,
  pointsProgram: null,
  status: "booked" as const,
  details: {},
  personIds: ["p1"],
};

function makeApi(trips = [TRIP]) {
  return {
    trips: {
      list: vi.fn(async () => trips),
      bookings: vi.fn(async () => [] as unknown[]),
      create: vi.fn(async () => ({ ...TRIP, id: "t2", title: "Kauai" })),
      addTraveler: vi.fn(async () => undefined),
    },
    people: { list: vi.fn(async () => PEOPLE) },
    imports: {
      pending: vi.fn(async () => []),
      createTrip: vi.fn(),
    },
  };
}

function renderTrips(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/trips" });
  render(
    <Router hook={hook}>
      <Trips api={api as never} today="2026-07-21" />
    </Router>,
  );
  return api;
}

describe("Trips", () => {
  it("lists trips", async () => {
    const api = renderTrips();
    expect(await screen.findByText("Mary & Winter Wedding")).toBeInTheDocument();
    expect(api.trips.list).toHaveBeenCalledTimes(1);
  });

  it("renders photo cards with the fallback cover art", async () => {
    renderTrips();
    await screen.findByText("Mary & Winter Wedding");
    const card = screen.getByRole("link", { name: /Mary & Winter Wedding/ });
    expect(card.querySelector("svg.cover-fallback")).not.toBeNull();
    expect(card.querySelector("img")).toBeNull();
  });

  it("fetches each trip's bookings and renders the day teaser with chips", async () => {
    const api = makeApi();
    api.trips.bookings = vi.fn(async () => [BOOKING]);
    renderTrips(api);
    await screen.findByText("Mary & Winter Wedding");
    expect(api.trips.bookings).toHaveBeenCalledWith("t1");
    // 15:00Z is 9:00 AM Fri Oct 9 in Boise — the teaser's day gutter.
    expect(await screen.findByText("Fri 9")).toBeInTheDocument();
    expect(screen.getByText("DL 2214 BOI → STS")).toBeInTheDocument();
    // People were fetched, so the traveler on the booking gets a chip.
    expect(screen.getByTitle("Badger")).toBeInTheDocument();
  });

  it("still renders cards when a bookings fetch fails", async () => {
    const api = makeApi();
    api.trips.bookings = vi.fn(async () => {
      throw new Error("500");
    });
    renderTrips(api);
    expect(await screen.findByText("Mary & Winter Wedding")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows pending imports on the trips screen", async () => {
    const api = makeApi();
    api.imports.pending.mockResolvedValueOnce([{
      id: "draft-1",
      inboundEmailId: "email-1",
      title: "Silverwood RV Park Reservation",
      kind: "other" as const,
      location: null,
      startsAt: "2026-07-29T13:00:00.000Z",
      startsAtTz: "America/Boise",
      endsAt: "2026-07-30T10:00:00.000Z",
      endsAtTz: "America/Boise",
      confirmationNumber: null,
      extractionSource: "ai" as const,
      localStartsOn: "2026-07-29",
      localEndsOn: "2026-07-30",
      source: {
        from: "sol@example.com",
        subject: "Fwd: Your Silverwood RV Park Reservation",
        receivedAt: "2026-07-27T19:28:40.411Z",
      },
      suggestedTrip: null,
    }] as never);
    renderTrips(api);

    expect(await screen.findByTestId("pending-import-card")).toHaveTextContent(
      "Silverwood RV Park Reservation",
    );
  });

  it("offers an empty state rather than a blank page", async () => {
    renderTrips(makeApi([]));
    expect(await screen.findByText(/no trips yet/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than spinning forever", async () => {
    const api = makeApi();
    api.trips.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderTrips(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it("creates a trip and attaches the selected travellers", async () => {
    const api = renderTrips();
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.type(screen.getByLabelText("Title"), "Kauai");
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));

    expect(api.trips.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Kauai" }),
    );
    // The trip and its roster are two calls; the second is what makes the
    // day view able to filter by person at all.
    expect(api.trips.addTraveler).toHaveBeenCalledWith("t2", "p1");
    expect(api.trips.addTraveler).not.toHaveBeenCalledWith("t2", "p2");
    expect(await screen.findByText("Kauai")).toBeInTheDocument();
  });

  it("refuses to submit a trip with no title", async () => {
    const api = renderTrips();
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));
    expect(api.trips.create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/title/i);
  });

  it("keeps the dialog open and reports a rejected create", async () => {
    const api = makeApi();
    api.trips.create = vi.fn(async () => {
      throw new Error("403");
    });
    renderTrips(api);
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.type(screen.getByLabelText("Title"), "Kauai");
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("still shows the trip when attaching a traveller fails", async () => {
    // The trip exists at this point -- the POST succeeded. Hiding it because
    // a follow-up PUT failed would leave a real trip invisible until reload
    // and invite the operator to create it twice.
    const api = makeApi();
    api.trips.addTraveler = vi.fn(async () => {
      throw new Error("500");
    });
    renderTrips(api);
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.type(screen.getByLabelText("Title"), "Kauai");
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));
    expect(await screen.findByText("Kauai")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/travellers/i);
  });
});
