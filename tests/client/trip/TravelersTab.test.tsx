import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * `ensureMe()` links a pre-seeded row or answers with nothing; it stopped
 * creating one. An account invited to a single shared trip has no person row
 * at all, so "Add myself" has to have an answer for that.
 */
describe("TravelersTab — add myself with no profile", () => {
  function renderAddable(ensureMe: () => Promise<unknown>) {
    const onAdded = vi.fn();
    const tripApi = {
      people: { reveal: vi.fn(async () => ({ value: "X" })), ensureMe: vi.fn(ensureMe) },
      trips: { addTraveler: vi.fn(async () => undefined) },
    };
    render(
      <TravelersTab
        people={[] as never}
        arrivalOn={null}
        today="2026-07-21"
        api={tripApi as never}
        tripId="t1"
        onAdded={onAdded}
      />,
    );
    return { api: tripApi, onAdded };
  }

  it("says why, and adds nobody, when the account has no person row", async () => {
    const { api: tripApi, onAdded } = renderAddable(async () => undefined);
    await userEvent.click(screen.getByRole("button", { name: /add myself/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not on this household's list/i);
    // Emphatically not "add the first person we can find": the wrong traveller
    // on a trip is worse than no traveller.
    expect(tripApi.trips.addTraveler).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("still adds the linked row when there is one", async () => {
    const { api: tripApi, onAdded } = renderAddable(async () => person({ id: "p9" }));
    await userEvent.click(screen.getByRole("button", { name: /add myself/i }));
    expect(tripApi.trips.addTraveler).toHaveBeenCalledWith("t1", "p9");
    expect(onAdded).toHaveBeenCalled();
  });
});
