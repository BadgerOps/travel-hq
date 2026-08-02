import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportReviewQueue } from "../../../src/client/imports/ImportReviewQueue.js";
import { ApiError } from "../../../src/client/api/client.js";
import type { PendingImportDraft, Trip } from "../../../src/client/api/types.js";

const trip: Trip = {
  id: "trip-europe",
  title: "Europe",
  destination: "Germany",
  startsOn: "2026-10-20",
  endsOn: "2026-10-30",
  status: "planning",
  notes: null,
  photoUrl: null,
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
    duplicates: [],
    ...options,
    costCents: options.costCents ?? null,
    details: options.details ?? {},
    travelerNames: options.travelerNames ?? [],
    travelerEmails: options.travelerEmails ?? [],
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
  const api = {
    imports: { pending, accept, createTrip, dismiss },
    trips: { list: vi.fn(async () => [trip]) },
  };
  render(<ImportReviewQueue api={api as never} />);
  return { pending, accept, createTrip, dismiss };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ImportReviewQueue", () => {
  it("shows extracted confirmation, cost, and useful booking details", async () => {
    setup([draft("KOA", {
      kind: "lodging",
      title: "St. Mary / East Glacier KOA Holiday",
      confirmationNumber: "21081900",
      costCents: 42_500,
      details: {
        propertyName: "St. Mary / East Glacier KOA Holiday",
        checkInDate: "2026-08-05",
        checkOutDate: "2026-08-09",
        nights: 4,
        siteNumber: "1896",
      },
    })]);

    expect(await screen.findByText("21081900")).toBeInTheDocument();
    expect(screen.getByText("$425.00")).toBeInTheDocument();
    expect(screen.getByText("Aug 5, 2026")).toBeInTheDocument();
    expect(screen.getByText("1896")).toBeInTheDocument();
  });

  /**
   * How much to trust the fields above it. A calendar attachment was written by
   * the airline; an AI reading of prose is a suggestion that may have put the
   * gate time in the wrong zone — and the reviewer deciding whether to correct
   * a draft before accepting it needs to know which one they are looking at.
   * The server has always sent `extractionSource`; the card used to drop it.
   */
  it("says how each draft was extracted", async () => {
    setup([
      draft("DL2586", { extractionSource: "ai" }),
      draft("DL0162", { extractionSource: "ics" }),
    ]);

    expect(await screen.findByText("from AI")).toBeInTheDocument();
    expect(screen.getByText("from calendar")).toBeInTheDocument();
  });

  it("tells an empty queue where mail comes from and where to set it up", async () => {
    setup([]);

    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings/ }))
      .toHaveAttribute("href", "/settings");
  });

  it("groups one source and accepts all uniquely matched drafts into its suggested trip", async () => {
    const first = draft("DL2586", { suggestedTrip: trip });
    const second = draft("DL162", { suggestedTrip: trip });
    const { accept } = setup([first, second]);

    expect(await screen.findByText("Fwd: Delta trip information")).toBeInTheDocument();
    expect(screen.getByText("Suggested trip: Europe")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Accept all into Europe" }),
    );

    // The third argument is the duplicate override, always sent and always
    // false unless the reviewer answered a 409.
    expect(accept).toHaveBeenCalledWith([first.id, second.id], trip.id, false);
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
      trips: { list: vi.fn(async () => [trip]) },
    };
    render(<ImportReviewQueue api={api as never} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByLabelText("Select Flight DL2586"));
    // Arm, then commit. Nothing is sent on the first click.
    await userEvent.click(screen.getByRole("button", { name: "Dismiss selected import" }));
    expect(dismiss).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss 1 import?" }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(["DL2586"]));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("dismisses one import from its own row, and lets Keep call it off", async () => {
    const dismiss = vi.fn(async (draftIds: string[]) => ({
      dismissedDraftIds: draftIds,
    }));
    const api = {
      imports: {
        pending: vi.fn(async () => [draft("DL2586"), draft("DL0162")]),
        accept: vi.fn(),
        createTrip: vi.fn(),
        dismiss,
      },
      trips: { list: vi.fn(async () => [trip]) },
    };
    render(<ImportReviewQueue api={api as never} />);

    await screen.findByText("Flight DL2586");
    // Backing out leaves the row exactly as it was — no request, no selection.
    await userEvent.click(screen.getByRole("button", { name: "Dismiss Flight DL2586" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Dismiss Flight DL2586" })).toBeInTheDocument();

    // A per-row dismiss sends that draft alone, with nothing ticked.
    await userEvent.click(screen.getByRole("button", { name: "Dismiss Flight DL2586" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss Flight DL2586?" }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(["DL2586"]));
    expect(screen.queryByText("Flight DL2586")).not.toBeInTheDocument();
    expect(screen.getByText("Flight DL0162")).toBeInTheDocument();
  });

  it("keeps the review queue usable when the optional trip picker cannot load", async () => {
    const pending = vi.fn(async () => [draft("DL2586")]);
    const api = {
      imports: {
        pending,
        accept: vi.fn(),
        createTrip: vi.fn(),
        dismiss: vi.fn(),
      },
      trips: { list: vi.fn(async () => { throw new Error("offline"); }) },
    };
    render(<ImportReviewQueue api={api as never} />);

    expect(await screen.findByText("Flight DL2586")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new trip" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Existing trip for selected imports"))
      .not.toBeInTheDocument();
  });

  it("warns that a pending import is already on a trip", async () => {
    setup([
      draft("DL2586", {
        duplicates: [
          {
            reason: "confirmation",
            confidence: "high",
            target: "booking",
            id: "b1",
            title: "Delta 2586",
            startsAt: "2026-10-21T22:00:00.000Z",
            startsAtTz: "America/Denver",
            tripId: trip.id,
            tripTitle: trip.title,
          },
        ],
      }),
    ]);
    expect(await screen.findByTestId("duplicate-notice")).toHaveTextContent(
      /Already on Europe as “Delta 2586”/,
    );
  });

  it("offers Import anyway after the server refuses a duplicate, and repeats the accept with the override", async () => {
    const first = draft("DL2586", { suggestedTrip: trip });
    const accept = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("failed", 409, "1 of these imports looks like a booking already on Europe."),
      )
      .mockResolvedValueOnce({ trip, acceptedDraftIds: [first.id] });
    const api = {
      imports: { pending: vi.fn(async () => [first]), accept, createTrip: vi.fn(), dismiss: vi.fn() },
      trips: { list: vi.fn(async () => [trip]) },
    };
    render(<ImportReviewQueue api={api as never} />);

    await screen.findByText("Fwd: Delta trip information");
    await userEvent.click(screen.getByRole("button", { name: "Accept all into Europe" }));

    // The server's own sentence, not a generic failure line.
    expect(await screen.findByRole("alert")).toHaveTextContent(/already on Europe/);
    await userEvent.click(screen.getByRole("button", { name: "Import anyway" }));

    await waitFor(() => expect(accept).toHaveBeenLastCalledWith([first.id], trip.id, true));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("does not offer Import anyway for a failure that is not a conflict", async () => {
    const first = draft("DL2586", { suggestedTrip: trip });
    const api = {
      imports: {
        pending: vi.fn(async () => [first]),
        accept: vi.fn().mockRejectedValue(new ApiError("failed", 500)),
        createTrip: vi.fn(),
        dismiss: vi.fn(),
      },
      trips: { list: vi.fn(async () => [trip]) },
    };
    render(<ImportReviewQueue api={api as never} />);

    await screen.findByText("Fwd: Delta trip information");
    await userEvent.click(screen.getByRole("button", { name: "Accept all into Europe" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Import anyway" })).not.toBeInTheDocument();
  });
});
