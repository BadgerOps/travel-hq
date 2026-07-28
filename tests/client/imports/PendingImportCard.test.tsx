import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { PendingImportCard } from "../../../src/client/imports/PendingImportCard.js";
import type { PendingImportDraft, Trip } from "../../../src/client/api/types.js";

const createdTrip: Trip = {
  id: "trip-silverwood",
  title: "Your Silverwood RV Park Reservation",
  destination: null,
  startsOn: "2026-07-29",
  endsOn: "2026-07-30",
  status: "planning",
  notes: null,
  photoUrl: null,
};

function draft(id: string, title: string): PendingImportDraft {
  return {
    id,
    inboundEmailId: "email-silverwood",
    kind: "other",
    title,
    location: null,
    startsAt: "2026-07-29T13:00:00.000Z",
    startsAtTz: "America/Boise",
    endsAt: "2026-07-30T10:00:00.000Z",
    endsAtTz: "America/Boise",
    confirmationNumber: null,
    costCents: null,
    details: {},
    travelerNames: [],
    travelerEmails: [],
    extractionSource: "ai",
    localStartsOn: "2026-07-29",
    localEndsOn: "2026-07-30",
    source: {
      from: "sol@example.com",
      subject: "Fwd: Your Silverwood RV Park Reservation",
      receivedAt: "2026-07-27T19:28:40.411Z",
    },
    suggestedTrip: null,
    duplicates: [],
  };
}

function renderCard(pendingDrafts: PendingImportDraft[]) {
  const pending = vi.fn(async () => pendingDrafts);
  const accept = vi.fn(async (draftIds: string[]) => ({
    trip: createdTrip,
    acceptedDraftIds: draftIds,
  }));
  const createTrip = vi.fn(async (input: { draftIds: string[] }) => ({
    trip: createdTrip,
    acceptedDraftIds: input.draftIds,
  }));
  const onTripCreated = vi.fn();
  const api = {
    imports: { pending, accept, createTrip },
    trips: { list: vi.fn(async () => [createdTrip]) },
  };
  const { hook } = memoryLocation({ path: "/" });
  render(
    <Router hook={hook}>
      <PendingImportCard
        api={api as never}
        onTripCreated={onTripCreated}
      />
    </Router>,
  );
  return { pending, accept, createTrip, onTripCreated };
}

describe("PendingImportCard", () => {
  it("stays hidden when there is nothing to review", async () => {
    const { pending } = renderCard([]);
    await vi.waitFor(() => expect(pending).toHaveBeenCalled());
    expect(screen.queryByTestId("pending-import-card")).not.toBeInTheDocument();
  });

  it("selects pending drafts and creates a trip with the shared import dialog", async () => {
    const first = draft("draft-1", "Silverwood RV Park Reservation");
    const duplicate = draft("draft-2", "Silverwood RV Park Reservation duplicate");
    const { createTrip, onTripCreated } = renderCard([first, duplicate]);

    expect(await screen.findByText("2 pending imports")).toBeInTheDocument();
    const createButton = screen.getByRole("button", {
      name: "Create trip from selected",
    });
    expect(createButton).toBeDisabled();
    await userEvent.click(
      screen.getByLabelText("Select pending import Silverwood RV Park Reservation"),
    );
    await userEvent.click(createButton);

    expect(screen.getByRole("dialog", { name: "Create trip from imports" }))
      .toBeInTheDocument();
    expect(screen.getByLabelText("Title"))
      .toHaveValue("Your Silverwood RV Park Reservation");
    expect(screen.getByLabelText("Starts on")).toHaveValue("2026-07-29");
    expect(screen.getByLabelText("Ends on")).toHaveValue("2026-07-30");
    await userEvent.click(
      screen.getByRole("button", { name: "Create trip and add bookings" }),
    );

    expect(createTrip).toHaveBeenCalledWith({
      draftIds: ["draft-1"],
      title: "Your Silverwood RV Park Reservation",
      startsOn: "2026-07-29",
      endsOn: "2026-07-30",
    });
    expect(onTripCreated).toHaveBeenCalledWith(createdTrip);
    expect(await screen.findByText("1 pending import")).toBeInTheDocument();
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();
    expect(screen.getByText(duplicate.title)).toBeInTheDocument();
  });

  it("adds a manually selected unmatched import to an existing trip", async () => {
    const unmatched = draft("draft-1", "Silverwood RV Park Reservation");
    const { accept } = renderCard([unmatched]);

    await screen.findByText("1 pending import");
    await userEvent.click(
      screen.getByLabelText("Select pending import Silverwood RV Park Reservation"),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Existing trip for selected imports"),
      createdTrip.id,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to trip" }));

    expect(accept).toHaveBeenCalledWith([unmatched.id], createdTrip.id, false);
    await vi.waitFor(() =>
      expect(screen.queryByTestId("pending-import-card")).not.toBeInTheDocument(),
    );
  });
});
