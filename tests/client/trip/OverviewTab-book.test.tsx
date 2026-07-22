import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewTab } from "../../../src/client/trip/OverviewTab.js";

const TRIP = {
  id: "t1", title: "Wedding", destination: "Guerneville, CA",
  startsOn: "2026-10-09", endsOn: "2026-10-11",
  status: "planning" as const, notes: null,
};

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1", tripId: "t1", kind: "lodging", title: "Dawn Ranch Lodge",
    location: null, startsAt: null, startsAtTz: null, endsAt: null, endsAtTz: null,
    confirmationNumberMasked: null, costCents: null,
    pointsUsed: null, pointsProgram: null,
    status: "planned" as const, details: {}, personIds: [],
    ...over,
  };
}

const ZERO = { bookedCents: 0, plannedCents: 0, totalCents: 0, draftCount: 0, points: [] };

function makeApi() {
  return {
    trips: { revealConfirmation: vi.fn() },
    bookings: { setStatus: vi.fn(async () => undefined) },
  };
}

function renderTab(bookings: unknown[], api = makeApi(), onStatusChanged = vi.fn()) {
  render(
    <OverviewTab
      trip={TRIP}
      bookings={bookings as never}
      people={[] as never}
      rollup={ZERO}
      api={api as never}
      onStatusChanged={onStatusChanged}
    />,
  );
  return { api, onStatusChanged };
}

describe("OverviewTab — Book →", () => {
  it("offers Book → on a provisional row", () => {
    renderTab([booking()]);
    expect(screen.getByRole("button", { name: /book dawn ranch lodge/i })).toBeInTheDocument();
  });

  it("offers no Book → on an already-booked row", () => {
    renderTab([booking({ status: "booked" })]);
    expect(screen.queryByRole("button", { name: /^book /i })).not.toBeInTheDocument();
  });

  it("promotes the booking and reports the change", async () => {
    const { api, onStatusChanged } = renderTab([booking()]);
    await userEvent.click(screen.getByRole("button", { name: /book dawn ranch lodge/i }));
    expect(api.bookings.setStatus).toHaveBeenCalledWith("b1", "booked");
    expect(onStatusChanged).toHaveBeenCalled();
  });

  it("reports a rejected promotion rather than silently doing nothing", async () => {
    const api = makeApi();
    api.bookings.setStatus = vi.fn(async () => {
      throw new Error("403");
    });
    const { onStatusChanged } = renderTab([booking()], api);
    await userEvent.click(screen.getByRole("button", { name: /book dawn ranch lodge/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onStatusChanged).not.toHaveBeenCalled();
  });
});
