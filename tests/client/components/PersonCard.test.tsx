import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonCard } from "../../../src/client/components/PersonCard.js";

function person(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    displayName: "Badger",
    dob: null,
    notes: null,
    passportExpiry: "2027-06-01",
    passportCountry: "US",
    passportNumberMasked: "••••1234",
    knownTravelerNumberMasked: null,
    redressNumberMasked: null,
    ...over,
  };
}

const api = { people: { reveal: vi.fn(async () => ({ value: "C03X71234" })) } };

function renderCard(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return render(
    <PersonCard
      person={person(over) as never}
      arrivalOn="2026-10-09"
      today="2026-07-21"
      api={api as never}
      {...props}
    />,
  );
}

describe("PersonCard", () => {
  it("renders the name and the masked passport", () => {
    renderCard();
    expect(screen.getByText("Badger")).toBeInTheDocument();
    expect(screen.getByText("••••1234")).toBeInTheDocument();
  });

  it("never renders a plaintext document number before a reveal", () => {
    const { container } = renderCard();
    expect(container.textContent).not.toContain("C03X71234");
  });

  it("shows a warning row for a passport short of validity at arrival", () => {
    renderCard({ passportExpiry: "2027-01-15" });
    expect(screen.getByText(/under six months' validity at arrival/i)).toBeInTheDocument();
  });

  it("shows no warning row for a comfortable passport", () => {
    renderCard();
    expect(screen.queryByText(/under six months/i)).not.toBeInTheDocument();
  });

  it("says so when there is no passport on file at all", () => {
    renderCard({ passportExpiry: null, passportNumberMasked: null });
    expect(screen.getByText(/no passport on file/i)).toBeInTheDocument();
  });

  it("omits an unset optional document rather than rendering a blank row", () => {
    renderCard();
    expect(screen.queryByText(/Known Traveler/i)).not.toBeInTheDocument();
  });

  it("renders a Known Traveler row when one is stored", () => {
    renderCard({ knownTravelerNumberMasked: "••••4567" });
    expect(screen.getByText(/Known Traveler/i)).toBeInTheDocument();
    expect(screen.getByText("••••4567")).toBeInTheDocument();
  });

  it("offers no edit control unless a handler is supplied", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("calls onEdit with the person when the edit control is used", async () => {
    const onEdit = vi.fn();
    renderCard({}, { onEdit });
    await userEvent.click(screen.getByRole("button", { name: /edit badger/i }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });
});
