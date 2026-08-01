import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportReviewQueue } from "../../../src/client/imports/ImportReviewQueue.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { PendingImportDraft, Trip } from "../../../src/client/api/types.js";

function trip(over: Partial<Trip> & { id: string; title: string }): Trip {
  return {
    destination: null,
    startsOn: null,
    endsOn: null,
    status: "planning",
    notes: null,
    photoUrl: null,
    ...over,
  };
}

const EUROPE = trip({
  id: "trip-europe",
  title: "Europe",
  destination: "Germany",
  startsOn: "2026-10-20",
  endsOn: "2026-10-30",
});
const CITY_BREAK = trip({
  id: "trip-city",
  title: "Autumn city break",
  destination: "Lisbon",
  startsOn: "2026-10-10",
  endsOn: "2026-10-19",
});
const SOMEDAY = trip({ id: "trip-someday", title: "Someday" });

function draft(over: Partial<PendingImportDraft> = {}): PendingImportDraft {
  return {
    id: "DL2586",
    inboundEmailId: "email-delta",
    kind: "flight",
    title: "Flight DL2586",
    location: "Stuttgart, Germany",
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
    costCents: 42_500,
    details: {
      carrier: "Delta",
      flightNumber: "2586",
      originIata: "DEN",
      destinationIata: "AMS",
    },
    travelerNames: [],
    travelerEmails: [],
    ...over,
  };
}

function setup(drafts: PendingImportDraft[], trips: Trip[] = [EUROPE]) {
  const pending = vi.fn(async () => drafts);
  const updateDraft = vi.fn(async () => drafts[0]!);
  const api = {
    imports: {
      pending,
      accept: vi.fn(),
      createTrip: vi.fn(),
      dismiss: vi.fn(),
      updateDraft,
    },
    trips: { list: vi.fn(async () => trips) },
  };
  render(<ImportReviewQueue api={api as never} />);
  return { pending, updateDraft };
}

describe("ImportReviewQueue — correcting an import before accepting it", () => {
  it("opens the Add booking form pre-filled from the draft", async () => {
    setup([draft()]);
    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByRole("button", { name: "Edit Flight DL2586" }));

    const dialog = screen.getByRole("dialog", { name: "Edit import" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Flight DL2586");
    // A draft's confirmation number is held in the clear (nothing has
    // encrypted it yet), so unlike a stored booking's it is seeded.
    expect(within(dialog).getByLabelText("Confirmation #")).toHaveValue("TRIP90");
    expect(within(dialog).getByLabelText("Airline")).toHaveValue("Delta");
    expect(within(dialog).getByLabelText("Flight number")).toHaveValue("2586");
    expect(within(dialog).getByLabelText("Location")).toHaveValue("Stuttgart, Germany");
    expect(within(dialog).getByLabelText("Cost")).toHaveValue("425.00");
    // 22:00Z on the 21st is 16:00 in Denver, which is what the ticket says.
    expect(within(dialog).getByLabelText("Start date")).toHaveValue("2026-10-21");
    expect(within(dialog).getByLabelText("Start time")).toHaveValue("16:00");

    // A draft has neither of these yet: travellers are matched by the accept,
    // and pending/accepted/dismissed is not Planned/Booked.
    expect(within(dialog).queryByLabelText("Who's on it")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Status")).not.toBeInTheDocument();
  });

  it("saves the correction to the draft and reloads the queue", async () => {
    const { pending, updateDraft } = setup([draft()]);
    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByRole("button", { name: "Edit Flight DL2586" }));

    const title = screen.getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "Delta 2586");
    const confirmation = screen.getByLabelText("Confirmation #");
    await userEvent.clear(confirmation);
    await userEvent.type(confirmation, "ABC123");
    await userEvent.clear(screen.getByLabelText("Cost"));
    await userEvent.type(screen.getByLabelText("Cost"), "510.00");
    await userEvent.click(screen.getByRole("button", { name: "Save import" }));

    await waitFor(() => expect(updateDraft).toHaveBeenCalledTimes(1));
    expect(updateDraft).toHaveBeenCalledWith("DL2586", expect.objectContaining({
      kind: "flight",
      title: "Delta 2586",
      confirmationNumber: "ABC123",
      costCents: 51_000,
      location: "Stuttgart, Germany",
      startsAt: "2026-10-21T22:00:00.000Z",
      startsAtTz: "America/Denver",
      // The per-kind record travels with the edit, so the accept commits the
      // corrected details rather than the extractor's.
      details: expect.objectContaining({
        carrier: "Delta",
        flightNumber: "2586",
        originIata: "DEN",
      }),
    }));

    // The queue is reloaded, not patched in place: an edit changes which trip
    // is suggested and what the draft looks like a duplicate of.
    await waitFor(() => expect(pending).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Edit import" })).not.toBeInTheDocument();
  });

  it("keeps the dialog open with the server's message when the edit is refused", async () => {
    const pending = vi.fn(async () => [draft()]);
    const updateDraft = vi.fn(async () => {
      throw new Error("startsAt requires startsAtTz (an IANA timezone)");
    });
    const api = {
      imports: { pending, accept: vi.fn(), createTrip: vi.fn(), dismiss: vi.fn(), updateDraft },
      trips: { list: vi.fn(async () => [EUROPE]) },
    };
    render(<ImportReviewQueue api={api as never} />);

    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByRole("button", { name: "Edit Flight DL2586" }));
    await userEvent.click(screen.getByRole("button", { name: "Save import" }));

    await waitFor(() => expect(updateDraft).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "Edit import" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(pending).toHaveBeenCalledTimes(1);
  });

  it("offers no edit affordance to a viewer", async () => {
    const api = {
      imports: {
        pending: vi.fn(async () => [draft()]),
        accept: vi.fn(),
        createTrip: vi.fn(),
        dismiss: vi.fn(),
        updateDraft: vi.fn(),
      },
      trips: { list: vi.fn(async () => [EUROPE]) },
    };
    render(
      <IdentityProvider
        api={{
          me: vi.fn(async () => ({
            userId: "u2",
            email: "viewer@example.com",
            householdId: "hh-a",
            role: "viewer",
          })),
        } as never}
      >
        <ImportReviewQueue api={api as never} />
      </IdentityProvider>,
    );

    await screen.findByText("Flight DL2586");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Edit Flight DL2586" }))
        .not.toBeInTheDocument(),
    );
  });
});

describe("ImportReviewQueue — the trip picker", () => {
  function optionsOf(): string[] {
    return within(screen.getByLabelText("Existing trip for selected imports"))
      .getAllByRole("option")
      .map((option) => option.textContent ?? "");
  }

  it("leaves the API's order alone until something is selected", async () => {
    setup([draft()], [CITY_BREAK, SOMEDAY, EUROPE]);
    await screen.findByText("Flight DL2586");
    expect(optionsOf()).toEqual(["Choose a trip", "Autumn city break", "Someday", "Europe"]);
  });

  it("orders by date proximity, then location, and says why", async () => {
    setup([draft()], [CITY_BREAK, SOMEDAY, EUROPE]);
    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByLabelText("Select Flight DL2586"));

    expect(optionsOf()).toEqual([
      "Choose a trip",
      // Oct 21–22 sits inside Oct 20–30, and "Stuttgart, Germany" is Germany.
      "Europe — covers these dates · same destination",
      "Autumn city break — ends 2 days before",
      // No dates at all ranks last however it is named.
      "Someday — no dates",
    ]);
  });

  it("never shows a day count out of order with the option above it", async () => {
    // Regression, from browser QA of this branch: past a month every gap
    // scores 0, so the far-away trips used to sit in API order and the picker
    // read "ends 2 days before / ends 103 days before / starts 67 days
    // later" — correct arithmetic that reads as a broken feature.
    const july = draft({ location: "DEN → AMS", localStartsOn: "2026-07-30", localEndsOn: "2026-07-30" });
    setup([july], [
      trip({ id: "t-ams", title: "Amsterdam spring", startsOn: "2026-04-10", endsOn: "2026-04-18" }),
      trip({ id: "t-someday", title: "Someday list" }),
      trip({ id: "t-crawl", title: "Tokyo food crawl", startsOn: "2026-10-18", endsOn: "2026-10-28" }),
      trip({ id: "t-maui", title: "Maui summer week", startsOn: "2026-07-21", endsOn: "2026-07-28" }),
      trip({ id: "t-tokyo", title: "Tokyo in autumn", startsOn: "2026-10-05", endsOn: "2026-10-15" }),
    ]);

    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByLabelText("Select Flight DL2586"));

    expect(optionsOf()).toEqual([
      "Choose a trip",
      "Maui summer week — ends 2 days before",
      "Tokyo in autumn — starts 67 days later",
      "Tokyo food crawl — starts 80 days later",
      "Amsterdam spring — ends 103 days before",
      "Someday list — no dates",
    ]);
  });

  it("scores a multi-draft selection against its combined range", async () => {
    // Neither draft names a place either trip does, so dates alone decide.
    const flight = draft({ location: "DEN → AMS" });
    const stay = draft({
      id: "KOA",
      inboundEmailId: "email-hotel",
      kind: "lodging",
      title: "Hotel Stuttgart",
      location: "Königstraße 1",
      localStartsOn: "2026-10-22",
      localEndsOn: "2026-10-26",
      details: { propertyName: "Hotel Stuttgart" },
    });
    // Contains the flight alone, but not the stay that follows it.
    const flightOnly = trip({
      id: "trip-day",
      title: "Day trip",
      startsOn: "2026-10-21",
      endsOn: "2026-10-22",
    });
    setup([flight, stay], [flightOnly, EUROPE]);

    await screen.findByText("Flight DL2586");
    await userEvent.click(screen.getByLabelText("Select Flight DL2586"));
    // Both contain one flight's day, so the tie keeps the API's order.
    expect(optionsOf()).toEqual([
      "Choose a trip",
      "Day trip — covers these dates",
      "Europe — covers these dates",
    ]);

    // Adding the stay widens the selection to Oct 21–26, which only Europe
    // still holds — the union, not each draft judged on its own.
    await userEvent.click(screen.getByLabelText("Select Hotel Stuttgart"));
    expect(optionsOf()).toEqual([
      "Choose a trip",
      "Europe — covers these dates",
      "Day trip — dates overlap",
    ]);
  });
});
