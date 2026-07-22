import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Home } from "../../../src/client/pages/Home.js";
import { ApiError } from "../../../src/client/api/client.js";

const TRIP_ACTIVE = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "active" as const,
  notes: null,
};

const TRIP_FUTURE = { ...TRIP_ACTIVE, startsOn: "2027-01-01", endsOn: "2027-01-05" };

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    tripId: "t1",
    kind: "flight",
    title: "DL1422 BOI → ATL",
    location: null,
    startsAt: "2026-10-09T15:00:00Z",
    startsAtTz: "America/Boise",
    endsAt: "2026-10-09T21:15:00Z",
    endsAtTz: "America/New_York",
    confirmationNumberMasked: "••••X4T2",
    costCents: 42000,
    pointsUsed: null,
    pointsProgram: null,
    status: "booked" as const,
    details: {},
    personIds: ["p-badger"],
    ...over,
  };
}

const BOOKING = booking();
const PEOPLE = [{ id: "p-badger", displayName: "Badger" }];

/**
 * `days` is what GET /api/trips/:id/itinerary returns: bookings already
 * grouped into calendar days in each booking's own timezone, by the server.
 */
function renderHome(
  trips: unknown[],
  days: unknown[],
  today: string,
  now = new Date(`${today}T12:00:00Z`),
  overrides: Record<string, unknown> = {},
) {
  const api = {
    me: vi.fn(async () => {
      throw new Error("not used");
    }),
    trips: {
      list: vi.fn(async () => trips),
      bookings: vi.fn(async () => days.flatMap((d) => (d as { bookings: unknown[] }).bookings)),
      itinerary: vi.fn(async () => days),
      revealConfirmation: vi.fn(async () => ({ value: "ABCDX4T2" })),
    },
    people: { list: vi.fn(async () => PEOPLE), reveal: vi.fn() },
    // Home now renders NextBestActions, which calls this on mount. Plan 3
    // made the identical addition to its own fixtures when ChecklistTab was
    // built; this is the one edit task 8 makes to an earlier plan's test file.
    checklist: { list: vi.fn(async () => []), setDone: vi.fn() },
    ...overrides,
  };
  const { hook } = memoryLocation({ path: "/" });
  return render(
    <Router hook={hook}>
      <Home api={api as never} today={today} now={now} />
    </Router>,
  );
}

describe("Home", () => {
  it("shows the active hero when a trip covers today", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    expect(await screen.findByText(/NEXT UP · IN 40 MIN/i)).toBeInTheDocument();
    expect(screen.getByText("DL1422 BOI → ATL")).toBeInTheDocument();
  });

  it("never shows a departed booking as next up", async () => {
    // Mid-trip: one booking this morning that has already happened, one
    // tonight that has not. Sorting the whole trip and taking [0] picks the
    // wrong one and labels it "NOW".
    const past = booking({ id: "b-past", title: "Breakfast at the inn", startsAt: "2026-10-10T14:00:00Z" });
    const next = booking({ id: "b-next", title: "Rehearsal dinner", startsAt: "2026-10-10T23:00:00Z" });
    renderHome(
      [TRIP_ACTIVE],
      [{ date: "2026-10-10", bookings: [past, next] }],
      "2026-10-10",
      new Date("2026-10-10T18:00:00Z"),
    );

    expect(await screen.findByText("Rehearsal dinner")).toBeInTheDocument();
    expect(screen.queryByText("Breakfast at the inn")).not.toBeInTheDocument();
    expect(screen.queryByText(/NOW/)).not.toBeInTheDocument();
  });

  it("shows the idle hero when no trip covers today", async () => {
    renderHome([TRIP_FUTURE], [], "2026-07-20");
    expect(await screen.findByText(/Next trip/i)).toBeInTheDocument();
    expect(screen.queryByText(/NEXT UP/i)).not.toBeInTheDocument();
  });

  it("masks the confirmation number in the hero", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    expect(await screen.findByText("••••X4T2")).toBeInTheDocument();
  });

  it("renders an empty state when there are no trips", async () => {
    renderHome([], [], "2026-07-20");
    expect(await screen.findByText(/No trips yet/i)).toBeInTheDocument();
  });

  it("greets the user", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09");
    expect(await screen.findByText(/Good (morning|afternoon|evening)/)).toBeInTheDocument();
  });

  it("reports an expired session rather than a raw error string", async () => {
    renderHome([], [], "2026-07-20", undefined, {
      trips: {
        list: vi.fn(async () => {
          throw new ApiError("/api/trips failed: Unauthorized", 401);
        }),
        bookings: vi.fn(),
        itinerary: vi.fn(),
        revealConfirmation: vi.fn(),
      },
    });
    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/ApiError/)).not.toBeInTheDocument();
  });
});
