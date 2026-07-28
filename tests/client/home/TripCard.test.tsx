import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TripCard } from "../../../src/client/home/TripCard.js";

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
  { id: "p-badger", displayName: "Badger" },
  { id: "p-ava", displayName: "Ava" },
];

function booking(id: string, status: "planned" | "booked", over: Record<string, unknown> = {}) {
  return {
    id,
    tripId: "t1",
    kind: "flight",
    title: `Booking ${id}`,
    location: null,
    startsAt: "2026-10-09T15:00:00Z",
    startsAtTz: "America/Boise",
    endsAt: null,
    endsAtTz: null,
    confirmationNumberMasked: null,
    costCents: null,
    pointsUsed: null,
    pointsProgram: null,
    status,
    details: {},
    personIds: ["p-badger"],
    ...over,
  };
}

function renderCard(bookings: unknown[], trip: Record<string, unknown> = TRIP) {
  const { hook } = memoryLocation({ path: "/" });
  return render(
    <Router hook={hook}>
      <TripCard
        trip={trip as never}
        bookings={bookings as never}
        people={PEOPLE}
        today="2026-07-20"
      />
    </Router>,
  );
}

describe("TripCard", () => {
  it("renders the title, destination, and countdown", () => {
    renderCard([]);
    expect(screen.getByText("Mary & Winter Wedding")).toBeInTheDocument();
    expect(screen.getByText("Guerneville, CA")).toBeInTheDocument();
    expect(screen.getByText("In 81 days")).toBeInTheDocument();
  });

  it("shows a human date range, never raw ISO", () => {
    renderCard([]);
    expect(screen.getByText("Oct 9–11")).toBeInTheDocument();
    expect(screen.queryByText(/2026-10-09/)).not.toBeInTheDocument();
  });

  it("counts booked versus remaining", () => {
    renderCard([booking("b1", "booked"), booking("b2", "planned")]);
    expect(screen.getByText(/1 booked · 1 to go/)).toBeInTheDocument();
  });

  // The original "renders no photo header" decision is superseded by the
  // 2026-07-27 redesign spec: every trip card carries a 150px cover, either
  // the trip's photo or the deterministic fallback art.
  it("renders the fallback cover art when the trip has no photo", () => {
    const { container } = renderCard([]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.cover-fallback")).not.toBeNull();
  });

  it("renders the photo when the trip has one", () => {
    const { container } = renderCard([], {
      ...TRIP,
      photoUrl: "https://photos.example/guerneville.jpg",
    });
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "https://photos.example/guerneville.jpg");
    expect(container.querySelector("svg.cover-fallback")).toBeNull();
  });

  it("shows a day-by-day teaser with unbooked items in warning amber", () => {
    renderCard([
      booking("b1", "booked"),
      booking("b2", "planned", { startsAt: "2026-10-10T17:00:00Z" }),
    ]);
    // Two local days in America/Boise: Fri Oct 9 and Sat Oct 10.
    expect(screen.getByText("Fri 9")).toBeInTheDocument();
    expect(screen.getByText("Sat 10")).toBeInTheDocument();
    expect(screen.getByText("Booking b1")).not.toHaveClass("warning");
    expect(screen.getByText("Booking b2")).toHaveClass("warning");
  });

  it("caps the teaser at the first three days", () => {
    renderCard([
      booking("b1", "booked"),
      booking("b2", "booked", { startsAt: "2026-10-10T17:00:00Z" }),
      booking("b3", "booked", { startsAt: "2026-10-11T17:00:00Z" }),
      booking("b4", "booked", { startsAt: "2026-10-12T17:00:00Z" }),
    ]);
    expect(screen.getByText("Sun 11")).toBeInTheDocument();
    expect(screen.queryByText("Mon 12")).not.toBeInTheDocument();
  });

  it("shows traveler chips for the people on this trip's bookings", () => {
    renderCard([booking("b1", "booked")]);
    expect(screen.getByTitle("Badger")).toBeInTheDocument();
    expect(screen.queryByTitle("Ava")).not.toBeInTheDocument();
  });

  it("shows a status line instead of a teaser for an unbooked plan", () => {
    renderCard([]);
    expect(screen.getByText(/0 booked · dates penciled in/)).toBeInTheDocument();
  });

  it("does not nag a finished trip about having nothing booked", () => {
    renderCard([], { ...TRIP, status: "complete" });
    expect(screen.queryByText(/0 booked/)).not.toBeInTheDocument();
  });

  it("links to the trip detail route", () => {
    renderCard([]);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/trips/t1");
  });
});
