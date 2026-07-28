import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DuplicatesCard } from "../../../src/client/trip/DuplicatesCard.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import { ApiError } from "../../../src/client/api/client.js";

const PEOPLE = [{ id: "p1", displayName: "Badger" }];

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    tripId: "t1",
    sourceInboundEmailId: null,
    kind: "flight",
    title: "Delta 1423 SEA-JFK",
    location: null,
    startsAt: "2026-09-04T14:30:00.000Z",
    startsAtTz: "America/Los_Angeles",
    endsAt: null,
    endsAtTz: null,
    confirmationNumberMasked: null,
    costCents: null,
    pointsUsed: null,
    pointsProgram: null,
    status: "planned",
    details: {},
    personIds: [],
    ...over,
  };
}

const GROUP = {
  reason: "confirmation" as const,
  confidence: "high" as const,
  suggestedKeepId: "b2",
  bookings: [
    booking({ id: "b1", title: "DL1423" }),
    booking({ id: "b2", confirmationNumberMasked: "••••7T2Q", costCents: 41_200 }),
  ],
};

function makeApi(groups: unknown[] = [GROUP]) {
  return {
    trips: {
      duplicates: vi.fn(async () => ({ groups })),
      mergeDuplicates: vi.fn(async () => booking()),
      dismissDuplicates: vi.fn(async () => undefined),
    },
  };
}

function renderCard(
  api: ReturnType<typeof makeApi> | Record<string, unknown> = makeApi(),
  onResolved = vi.fn(),
  role: "owner" | "viewer" = "owner",
) {
  const me = vi.fn(async () => ({ userId: "u1", email: "x@example.com", householdId: "hh", role }));
  const result = render(
    <IdentityProvider api={{ me } as never}>
      <DuplicatesCard
        tripId="t1"
        people={PEOPLE as never}
        api={api as never}
        onResolved={onResolved}
      />
    </IdentityProvider>,
  );
  return { ...result, onResolved };
}

async function openReview(api = makeApi(), onResolved = vi.fn()) {
  const rendered = renderCard(api, onResolved);
  await userEvent.click(await screen.findByRole("button", { name: /review duplicates/i }));
  return rendered;
}

describe("DuplicatesCard", () => {
  it("renders nothing when the trip has no duplicates", async () => {
    const { container } = renderCard(makeApi([]));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing when the api has no duplicates endpoint", async () => {
    // The same progressive-enhancement guard the itinerary strip uses: a
    // partial api stub must not throw.
    const { container } = renderCard({ trips: {} });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing when detection fails", async () => {
    const api = { trips: { duplicates: vi.fn(async () => { throw new Error("boom"); }) } };
    const { container } = renderCard(api);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("announces the duplicate and names the matching rule", async () => {
    renderCard();
    expect(await screen.findByRole("status")).toHaveTextContent(/looks like a duplicate import/i);
    await userEvent.click(screen.getByRole("button", { name: /review duplicates/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/same confirmation number/i);
  });

  it("shows what actually differs between the two rows", async () => {
    await openReview();
    const dialog = screen.getByRole("dialog");
    // The cost and the confirmation number are the whole reason to merge
    // rather than delete one at random, so both have to be on screen.
    expect(dialog).toHaveTextContent(/••••7T2Q/);
    expect(dialog).toHaveTextContent(/\$412\.00/);
    expect(dialog).toHaveTextContent(/DL1423/);
  });

  it("pre-selects the server's suggested keeper", async () => {
    await openReview();
    const options = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(options).toHaveLength(2);
    expect(options[1]?.checked).toBe(true);
    expect(options[0]?.checked).toBe(false);
  });

  it("merges the others into the selected booking and refreshes the trip", async () => {
    const api = makeApi();
    const { onResolved } = await openReview(api);

    await userEvent.click(screen.getByRole("button", { name: /keep selected, merge 1 other/i }));
    await waitFor(() => expect(api.trips.mergeDuplicates).toHaveBeenCalledWith("t1", "b2", ["b1"]));
    expect(onResolved).toHaveBeenCalled();
    // Detection re-runs, so a resolved group cannot linger on screen.
    expect(api.trips.duplicates).toHaveBeenCalledTimes(2);
  });

  it("merges into whichever booking the household picks instead", async () => {
    const api = makeApi();
    await openReview(api);

    await userEvent.click(screen.getAllByRole("radio")[0]!);
    await userEvent.click(screen.getByRole("button", { name: /keep selected, merge 1 other/i }));
    await waitFor(() => expect(api.trips.mergeDuplicates).toHaveBeenCalledWith("t1", "b1", ["b2"]));
  });

  it("records a false positive without deleting anything", async () => {
    const api = makeApi();
    const { onResolved } = await openReview(api);

    await userEvent.click(screen.getByRole("button", { name: /not duplicates/i }));
    await waitFor(() => expect(api.trips.dismissDuplicates).toHaveBeenCalledWith("t1", ["b1", "b2"]));
    expect(api.trips.mergeDuplicates).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalled();
  });

  it("flags a medium-confidence group as one that might not be a duplicate", async () => {
    await openReview(
      makeApi([{ ...GROUP, reason: "same-slot", confidence: "medium" }]),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/same place and time/i);
    expect(dialog).toHaveTextContent(/might not be/i);
  });

  it("keeps two groups' keeper selections independent", async () => {
    await openReview(
      makeApi([
        GROUP,
        {
          ...GROUP,
          suggestedKeepId: "b4",
          bookings: [booking({ id: "b3", title: "Hertz SFO" }), booking({ id: "b4", title: "Hertz - SFO" })],
        },
      ]),
    );
    const groups = screen.getAllByRole("region");
    // Picking a keeper in the second group must not clear the first, which is
    // what a shared radio `name` would do.
    await userEvent.click(within(groups[1]!).getAllByRole("radio")[0]!);
    expect((within(groups[0]!).getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
    expect((within(groups[1]!).getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
  });

  it("reports a failed merge instead of silently re-enabling the button", async () => {
    const api = makeApi();
    // The 404 a second tab produces by resolving the same group first.
    api.trips.mergeDuplicates = vi.fn(async () => {
      throw new ApiError("/api/trips/t1/duplicates/merge failed: not found", 404);
    });
    await openReview(api);
    await userEvent.click(screen.getByRole("button", { name: /keep selected, merge 1 other/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer here/i);
  });

  it("tells a viewer about the duplicate but offers no control they cannot use", async () => {
    renderCard(makeApi(), vi.fn(), "viewer");
    expect(await screen.findByRole("status")).toHaveTextContent(/duplicate import/i);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /review duplicates/i })).toBeNull(),
    );
  });
});
