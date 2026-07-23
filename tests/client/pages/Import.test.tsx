import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Import } from "../../../src/client/pages/Import.js";
import { ApiError } from "../../../src/client/api/client.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { DraftBooking, Identity, ImportQueueGroup } from "../../../src/client/api/types.js";

function draft(over: Partial<DraftBooking> = {}): DraftBooking {
  return {
    id: "d1",
    inboundEmailId: "e1",
    kind: "other",
    title: "Delta 2214 BOI to STS",
    location: "Boise Airport",
    startsAt: "2026-10-09T15:40:00.000Z",
    startsAtTz: "America/Boise",
    endsAt: "2026-10-09T19:55:00.000Z",
    endsAtTz: "America/Los_Angeles",
    confirmationNumber: "D7WN88",
    source: "ai",
    extracted: { costCents: 61240, details: {} },
    status: "pending",
    bookingId: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    resolvedAt: null,
    ...over,
  };
}

const EMAIL = {
  id: "e1",
  from: "delta@delta.com",
  subject: "Your flight receipt",
  receivedAt: "2026-07-20T10:00:00.000Z",
};

function groups(): ImportQueueGroup[] {
  return [{ email: { ...EMAIL }, drafts: [draft()] }];
}

const TRIPS = [
  { id: "t1", title: "Guerneville", destination: null, startsOn: null, endsOn: null, status: "planning" as const, notes: null },
  { id: "t2", title: "Tokyo", destination: null, startsOn: null, endsOn: null, status: "planning" as const, notes: null },
];

function makeApi(over: Record<string, unknown> = {}) {
  return {
    import: {
      queue: vi.fn(async () => groups()),
      email: vi.fn(async () => ({
        ...EMAIL,
        to: "trips@badgerops.foo",
        messageId: null,
        raw: "Subject: Your flight receipt\r\n\r\nDelta 2214 BOI-STS RAW-BODY",
        status: "extracted",
        error: null,
      })),
      updateDraft: vi.fn(async (id: string, input: Record<string, unknown>) => ({
        ...draft(),
        ...input,
        id,
      })),
      acceptDraft: vi.fn(async (id: string, input: { tripId?: string; newTrip?: { title: string } }) => ({
        draft: draft({ id, status: "accepted", bookingId: "b1" }),
        booking: { id: "b1", tripId: input.tripId ?? "t-new" },
        trip: input.tripId
          ? TRIPS.find((t) => t.id === input.tripId)!
          : { ...TRIPS[0]!, id: "t-new", title: input.newTrip?.title ?? "New trip" },
      })),
      dismissDraft: vi.fn(async (id: string) => draft({ id, status: "dismissed" })),
      ...over,
    },
    trips: { list: vi.fn(async () => TRIPS) },
    people: { list: vi.fn(async () => [{ id: "p1", displayName: "Ava" }]) },
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

function renderImport(api = makeApi(), role: Identity["role"] = "owner") {
  asRole(role, <Import api={api as never} />);
  return api;
}

describe("Import", () => {
  it("renders the pending queue grouped under its source email", async () => {
    renderImport();
    const section = await screen.findByRole("region", { name: "Your flight receipt" });
    expect(within(section).getByText("Delta 2214 BOI to STS")).toBeInTheDocument();
    expect(within(section).getByText(/from delta@delta\.com/)).toBeInTheDocument();
    // Extracted fields on the card: confirmation number (plaintext by
    // design pre-accept), location, carried cost.
    expect(within(section).getByText(/D7WN88/)).toBeInTheDocument();
    expect(within(section).getByText("Boise Airport")).toBeInTheDocument();
    expect(within(section).getByText("$612.40")).toBeInTheDocument();
  });

  it("shows an honest empty state when nothing is pending", async () => {
    const api = makeApi({ queue: vi.fn(async () => []) });
    renderImport(api);
    expect(await screen.findByText(/nothing waiting for review/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than looking like inbox zero", async () => {
    const api = makeApi({
      queue: vi.fn(async () => {
        throw new ApiError("/api/import/queue failed: boom", 500);
      }),
    });
    renderImport(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/nothing waiting for review/i)).not.toBeInTheDocument();
  });

  it("offers a viewer no write affordances — the queue is read-only for them", async () => {
    renderImport(makeApi(), "viewer");
    await screen.findByText("Delta 2214 BOI to STS");
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^dismiss delta/i })).not.toBeInTheDocument();
    // Reading the original message is not a write.
    expect(screen.getByRole("button", { name: /view original/i })).toBeInTheDocument();
  });

  it("shows the original message text on demand", async () => {
    const api = renderImport();
    await userEvent.click(await screen.findByRole("button", { name: /view original/i }));
    expect(await screen.findByText(/RAW-BODY/)).toBeInTheDocument();
    expect(api.import.email).toHaveBeenCalledWith("e1");
  });

  it("dismisses a draft and the queue reflects it without a reload", async () => {
    const api = renderImport();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss Delta 2214 BOI to STS" }));
    expect(api.import.dismissDraft).toHaveBeenCalledWith("d1");
    await waitFor(() => {
      expect(screen.queryByText("Delta 2214 BOI to STS")).not.toBeInTheDocument();
    });
    // The last pending draft is gone, so the empty state takes over.
    expect(screen.getByText(/nothing waiting for review/i)).toBeInTheDocument();
  });

  it("keeps the draft in the queue when a dismiss is rejected", async () => {
    const api = makeApi({
      dismissDraft: vi.fn(async () => {
        throw new ApiError("/api/import/drafts/d1/dismiss failed: Forbidden", 403);
      }),
    });
    renderImport(api);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss Delta 2214 BOI to STS" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Delta 2214 BOI to STS")).toBeInTheDocument();
  });

  it("accepts a draft onto an existing trip", async () => {
    const api = renderImport();
    await userEvent.click(await screen.findByRole("button", { name: "Accept Delta 2214 BOI to STS" }));
    // Existing-trip mode is the default; pick the second trip to prove the
    // selection is sent, then submit.
    await userEvent.selectOptions(await screen.findByLabelText("Trip"), "t2");
    await userEvent.click(screen.getByRole("button", { name: "Accept draft" }));
    await waitFor(() => {
      expect(api.import.acceptDraft).toHaveBeenCalledWith("d1", { tripId: "t2" });
    });
    await waitFor(() => {
      expect(screen.queryByText("Delta 2214 BOI to STS")).not.toBeInTheDocument();
    });
  });

  it("accepts a draft as a new trip seeded from the draft's destination and dates", async () => {
    const api = renderImport();
    await userEvent.click(await screen.findByRole("button", { name: "Accept Delta 2214 BOI to STS" }));
    await userEvent.click(await screen.findByRole("radio", { name: "New trip" }));
    // Prefilled from the draft: destination from its location, startsOn from
    // its start IN ITS OWN ZONE (15:40Z = Oct 9 in Boise), endsOn likewise.
    expect(screen.getByLabelText("Trip title")).toHaveValue("Trip to Boise Airport");
    expect(screen.getByLabelText("Destination")).toHaveValue("Boise Airport");
    expect(screen.getByLabelText("Starts on")).toHaveValue("2026-10-09");
    await userEvent.click(screen.getByRole("button", { name: "Accept draft" }));
    await waitFor(() => {
      expect(api.import.acceptDraft).toHaveBeenCalledWith("d1", {
        newTrip: {
          title: "Trip to Boise Airport",
          destination: "Boise Airport",
          startsOn: "2026-10-09",
          endsOn: "2026-10-09",
        },
      });
    });
  });

  it("sends the chosen travellers with the accept", async () => {
    const api = renderImport();
    await userEvent.click(await screen.findByRole("button", { name: "Accept Delta 2214 BOI to STS" }));
    await userEvent.click(await screen.findByRole("button", { name: /ava/i }));
    await userEvent.click(screen.getByRole("button", { name: "Accept draft" }));
    await waitFor(() => {
      expect(api.import.acceptDraft).toHaveBeenCalledWith("d1", {
        tripId: "t1",
        personIds: ["p1"],
      });
    });
  });

  it("keeps the dialog and the reviewer's choices when an accept is rejected", async () => {
    const api = makeApi({
      acceptDraft: vi.fn(async () => {
        throw new ApiError("/api/import/drafts/d1/accept failed: Invalid", 400);
      }),
    });
    renderImport(api);
    await userEvent.click(await screen.findByRole("button", { name: "Accept Delta 2214 BOI to STS" }));
    await userEvent.selectOptions(await screen.findByLabelText("Trip"), "t2");
    await userEvent.click(screen.getByRole("button", { name: "Accept draft" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Trip")).toHaveValue("t2");
  });

  it("edits a draft — the correction shows on the card without a reload", async () => {
    const api = renderImport();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Delta 2214 BOI to STS" }));

    // Every extracted field is on the form, prefilled — including the
    // timestamps as wall-clock time in the draft's own zone.
    expect(await screen.findByLabelText("Confirmation #")).toHaveValue("D7WN88");
    expect(screen.getByLabelText("Kind")).toHaveValue("other");
    expect(screen.getByLabelText("Departs / starts")).toHaveValue("2026-10-09T09:40");
    expect(screen.getByLabelText("Departs timezone")).toHaveValue("America/Boise");

    const conf = screen.getByLabelText("Confirmation #");
    await userEvent.clear(conf);
    await userEvent.type(conf, "XYZ999");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(api.import.updateDraft).toHaveBeenCalledWith(
        "d1",
        expect.objectContaining({
          confirmationNumber: "XYZ999",
          kind: "other",
          title: "Delta 2214 BOI to STS",
          startsAt: "2026-10-09T15:40:00.000Z",
          startsAtTz: "America/Boise",
        }),
      );
    });
    // The card reflects the server's answer in place.
    expect(await screen.findByText(/XYZ999/)).toBeInTheDocument();
    expect(screen.queryByText(/D7WN88/)).not.toBeInTheDocument();
  });

  it("keeps the reviewer's typed values when a save is rejected", async () => {
    const api = makeApi({
      updateDraft: vi.fn(async () => {
        throw new ApiError("/api/import/drafts/d1 failed: Invalid draft update", 400);
      }),
    });
    renderImport(api);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Delta 2214 BOI to STS" }));
    const conf = await screen.findByLabelText("Confirmation #");
    await userEvent.clear(conf);
    await userEvent.type(conf, "XYZ999");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(conf).toHaveValue("XYZ999");
  });
});
