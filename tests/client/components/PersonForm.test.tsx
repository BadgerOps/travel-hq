import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonForm } from "../../../src/client/components/PersonForm.js";
import type { CreatePersonInput, UpdatePersonInput } from "../../../src/client/api/types.js";

const AVA = {
  id: "p1",
  displayName: "Ava",
  dob: "2018-04-02",
  email: "ava@example.com",
  phone: "+1 208 555 0123",
  notes: null,
  passportExpiry: "2027-01-15",
  passportCountry: "US",
  passportNumberMasked: "••••2119",
  knownTravelerNumberMasked: null,
  redressNumberMasked: null,
};

function makeApi() {
  return {
    people: {
      create: vi.fn(async (_input: CreatePersonInput) => ({ ...AVA, id: "p-new" })),
      update: vi.fn(async (_id: string, _input: UpdatePersonInput) => AVA),
    },
  };
}

function renderForm(person?: unknown, api = makeApi(), onSaved = vi.fn()) {
  render(
    <PersonForm
      person={person as never}
      api={api as never}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );
  return { api, onSaved };
}

describe("PersonForm — create", () => {
  it("sends the typed name and passport number", async () => {
    const { api } = renderForm();
    await userEvent.type(screen.getByLabelText("Name"), "Ava");
    await userEvent.type(screen.getByLabelText(/Passport number/), "C03X72119");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.people.create).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ava", passportNumber: "C03X72119" }),
    );
  });

  it("sends optional email and phone fields", async () => {
    const { api } = renderForm();
    await userEvent.type(screen.getByLabelText("Name"), "Finn");
    await userEvent.type(screen.getByLabelText("Email"), "finn@example.com");
    await userEvent.type(screen.getByLabelText("Phone"), "+1 208 555 0199");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.people.create).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "Finn",
      email: "finn@example.com",
      phone: "+1 208 555 0199",
    }));
  });

  it("omits document fields the operator left blank", async () => {
    const { api } = renderForm();
    await userEvent.type(screen.getByLabelText("Name"), "Finn");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("passportNumber");
    expect(body).not.toHaveProperty("knownTravelerNumber");
  });

  it("refuses to submit without a name", async () => {
    const { api } = renderForm();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.people.create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/name/i);
  });

  it("reports a rejected save instead of closing silently", async () => {
    const api = makeApi();
    api.people.create = vi.fn(async () => {
      throw new Error("403");
    });
    const { onSaved } = renderForm(undefined, api);
    await userEvent.type(screen.getByLabelText("Name"), "Ava");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("PersonForm — edit", () => {
  it("pre-fills the plain fields", () => {
    renderForm(AVA);
    expect(screen.getByLabelText("Name")).toHaveValue("Ava");
    expect(screen.getByLabelText(/Passport expiry/)).toHaveValue("2027-01-15");
    expect(screen.getByLabelText("Email")).toHaveValue("ava@example.com");
    expect(screen.getByLabelText("Phone")).toHaveValue("+1 208 555 0123");
  });

  it("NEVER pre-fills a document input with the masked value", () => {
    // The disaster case. If this input carried "••••2119", saving would
    // encrypt that string over a real passport number, silently, with a 200.
    renderForm(AVA);
    expect(screen.getByLabelText(/Passport number/)).toHaveValue("");
  });

  it("shows the stored masked value read-only, outside the input", () => {
    renderForm(AVA);
    // Visible so the operator knows which passport they are replacing, but
    // it is not the field's value and cannot be submitted.
    expect(screen.getByText("••••2119")).toBeInTheDocument();
  });

  it("omits an untouched document field from the update body entirely", async () => {
    const { api } = renderForm(AVA);
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Ava Wright");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.displayName).toBe("Ava Wright");
    // Absent, not null and not the masked string. `in` rather than a
    // truthiness check, because `null` here would mean "clear it".
    expect("passportNumber" in body).toBe(false);
  });

  it("sends an explicit null when the operator clears a document", async () => {
    const { api } = renderForm(AVA);
    await userEvent.click(screen.getByRole("button", { name: /clear stored passport number/i }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.passportNumber).toBe(null);
  });

  it("sends new plaintext when the operator types a replacement", async () => {
    const { api } = renderForm(AVA);
    await userEvent.type(screen.getByLabelText(/Passport number/), "X99Z00042");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.passportNumber).toBe("X99Z00042");
  });

  it("calls onSaved with the saved person", async () => {
    const { api, onSaved } = renderForm(AVA);
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Ava W");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.people.update).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });
});
