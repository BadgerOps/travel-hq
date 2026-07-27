import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportReviewQueue } from "../../../src/client/imports/ImportReviewQueue.js";
import type { PendingImportDraft, Trip } from "../../../src/client/api/types.js";

const trip: Trip = {
  id: "trip-europe",
  title: "Europe",
  destination: "Germany",
  startsOn: "2026-10-20",
  endsOn: "2026-10-30",
  status: "planning",
  notes: null,
};

function draft(
  id: string,
  options: Partial<PendingImportDraft> = {},
): PendingImportDraft {
  return {
    id,
    inboundEmailId: "email-delta",
    kind: "flight",
    title: `Flight ${id}`,
    location: "DEN → AMS",
    startsAt: "2026-10-21T22:00:00.000Z",
    startsAtTz: "America/Denver",
    endsAt: "2026-10-22T08:00:00.000Z",
    endsAtTz: "Europe/Amsterdam",
    confirmationNumber: "TRIP90",
    extractionSource: "ai",
    localStartsOn: "2026-10-21",
    localEndsOn: "2026-10-22",
    source: {
      from: "traveler@example.com",
      subject: "Fwd: Delta trip information",
      receivedAt: "2026-07-27T12:00:00.000Z",
    },
    suggestedTrip: null,
    ...options,
  };
}

function setup(pendingDrafts: PendingImportDraft[]) {
  const pending = vi.fn(async () => pendingDrafts);
  const accept = vi.fn(async (draftIds: string[]) => ({
    trip,
    acceptedDraftIds: draftIds,
  }));
  const createTrip = vi.fn(async (input: { draftIds: string[] }) => ({
    trip: { ...trip, id: "trip-new", title: "Delta trip information" },
    acceptedDraftIds: input.draftIds,
  }));
  const dismiss = vi.fn(async (draftIds: string[]) => ({
    dismissedDraftIds: draftIds,
  }));
  const api = { imports: { pending, accept, createTrip, dismiss } };
  render(<ImportReviewQueue api={api as never} />);
  return { pending, accept, createTrip, dismiss };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ImportReviewQueue", () => {
  it("groups one source and accepts all uniquely matched drafts into its suggested trip", async () => {
    const first = draft("DL2586", { suggestedTrip: trip });
    const second = draft("DL162", { suggestedTrip: trip });
    const { accept } = setup([first, second]);

    expect(await screen.findByText("Fwd: Delta trip information")).toBeInTheDocument();
    expect(screen.getByText("Suggested trip: Europe")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Accept all into Europe" }),
    );

    expect(accept).toHaveBeenCalledWith([first.id, second.id], trip.id);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Added 2 bookings to Europe");
  });

  it("creates one new trip from multiple selected unmatched imports", async () => {
    const first = draft("DL2586", {
      localStartsOn: "2026-10-21",
      localEndsOn: "2026-10-21",
    });
    const second = draft("DL9674", {
      inboundEmailId: "email-hotel",
      title: "Hotel Stuttgart",
      localStartsOn: "2026-10-22",
      localEndsOn: "2026-10-24",
      source: {
        from: "hotel@example.com",
        subject: "Hotel confirmation",
        receivedAt: "2026-07-27T13:00:00.000Z",
      },
    });
    const { createTrip } = setup([first, second]);

    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByLabelText("Select Flight DL2586"));
    await userEvent.click(screen.getByLabelText("Select Hotel Stuttgart"));
    await userEvent.click(screen.getByRole("button", { name: "Create new trip" }));

    expect(screen.getByRole("dialog", { name: "Create trip from imports" }))
      .toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Delta trip information");
    expect(screen.getByLabelText("Starts on")).toHaveValue("2026-10-21");
    expect(screen.getByLabelText("Ends on")).toHaveValue("2026-10-24");
    await userEvent.type(screen.getByLabelText("Destination"), "Stuttgart");
    await userEvent.click(
      screen.getByRole("button", { name: "Create trip and add bookings" }),
    );

    expect(createTrip).toHaveBeenCalledWith({
      draftIds: [first.id, second.id],
      title: "Delta trip information",
      destination: "Stuttgart",
      startsOn: "2026-10-21",
      endsOn: "2026-10-24",
    });
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("dismisses selected imports after confirmation and can retry a failed load", async () => {
    const pending = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([draft("DL2586")]);
    const dismiss = vi.fn(async (draftIds: string[]) => ({
      dismissedDraftIds: draftIds,
    }));
    const api = {
      imports: {
        pending,
        accept: vi.fn(),
        createTrip: vi.fn(),
        dismiss,
      },
    };
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<ImportReviewQueue api={api as never} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByLabelText("Select Flight DL2586"));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss selected" }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(["DL2586"]));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });
});
