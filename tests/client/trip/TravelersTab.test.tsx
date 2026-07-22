import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TravelersTab } from "../../../src/client/trip/TravelersTab.js";

function person(over: Record<string, unknown> = {}) {
  return {
    id: "p1", displayName: "Badger", dob: null, notes: null,
    passportExpiry: "2027-01-15", passportCountry: "US",
    passportNumberMasked: "••••1234",
    knownTravelerNumberMasked: null, redressNumberMasked: null,
    ...over,
  };
}

const api = { people: { reveal: vi.fn(async () => ({ value: "X" })) } };

function renderTab(people: unknown[], arrivalOn: string | null) {
  return render(
    <TravelersTab
      people={people as never}
      arrivalOn={arrivalOn}
      today="2026-07-21"
      api={api as never}
    />,
  );
}

describe("TravelersTab", () => {
  it("does not warn about a passport with six months' validity at arrival", () => {
    // Arrival 2026-10-09, expiry 2027-06-01 — comfortably clear. Measuring
    // from *today* against the old 190-day threshold would have warned here.
    renderTab([person({ passportExpiry: "2027-06-01" })], "2026-10-09");
    expect(screen.queryByText(/under six months/i)).not.toBeInTheDocument();
  });

  it("warns when validity runs short measured from arrival, not from today", () => {
    // Expiry 2027-01-15 is ~178 days after the 2026-10-09 arrival: short.
    renderTab([person()], "2026-10-09");
    expect(screen.getByText(/under six months' validity at arrival/i)).toBeInTheDocument();
  });

  it("distinguishes an already-expired passport from one expiring soon", () => {
    renderTab([person({ passportExpiry: "2026-01-01" })], "2026-10-09");
    expect(screen.getByText(/expired 2026-01-01/)).toBeInTheDocument();
    expect(screen.queryByText(/under six months/i)).not.toBeInTheDocument();
  });

  it("falls back to today when the trip has no dates", () => {
    renderTab([person({ passportExpiry: "2026-08-01" })], null);
    expect(screen.getByText(/under six months' validity at arrival/i)).toBeInTheDocument();
  });
});
