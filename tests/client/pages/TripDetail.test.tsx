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
      get: vi.fn(async () => TRIP),
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

function dayBooking(id: string, title: string, startsAt: string) {
  return {
    id, tripId: "t1", kind: "other" as const, title, location: null,
    startsAt, startsAtTz: "America/Los_Angeles", endsAt: null, endsAtTz: null,
    confirmationNumberMasked: null, costCents: null, pointsUsed: null,
    pointsProgram: null, status: "booked" as const, details: {}, personIds: ["p1"],
  };
}

// One booking per trip day, each with a title that appears nowhere else, so a
// test can say which day the day view actually landed on. `today` above is
// months before this trip, so DayView's own first-load rule picks Oct 9 —
// which is exactly what a deep-linked date has to be able to override.
const ITINERARY = [
  { date: "2026-10-09", bookings: [dayBooking("b1", "Welcome dinner", "2026-10-09T02:00:00Z")] },
  { date: "2026-10-10", bookings: [dayBooking("b2", "Ceremony", "2026-10-10T22:00:00Z")] },
  { date: "2026-10-11", bookings: [dayBooking("b3", "Farewell brunch", "2026-10-11T17:00:00Z")] },
];

function makeItineraryApi() {
  const api = makeApi();
  api.trips.itinerary = vi.fn(async () => ITINERARY) as never;
  return api;
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

  it("fetches the cost rollup once and reuses it for the Costs tab", async () => {
    // Overview's rail renders the 1b "Trip cost" card, so the rollup loads
    // with the initial tab — but opening Costs must not fetch it again.
    const api = makeApi();
    renderDetail(api);
    await screen.findByText("Mary & Winter Wedding");
    await vi.waitFor(() => expect(api.trips.rollup).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("radio", { name: "Costs" }));
    expect(await screen.findByText("Total trip cost")).toBeInTheDocument();
    expect(api.trips.rollup).toHaveBeenCalledTimes(1);
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

  it("opens the day view on the date named in the hash", async () => {
    window.history.replaceState(null, "", "/trips/t1#days:2026-10-11");
    renderDetail(makeItineraryApi());
    expect(await screen.findByText("Farewell brunch")).toBeInTheDocument();
    expect(screen.queryByText("Welcome dinner")).not.toBeInTheDocument();
  });

  // Issue #60: this is the whole bug. The row knew its date, the hash had
  // nowhere to put it, and the day view picked Oct 9 for itself every time.
  it("lands the day view on the day clicked in Overview's strip", async () => {
    renderDetail(makeItineraryApi());
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Open Sunday, October 11 in the day-by-day view",
      }),
    );
    expect(screen.getByRole("radio", { name: "Day by day" })).toBeChecked();
    expect(await screen.findByText("Farewell brunch")).toBeInTheDocument();
    // In the hash, so the day survives a reload and can be sent to someone.
    expect(window.location.hash).toBe("#days:2026-10-11");
  });

  it("pages within the day view without burying Overview under history entries", async () => {
    // Paging replaces the current entry rather than pushing one, so Back out
    // of the day view still means "return to Overview" instead of walking
    // back through every day the viewer flipped past.
    renderDetail(makeItineraryApi());
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Open Friday, October 9 in the day-by-day view",
      }),
    );
    await screen.findByText("Welcome dinner");
    const entries = window.history.length;
    await userEvent.click(screen.getByRole("button", { name: /next day/i }));
    await userEvent.click(screen.getByRole("button", { name: /next day/i }));
    expect(await screen.findByText("Farewell brunch")).toBeInTheDocument();
    expect(window.location.hash).toBe("#days:2026-10-11");
    expect(window.history.length).toBe(entries);
  });

  it("keeps a bare #days on the day view's own choice of day", async () => {
    // The dashboard's "Open day view" button has linked to `#days` since long
    // before dates joined the hash, and must keep meaning "you decide".
    window.history.replaceState(null, "", "/trips/t1#days");
    renderDetail(makeItineraryApi());
    expect(await screen.findByText("Welcome dinner")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Day by day" })).toBeChecked();
  });

  it.each(["#days:", "#days:garbage", "#days:2026-13-45", "#days:2026-02-30"])(
    "degrades %s to the day view's own choice instead of breaking",
    async (hash) => {
      window.history.replaceState(null, "", `/trips/t1${hash}`);
      renderDetail(makeItineraryApi());
      expect(await screen.findByText("Welcome dinner")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Day by day" })).toBeChecked();
    },
  );

  it("leaves the other tabs' hashes alone", async () => {
    window.history.replaceState(null, "", "/trips/t1#checklist:2026-10-11");
    renderDetail(makeItineraryApi());
    // A date means nothing outside the day view; the suffix is ignored rather
    // than disqualifying the tab.
    expect(await screen.findByRole("radio", { name: "Checklist" })).toBeChecked();
  });

  it("reports a missing trip rather than rendering blank", async () => {
    const api = makeApi();
    api.trips.get = vi.fn(async () => {
      throw new Error("404 Not found");
    });
    renderDetail(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(/deleted|wrong/i);
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
