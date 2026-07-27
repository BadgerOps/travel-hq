import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { People } from "../../../src/client/pages/People.js";

const BADGER = {
  id: "p1",
  displayName: "Badger",
  dob: null,
  email: "badger@example.com",
  phone: "+1 208 555 0100",
  notes: null,
  passportExpiry: "2028-01-01",
  passportCountry: "US",
  passportNumberMasked: "••••1234",
  knownTravelerNumberMasked: null,
  redressNumberMasked: null,
};

function makeApi(people = [BADGER]) {
  return {
    people: {
      list: vi.fn(async () => people),
      reveal: vi.fn(async () => ({ value: "X" })),
      create: vi.fn(async () => ({ ...BADGER, id: "p2", displayName: "Ava" })),
      update: vi.fn(async () => ({ ...BADGER, displayName: "Badger Wright" })),
    },
  };
}

function renderPeople(api = makeApi()) {
  render(<People api={api as never} today="2026-07-21" />);
  return api;
}

describe("People", () => {
  it("renders a card per family member", async () => {
    renderPeople();
    expect(await screen.findByText("Badger")).toBeInTheDocument();
    expect(screen.getByText("••••1234")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "badger@example.com" }))
      .toHaveAttribute("href", "mailto:badger@example.com");
    expect(screen.getByRole("link", { name: "+1 208 555 0100" }))
      .toHaveAttribute("href", "tel:+1 208 555 0100");
  });

  it("offers a first-run empty state rather than a blank page", async () => {
    renderPeople(makeApi([]));
    expect(await screen.findByText(/no one here yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add the first family member/i }),
    ).toBeInTheDocument();
  });

  it("reports a failed load rather than looking like an empty household", async () => {
    // "Nobody has been entered" and "we could not find out" must not render
    // identically -- the first invites you to add people, the second is a
    // fault. Without a catch this page also sits on "Loading…" forever and
    // logs an unhandled rejection.
    const api = makeApi();
    api.people.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderPeople(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no one here yet/i)).not.toBeInTheDocument();
  });

  it("opens the add dialog from the header control", async () => {
    renderPeople();
    await userEvent.click(await screen.findByRole("button", { name: /add person/i }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add person");
  });

  it("opens the add dialog from the empty state", async () => {
    renderPeople(makeApi([]));
    await userEvent.click(
      await screen.findByRole("button", { name: /add the first family member/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a newly created person without a reload", async () => {
    const api = renderPeople();
    await userEvent.click(await screen.findByRole("button", { name: /add person/i }));
    await userEvent.type(screen.getByLabelText("Name"), "Ava");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Ava")).toBeInTheDocument();
    expect(api.people.create).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the edit dialog from a card and replaces the person on save", async () => {
    renderPeople();
    await userEvent.click(await screen.findByRole("button", { name: /edit badger/i }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Edit Badger/);
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Badger Wright");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Badger Wright")).toBeInTheDocument();
  });
});
