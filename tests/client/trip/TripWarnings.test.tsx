import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TripWarnings } from "../../../src/client/trip/TripWarnings.js";

function person(id: string, name: string, expiry: string | null) {
  return { id, displayName: name, passportExpiry: expiry };
}

function renderWarnings(people: unknown[], arrivalOn: string | null = "2026-10-09") {
  return render(
    <TripWarnings people={people as never} arrivalOn={arrivalOn} today="2026-07-21" />,
  );
}

describe("TripWarnings", () => {
  it("renders nothing when every passport is comfortable", () => {
    const { container } = renderWarnings([person("p1", "Badger", "2028-01-01")]);
    expect(container).toBeEmptyDOMElement();
  });

  it("warns about a passport short of validity at arrival", () => {
    renderWarnings([person("p1", "Finn", "2027-01-15")]);
    expect(screen.getByRole("status")).toHaveTextContent(/Finn/);
    expect(screen.getByRole("status")).toHaveTextContent(/under six months/i);
  });

  it("lists every affected traveller, not just the first", () => {
    renderWarnings([
      person("p1", "Finn", "2027-01-15"),
      person("p2", "Maya", "2026-01-01"),
      person("p3", "Badger", "2028-01-01"),
    ]);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/Finn/);
    expect(banner).toHaveTextContent(/Maya/);
    expect(banner).not.toHaveTextContent(/Badger/);
  });

  it("renders nothing for a trip with no travellers", () => {
    const { container } = renderWarnings([]);
    expect(container).toBeEmptyDOMElement();
  });
});
