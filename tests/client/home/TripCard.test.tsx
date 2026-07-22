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
};

const PEOPLE = [
  { id: "p-badger", displayName: "Badger" },
  { id: "p-ava", displayName: "Ava" },
];

function booking(id: string, status: "planned" | "booked") {
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
  };
}

function renderCard(bookings: unknown[]) {
  const { hook } = memoryLocation({ path: "/" });
  return render(
    <Router hook={hook}>
      <TripCard
        trip={TRIP}
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

  it("counts booked versus remaining", () => {
    renderCard([booking("b1", "booked"), booking("b2", "planned")]);
    expect(screen.getByText(/1 booked · 1 to go/)).toBeInTheDocument();
  });

  it("renders no photo header", () => {
    const { container } = renderCard([]);
    expect(container.querySelector("img")).toBeNull();
  });

  it("links to the trip detail route", () => {
    renderCard([]);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/trips/t1");
  });
});
