import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PersonDetailFields,
  PersonDocumentFields,
  usePersonFields,
} from "../../../src/client/components/PersonFields.js";
import type { Person } from "../../../src/client/api/types.js";

const AVA: Person = {
  id: "p1",
  displayName: "Ava",
  dob: "2008-04-02",
  email: "ava@example.com",
  phone: null,
  notes: "allergic to shellfish",
  passportExpiry: "2027-01-15",
  passportCountry: "US",
  passportNumberMasked: "••••2119",
  knownTravelerNumberMasked: null,
  redressNumberMasked: null,
};

/** One instance, rendering both groups under a caller-chosen id prefix. */
function Fields({ idPrefix, person }: { idPrefix: string; person?: Person }) {
  const fields = usePersonFields(person);
  return (
    <>
      <PersonDetailFields idPrefix={idPrefix} fields={fields} />
      <PersonDocumentFields idPrefix={idPrefix} fields={fields} person={person} />
    </>
  );
}

describe("PersonFields", () => {
  /**
   * The reason the extraction happened at all. `PersonForm` hard-coded `pf-*`
   * ids, which is fine inside a dialog that exists once and wrong the moment
   * the same fields land on a page beside another copy — every `<label for>`
   * would then point at whichever input rendered first.
   */
  it("keeps two instances on one page from colliding their element ids", async () => {
    render(
      <form>
        <Fields idPrefix="a" />
        <Fields idPrefix="b" />
      </form>,
    );
    const [first, second] = screen.getAllByLabelText("Name");
    expect(first.id).toBe("a-name");
    expect(second.id).toBe("b-name");

    // The load-bearing consequence: typing into one does not land in the other.
    await userEvent.type(first, "Ava");
    expect(first).toHaveValue("Ava");
    expect(second).toHaveValue("");
  });

  it("seeds the plain fields from the person and leaves the documents empty", () => {
    render(<Fields idPrefix="x" person={AVA} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Ava");
    expect(screen.getByLabelText(/passport country/i)).toHaveValue("US");
    // The masked value is visible as text, and is NOT the input's value.
    expect(screen.getByText("••••2119")).toBeInTheDocument();
    expect(screen.getByLabelText(/^passport number/i)).toHaveValue("");
  });

  /**
   * The roster dialog passes no `onReveal`, so nothing on it offers to unmask
   * a stored number — that already belongs to PersonCard, and a form whose job
   * is replacing a number should not also be where you read the old one back.
   */
  it("offers no reveal affordance unless a caller supplies one", () => {
    render(<Fields idPrefix="x" person={AVA} />);
    expect(screen.queryByRole("button", { name: /reveal/i })).toBeNull();
  });

  it("offers Clear only for a document that has something stored", () => {
    render(<Fields idPrefix="x" person={AVA} />);
    expect(
      screen.getByRole("button", { name: /clear stored passport number/i }),
    ).toBeInTheDocument();
    // No Known Traveler number on file: nothing to clear.
    expect(screen.queryByRole("button", { name: /clear stored known traveler/i })).toBeNull();
  });
});
