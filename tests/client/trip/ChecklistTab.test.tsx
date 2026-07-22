import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChecklistTab } from "../../../src/client/trip/ChecklistTab.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity } from "../../../src/client/api/types.js";

const PEOPLE = [{ id: "p1", displayName: "Badger" }];

function item(over: Record<string, unknown> = {}) {
  return {
    id: "c1", tripId: "t1", personId: null, label: "Pack passports",
    dueOn: null, doneAt: null,
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

function renderTab(api: Record<string, unknown>, role: Identity["role"] = "owner") {
  return asRole(
    role,
    <ChecklistTab tripId="t1" people={PEOPLE as never} api={api as never} />,
  );
}

describe("ChecklistTab", () => {
  it("renders items for the trip", async () => {
    const api = { checklist: { list: vi.fn(async () => [item()]), setDone: vi.fn() } };
    renderTab(api);
    expect(await screen.findByText("Pack passports")).toBeInTheDocument();
  });

  // The client-side filter: /api/checklist is a cross-trip endpoint
  // (ChecklistRepo.listAll), so the tab must only show items for its own trip.
  it("filters the cross-trip checklist list down to this trip", async () => {
    const api = {
      checklist: {
        list: vi.fn(async () => [
          item({ id: "c1", tripId: "t1", label: "Pack passports" }),
          item({ id: "c2", tripId: "t2", label: "Other trip's item" }),
        ]),
        setDone: vi.fn(),
      },
    };
    renderTab(api);
    expect(await screen.findByText("Pack passports")).toBeInTheDocument();
    expect(screen.queryByText("Other trip's item")).not.toBeInTheDocument();
  });

  it("reports a failed load rather than spinning forever", async () => {
    const api = {
      checklist: {
        list: vi.fn(async () => {
          throw new Error("500");
        }),
        setDone: vi.fn(),
      },
    };
    renderTab(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load|could not load/i);
  });

  it("renders an empty state with no items", async () => {
    const api = { checklist: { list: vi.fn(async () => []), setDone: vi.fn() } };
    renderTab(api);
    expect(await screen.findByText(/no checklist items/i)).toBeInTheDocument();
  });

  it("toggles an item done on click", async () => {
    const api = {
      checklist: { list: vi.fn(async () => [item()]), setDone: vi.fn(async () => undefined) },
    };
    renderTab(api);
    const row = await screen.findByRole("button", { name: /Pack passports/ });
    await userEvent.click(row);
    expect(api.checklist.setDone).toHaveBeenCalledWith("c1", true);
  });

  // Finding 1: the bug this whole suite exists to guard against. A rejected
  // *write* used to set the same `failed` flag the *load* path uses, which
  // unmounted the entire list and left the tab reading "Couldn't load this
  // trip's checklist" -- a lie, since nothing failed to load, and a
  // guaranteed path for the viewer role (assuming a stale client-side
  // permission check, or a race with a role change) before the viewer-only
  // static rendering below existed at all.
  describe("Finding 1: a rejected write does not unmount the list", () => {
    it("keeps the list on screen after a write fails", async () => {
      const api = {
        checklist: {
          list: vi.fn(async () => [item(), item({ id: "c2", label: "Confirm hotel" })]),
          setDone: vi.fn(async () => {
            throw new Error("403");
          }),
        },
      };
      renderTab(api);
      const row = await screen.findByRole("button", { name: /Pack passports/ });
      await userEvent.click(row);

      // Both items are still on screen -- the failure of one write did not
      // take down the list.
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByText("Pack passports")).toBeInTheDocument();
      expect(screen.getByText("Confirm hotel")).toBeInTheDocument();
    });

    it("reports the failure as a write problem, not a load problem", async () => {
      const api = {
        checklist: {
          list: vi.fn(async () => [item()]),
          setDone: vi.fn(async () => {
            throw new Error("403");
          }),
        },
      };
      renderTab(api);
      const row = await screen.findByRole("button", { name: /Pack passports/ });
      await userEvent.click(row);

      const alert = await screen.findByRole("alert");
      expect(alert).not.toHaveTextContent(/couldn't load|could not load/i);
    });

    it("does not optimistically mark the item done when the write is rejected", async () => {
      const api = {
        checklist: {
          list: vi.fn(async () => [item()]),
          setDone: vi.fn(async () => {
            throw new Error("403");
          }),
        },
      };
      renderTab(api);
      const row = await screen.findByRole("button", { name: /Pack passports/ });
      await userEvent.click(row);
      await screen.findByRole("alert");

      // Still rendered as not-done: no line-through style flag flipped.
      expect(screen.getByRole("button", { name: /Pack passports/ })).not.toHaveStyle({
        textDecoration: "line-through",
      });
    });
  });

  // The viewer role: ChecklistRepo.setDone goes through requireWrite(), so a
  // viewer's toggle is a guaranteed 403. Rendering a clickable affordance for
  // that would repeat exactly the mistake useCanReveal/MaskedValue exists to
  // avoid on the reveal side.
  describe("viewer role renders items as static, non-interactive text", () => {
    it("does not render items as buttons for a viewer", async () => {
      const api = { checklist: { list: vi.fn(async () => [item()]), setDone: vi.fn() } };
      renderTab(api, "viewer");
      await vi.waitFor(() => {
        expect(screen.getByText("Pack passports")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Pack passports/ })).not.toBeInTheDocument();
      });
    });

    it("still renders items as buttons for an owner", async () => {
      const api = { checklist: { list: vi.fn(async () => [item()]), setDone: vi.fn() } };
      renderTab(api, "owner");
      expect(await screen.findByRole("button", { name: /Pack passports/ })).toBeInTheDocument();
    });
  });
});
