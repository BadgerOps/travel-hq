import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
  photoUrl: null,
};

// `planning`, not the vestigial `active` this fixture used to carry: stored
// `active` now forces the active state regardless of dates (resolveTripState),
// and the idle-hero case below is specifically about a trip whose DATES are in
// the future with nobody having forced anything.
const TRIP_FUTURE = {
  ...TRIP_ACTIVE,
  startsOn: "2027-01-01",
  endsOn: "2027-01-05",
  status: "planning" as const,
};

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
    imports: {
      pending: vi.fn(async () => []),
      createTrip: vi.fn(),
    },
    ...overrides,
  };
  const { hook } = memoryLocation({ path: "/" });
  const rendered = render(
    <Router hook={hook}>
      <Home api={api as never} today={today} now={now} />
    </Router>,
  );
  return { ...rendered, api };
}

describe("Home", () => {
  it("shows the active hero when a trip covers today", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    const kicker = await screen.findByText(/NEXT UP · IN 40 MIN/i);
    // Scoped to the hero: the trip card's day teaser repeats booking titles.
    const hero = kicker.closest(".hero-active") as HTMLElement;
    expect(within(hero).getByText("DL1422 BOI → ATL")).toBeInTheDocument();
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

    // Scoped to the hero: the card teaser below legitimately lists the whole
    // day, departed bookings included — the hero must not.
    const kicker = await screen.findByText(/Next up/i);
    const hero = kicker.closest(".hero-active") as HTMLElement;
    expect(within(hero).getByText("Rehearsal dinner")).toBeInTheDocument();
    expect(within(hero).queryByText("Breakfast at the inn")).not.toBeInTheDocument();
    expect(within(hero).queryByText(/NOW/i)).not.toBeInTheDocument();
  });

  it("shows the idle hero when no trip covers today", async () => {
    const { api } = renderHome([TRIP_FUTURE], [], "2026-07-20");
    expect(await screen.findByText(/Next trip/i)).toBeInTheDocument();
    expect(screen.queryByText(/NEXT UP/i)).not.toBeInTheDocument();
    expect(api.trips.list).toHaveBeenCalledTimes(1);
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

  it("writes the date long-form in the subline, never raw ISO", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    expect(await screen.findByText(/Friday, October 9 · travel day/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-10-09/)).not.toBeInTheDocument();
  });

  it("tags the header with the hero trip's countdown", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    expect(await screen.findByText("Mary & Winter Wedding · today")).toBeInTheDocument();
  });

  it("offers day-view and trip-details buttons from the active hero", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"));
    const dayView = await screen.findByRole("link", { name: /open day view/i });
    // "#days" is TripDetail's hash id for the Day-by-day tab.
    expect(dayView).toHaveAttribute("href", "/trips/t1#days");
    expect(screen.getByRole("link", { name: /trip details/i })).toHaveAttribute(
      "href",
      "/trips/t1",
    );
  });

  it("counts the rest of today in the hero kicker row", async () => {
    const later = booking({ id: "b-later", title: "Hertz pickup · STS", startsAt: "2026-10-09T20:00:00Z" });
    renderHome(
      [TRIP_ACTIVE],
      [{ date: "2026-10-09", bookings: [BOOKING, later] }],
      "2026-10-09",
      new Date("2026-10-09T14:20:00Z"),
    );
    expect(await screen.findByText("then 1 more today")).toBeInTheDocument();
  });

  it("fetches bookings for every visible trip so each card can tease its days", async () => {
    const { api } = renderHome(
      [TRIP_ACTIVE, { ...TRIP_FUTURE, id: "t2", title: "Spring Break — Kauai" }],
      [{ date: "2026-10-09", bookings: [BOOKING] }],
      "2026-10-09",
      new Date("2026-10-09T14:20:00Z"),
    );
    await screen.findByText(/NEXT UP/i);
    await vi.waitFor(() => {
      expect(api.trips.bookings).toHaveBeenCalledWith("t1");
      expect(api.trips.bookings).toHaveBeenCalledWith("t2");
    });
  });

  it("still renders trip cards when a per-trip bookings fetch fails", async () => {
    renderHome([TRIP_ACTIVE], [{ date: "2026-10-09", bookings: [BOOKING] }], "2026-10-09", new Date("2026-10-09T14:20:00Z"), {
      trips: {
        list: vi.fn(async () => [TRIP_ACTIVE]),
        bookings: vi.fn(async () => {
          throw new Error("500");
        }),
        itinerary: vi.fn(async () => [{ date: "2026-10-09", bookings: [BOOKING] }]),
        revealConfirmation: vi.fn(async () => ({ value: "ABCDX4T2" })),
      },
    });
    // The hero still works from the itinerary; the card degrades to no teaser.
    expect(await screen.findByText(/NEXT UP/i)).toBeInTheDocument();
    expect(screen.getByText("Mary & Winter Wedding")).toBeInTheDocument();
  });

  it("shows pending imports on the home screen", async () => {
    renderHome([TRIP_FUTURE], [], "2026-07-20", undefined, {
      imports: {
        pending: vi.fn(async () => [{
          id: "draft-1",
          inboundEmailId: "email-1",
          title: "Silverwood RV Park Reservation",
          kind: "other",
          location: null,
          startsAt: "2026-07-29T13:00:00.000Z",
          startsAtTz: "America/Boise",
          endsAt: "2026-07-30T10:00:00.000Z",
          endsAtTz: "America/Boise",
          confirmationNumber: null,
          extractionSource: "ai",
          localStartsOn: "2026-07-29",
          localEndsOn: "2026-07-30",
          source: {
            from: "sol@example.com",
            subject: "Fwd: Your Silverwood RV Park Reservation",
            receivedAt: "2026-07-27T19:28:40.411Z",
          },
          suggestedTrip: null,
        }]),
        createTrip: vi.fn(),
      },
    });

    expect(await screen.findByTestId("pending-import-card")).toHaveTextContent(
      "Silverwood RV Park Reservation",
    );
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
