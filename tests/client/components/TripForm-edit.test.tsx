import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripForm } from "../../../src/client/components/TripForm.js";
import { ApiError } from "../../../src/client/api/client.js";

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
};

const PEOPLE = [{ id: "p1", displayName: "Badger" }] as never[];

function makeApi() {
  return {
    trips: {
      create: vi.fn(),
      update: vi.fn(async () => ({ ...TRIP, title: "Updated" })),
      addTraveler: vi.fn(),
    },
  };
}

function renderEdit(trip: Record<string, unknown> = TRIP, api = makeApi(), onSaved = vi.fn()) {
  render(
    <TripForm
      people={PEOPLE}
      trip={trip as never}
      api={api as never}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );
  return { api, onSaved };
}

describe("TripForm (edit mode)", () => {
  it("seeds the fields from the trip and offers the status control", () => {
    renderEdit();
    expect(screen.getByLabelText("Title")).toHaveValue("Mary & Winter Wedding");
    expect(screen.getByLabelText("Destination")).toHaveValue("Guerneville, CA");
    expect(screen.getByLabelText("Starts on")).toHaveValue("2026-10-09");
    expect(screen.getByLabelText("Ends on")).toHaveValue("2026-10-11");
    expect(screen.getByRole("radio", { name: "Auto (planning)" })).toBeChecked();
    // Cancelled is never offered here — it belongs to the Cancel action.
    expect(screen.queryByRole("radio", { name: /cancel/i })).not.toBeInTheDocument();
    // The roster is create-only; edit mode manages travellers elsewhere.
    expect(screen.queryByText(/who's coming/i)).not.toBeInTheDocument();
  });

  it("PUTs a partial update with null for emptied fields and no status when unchanged", async () => {
    const { api, onSaved } = renderEdit();
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Wedding weekend");
    await userEvent.clear(screen.getByLabelText("Destination"));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(api.trips.update).toHaveBeenCalledWith("t1", {
      title: "Wedding weekend",
      destination: null,
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
      notes: null,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("sends the status only when the operator changed it", async () => {
    const { api } = renderEdit();
    await userEvent.click(screen.getByRole("radio", { name: "Complete" }));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(api.trips.update).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "complete" }),
    );
  });

  it("does not un-cancel a cancelled trip on an unrelated edit", async () => {
    // A cancelled trip's control seeds to Auto (the control cannot express
    // cancelled); submitting without touching it must not send status at
    // all, or the title edit would silently restore the trip.
    const { api } = renderEdit({ ...TRIP, status: "cancelled" });
    await userEvent.type(screen.getByLabelText("Title"), " 2026");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const [, patch] = api.trips.update.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect("status" in patch).toBe(false);
  });

  it("refuses an inverted date range before calling the API", async () => {
    const { api } = renderEdit();
    const ends = screen.getByLabelText("Ends on");
    await userEvent.clear(ends);
    await userEvent.type(ends, "2026-10-01");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(api.trips.update).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/end date/i);
  });

  it("keeps the dialog open and the typed values on a rejected write", async () => {
    const api = makeApi();
    api.trips.update = vi.fn(async () => {
      throw new ApiError("/api/trips/t1 failed: Forbidden", 403);
    });
    const { onSaved } = renderEdit(TRIP, api);
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Wedding weekend");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    // A friendly sentence, not String(err); the entered value survives.
    expect(await screen.findByRole("alert")).toHaveTextContent(/permission/i);
    expect(screen.queryByText(/ApiError/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Wedding weekend");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
