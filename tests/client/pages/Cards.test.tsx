import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Cards } from "../../../src/client/pages/Cards.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { CardWithPerks, Identity, PerkWithStatus } from "../../../src/client/api/types.js";

const CREDIT: PerkWithStatus = {
  id: "k1",
  cardId: "c1",
  name: "Annual travel credit",
  kind: "statement_credit",
  valueCents: 30_000,
  multiplier: null,
  category: null,
  cadence: "annual",
  resetMonthDay: "01-01",
  usedAt: null,
  usedThisPeriod: false,
};

const MULTIPLIER: PerkWithStatus = {
  id: "k2",
  cardId: "c1",
  name: "Travel earn",
  kind: "multiplier",
  valueCents: null,
  multiplier: 3,
  category: "travel",
  cadence: "one_time",
  resetMonthDay: null,
  usedAt: null,
  usedThisPeriod: false,
};

const CSR: CardWithPerks = {
  id: "c1",
  name: "Sapphire Reserve",
  issuer: "Chase",
  pointsProgram: "UR",
  pointsBalance: 85_000,
  balanceUpdatedAt: "2026-07-01T00:00:00.000Z",
  perks: [CREDIT, MULTIPLIER],
  unspentCents: 30_000,
};

function makeApi(cards: CardWithPerks[] = [CSR]) {
  return {
    cards: {
      list: vi.fn(async () => cards),
      create: vi.fn(async () => ({
        id: "c9",
        name: "Amex Platinum",
        issuer: null,
        pointsProgram: null,
        pointsBalance: null,
        balanceUpdatedAt: null,
      })),
      update: vi.fn(async () => ({ ...CSR, name: "Sapphire Reserve Renamed" })),
      remove: vi.fn(async () => undefined),
      createPerk: vi.fn(async () => ({ ...CREDIT, id: "k9", name: "Lounge access", kind: "lounge" as const, valueCents: null })),
      updatePerk: vi.fn(async () => ({ ...CREDIT, name: "Renamed credit" })),
      removePerk: vi.fn(async () => undefined),
      setPerkUsed: vi.fn(async () => undefined),
    },
  };
}

function asRole(role: Identity["role"], ui: ReactNode) {
  const me = async () => ({ userId: "u1", email: "badger@example.com", householdId: "hh-a", role });
  return render(<IdentityProvider api={{ me } as never}>{ui}</IdentityProvider>);
}

function renderCards(api = makeApi(), role: Identity["role"] = "owner") {
  asRole(role, <Cards api={api as never} />);
  return api;
}

describe("Cards page", () => {
  it("renders each card with its perks and points balance", async () => {
    renderCards();
    expect(await screen.findByText("Sapphire Reserve")).toBeInTheDocument();
    expect(screen.getByText(/85,000 UR/)).toBeInTheDocument();
    expect(screen.getByText("Annual travel credit")).toBeInTheDocument();
    // The multiplier is displayed but is not a credit -- no used-toggle for it.
    expect(screen.getByText(/3× travel/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /mark travel earn used/i })).not.toBeInTheDocument();
  });

  it("surfaces unspent credits per card and in the page-level total", async () => {
    renderCards();
    expect(await screen.findByText(/Unspent credits/i)).toBeInTheDocument();
    // Total callout + per-card line.
    expect(screen.getAllByText(/\$300\.00/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/\$300\.00 unspent this period/)).toBeInTheDocument();
  });

  it("marks a credit used through the API and drops it from the unspent total", async () => {
    const api = renderCards();
    const toggle = await screen.findByRole("checkbox", { name: /mark annual travel credit used/i });
    await userEvent.click(toggle);
    expect(api.cards.setPerkUsed).toHaveBeenCalledWith("c1", "k1", true);
    await vi.waitFor(() => {
      expect(screen.queryByText(/\$300\.00 unspent this period/)).not.toBeInTheDocument();
    });
  });

  it("offers a first-run empty state rather than a blank page", async () => {
    renderCards(makeApi([]));
    expect(await screen.findByText(/no cards yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add the first card/i })).toBeInTheDocument();
  });

  it("reports a failed load rather than looking like an empty portfolio", async () => {
    const api = makeApi();
    api.cards.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderCards(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no cards yet/i)).not.toBeInTheDocument();
  });

  it("creates a card from the header control and shows it without a reload", async () => {
    const api = renderCards();
    await userEvent.click(await screen.findByRole("button", { name: /add card/i }));
    await userEvent.type(screen.getByLabelText("Card name"), "Amex Platinum");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.cards.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Amex Platinum" }));
    expect(await screen.findByText("Amex Platinum")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("adds a perk to a card without a reload", async () => {
    const api = renderCards();
    await userEvent.click(await screen.findByRole("button", { name: /add perk/i }));
    await userEvent.type(screen.getByLabelText("Perk name"), "Lounge access");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "lounge");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.cards.createPerk).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ name: "Lounge access", kind: "lounge" }),
    );
    expect(await screen.findByText("Lounge access")).toBeInTheDocument();
  });

  it("keeps the dialog open with typed values and shows an error on a rejected create", async () => {
    const api = makeApi();
    api.cards.create = vi.fn(async () => {
      throw new Error("403");
    });
    renderCards(api);
    await userEvent.click(await screen.findByRole("button", { name: /add card/i }));
    await userEvent.type(screen.getByLabelText("Card name"), "Amex Platinum");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Card name")).toHaveValue("Amex Platinum");
  });

  it("offers no writes to a viewer, but still shows used/unspent state", async () => {
    renderCards(makeApi(), "viewer");
    await screen.findByText("Sapphire Reserve");
    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: /add card/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add perk/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText("unspent")).toBeInTheDocument();
  });

  it("deletes a perk after a confirm", async () => {
    const api = makeApi();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderCards(api);
      await userEvent.click(await screen.findByRole("button", { name: /delete annual travel credit/i }));
      expect(api.cards.removePerk).toHaveBeenCalledWith("c1", "k1");
      await vi.waitFor(() => {
        expect(screen.queryByText("Annual travel credit")).not.toBeInTheDocument();
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
