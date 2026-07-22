import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checklist } from "../../../src/client/pages/Checklist.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity } from "../../../src/client/api/types.js";

const TRIP_A = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
};

const TRIP_B = {
  id: "t2",
  title: "Kauai",
  destination: "Kauai, HI",
  startsOn: "2026-12-01",
  endsOn: "2026-12-08",
  status: "planning" as const,
  notes: null,
};

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function item(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    tripId: "t1",
    personId: null,
    label: "Pack passports",
    dueOn: null,
    doneAt: null,
    ...over,
  };
}

function makeApi(over: Record<string, unknown> = {}) {
  return {
    trips: { list: vi.fn(async () => [TRIP_A, TRIP_B]) },
    people: { list: vi.fn(async () => PEOPLE) },
    checklist: {
      list: vi.fn(async () => [item()]),
      create: vi.fn(async (input: Record<string, unknown>) => ({
        id: "new-1",
        tripId: input.tripId,
        personId: input.personId ?? null,
        label: input.label,
        dueOn: input.dueOn ?? null,
        doneAt: null,
      })),
      setDone: vi.fn(async () => undefined),
    },
    ...over,
  };
}

function asRole(role: Identity["role"], ui: ReactNode) {
  const me = async () => ({
    userId: "u1",
    email: "badger@example.com",
    householdId: "hh-a",
    role,
  });
  return render(<IdentityProvider api={{ me } as never}>{ui}</IdentityProvider>);
}

function renderChecklist(api = makeApi(), role: Identity["role"] = "owner") {
  asRole(role, <Checklist api={api as never} />);
  return api;
}

describe("Checklist page", () => {
  it("groups items by trip, showing the trip title as a heading", async () => {
    const api = makeApi({
      checklist: {
        list: vi.fn(async () => [
          item({ id: "c1", tripId: "t1", label: "Pack passports" }),
          item({ id: "c2", tripId: "t2", label: "Book snorkel gear" }),
        ]),
        create: vi.fn(),
        setDone: vi.fn(),
      },
    });
    renderChecklist(api);
    expect(await screen.findByText("Mary & Winter Wedding")).toBeInTheDocument();
    expect(await screen.findByText("Kauai")).toBeInTheDocument();
    expect(screen.getByText("Pack passports")).toBeInTheDocument();
    expect(screen.getByText("Book snorkel gear")).toBeInTheDocument();
  });

  it("renders a family-wide item (personId: null) as 'Everyone', not broken", async () => {
    const api = makeApi({
      checklist: {
        list: vi.fn(async () => [item({ personId: null, label: "Pack passports" })]),
        create: vi.fn(),
        setDone: vi.fn(),
      },
    });
    renderChecklist(api);
    expect(await screen.findByText("Pack passports")).toBeInTheDocument();
    expect(await screen.findByText(/everyone/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than spinning forever", async () => {
    const api = makeApi({
      trips: { list: vi.fn(async () => { throw new Error("500"); }) },
    });
    renderChecklist(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it("offers a real call to action when there are no trips yet", async () => {
    const api = makeApi({ trips: { list: vi.fn(async () => []) } });
    renderChecklist(api);
    expect(await screen.findByText(/create a trip/i)).toBeInTheDocument();
  });

  it("invites adding an item when there are trips but no checklist items", async () => {
    const api = makeApi({
      checklist: { list: vi.fn(async () => []), create: vi.fn(), setDone: vi.fn() },
    });
    renderChecklist(api);
    expect(await screen.findByText(/add the first task/i)).toBeInTheDocument();
  });

  it("creates an item and shows it in its trip's group without a reload", async () => {
    const api = renderChecklist();
    await userEvent.click(await screen.findByRole("button", { name: /add task/i }));
    await userEvent.type(screen.getByLabelText(/label/i), "Buy travel insurance");
    const tripSelect = screen.getByLabelText(/trip/i);
    await userEvent.selectOptions(tripSelect, "t2");
    await userEvent.click(screen.getByRole("button", { name: /save task/i }));

    expect(api.checklist.create).toHaveBeenCalledWith(
      expect.objectContaining({ tripId: "t2", label: "Buy travel insurance" }),
    );
    expect(await screen.findByText("Buy travel insurance")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the dialog open with typed values and shows an error on a rejected create", async () => {
    const api = makeApi({
      checklist: {
        list: vi.fn(async () => [item()]),
        create: vi.fn(async () => {
          throw new Error("403");
        }),
        setDone: vi.fn(),
      },
    });
    renderChecklist(api);
    await userEvent.click(await screen.findByRole("button", { name: /add task/i }));
    await userEvent.type(screen.getByLabelText(/label/i), "Buy travel insurance");
    await userEvent.click(screen.getByRole("button", { name: /save task/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText(/label/i)).toHaveValue("Buy travel insurance");
  });

  it("does not offer a write to a viewer: no Add task button, no done-toggle", async () => {
    const api = makeApi();
    renderChecklist(api, "viewer");
    await screen.findByText("Pack passports");
    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: /add task/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Pack passports/ })).not.toBeInTheDocument();
    });
  });

  it("still offers writes to an owner", async () => {
    const api = makeApi();
    renderChecklist(api, "owner");
    expect(await screen.findByRole("button", { name: /add task/i })).toBeInTheDocument();
  });

  it("leaves the list on screen when a write (setDone) fails", async () => {
    const api = makeApi({
      checklist: {
        list: vi.fn(async () => [
          item({ id: "c1", label: "Pack passports" }),
          item({ id: "c2", label: "Confirm hotel" }),
        ]),
        create: vi.fn(),
        setDone: vi.fn(async () => {
          throw new Error("403");
        }),
      },
    });
    renderChecklist(api);
    const row = await screen.findByRole("button", { name: /Pack passports/ });
    await userEvent.click(row);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Pack passports")).toBeInTheDocument();
    expect(screen.getByText("Confirm hotel")).toBeInTheDocument();
  });

  it("toggles an item done without a reload", async () => {
    const api = makeApi({
      checklist: {
        list: vi.fn(async () => [item({ id: "c1", label: "Pack passports" })]),
        create: vi.fn(),
        setDone: vi.fn(async () => undefined),
      },
    });
    renderChecklist(api);
    const row = await screen.findByRole("button", { name: /Pack passports/ });
    await userEvent.click(row);
    expect(api.checklist.setDone).toHaveBeenCalledWith("c1", true);
    await vi.waitFor(() => {
      expect(row).toHaveStyle({ textDecoration: "line-through" });
    });
  });
});
