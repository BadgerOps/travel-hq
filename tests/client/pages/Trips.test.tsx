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
};

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function makeApi(trips = [TRIP]) {
  return {
    trips: {
      list: vi.fn(async () => trips),
      create: vi.fn(async () => ({ ...TRIP, id: "t2", title: "Kauai" })),
      addTraveler: vi.fn(async () => undefined),
    },
    people: { list: vi.fn(async () => PEOPLE) },
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
    renderTrips();
    expect(await screen.findByText("Mary & Winter Wedding")).toBeInTheDocument();
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
