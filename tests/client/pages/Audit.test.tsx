import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Audit } from "../../../src/client/pages/Audit.js";
import type { AuditEntry } from "../../../src/client/api/types.js";

function entry(over: Partial<AuditEntry> & Pick<AuditEntry, "id" | "event">): AuditEntry {
  return {
    actorUserId: "u1",
    actorEmail: "owner@example.com",
    subjectType: "person",
    subjectId: "person-000000aa",
    field: null,
    tripId: null,
    selfService: false,
    fields: null,
    at: "2026-07-30T12:00:00.000Z",
    ...over,
  };
}

function makeApi(pages: { entries: AuditEntry[]; nextCursor: string | null }[]) {
  const activity = vi.fn(async () => pages.shift() ?? { entries: [], nextCursor: null });
  return { audit: { activity } } as never;
}

function onePage(entries: AuditEntry[]) {
  return makeApi([{ entries, nextCursor: null }]);
}

describe("Audit", () => {
  it("renders a readable sentence for every event type", async () => {
    const api = onePage([
      entry({
        id: "a1",
        event: "document_reveal",
        field: "passport_number",
        actorEmail: "owner@example.com",
      }),
      entry({
        id: "a2",
        event: "confirmation_reveal",
        subjectType: "booking",
        field: "confirmation_number",
        subjectId: "booking-11112222",
      }),
      entry({ id: "a3", event: "person_created" }),
      entry({ id: "a4", event: "person_updated", fields: ["phone", "passport_number"] }),
      entry({
        id: "a5",
        event: "member_invited",
        subjectType: "household_member",
        subjectId: "user-33334444",
      }),
      entry({
        id: "a6",
        event: "member_role_changed",
        subjectType: "household_member",
        subjectId: "user-33334444",
        fields: ["role"],
      }),
    ]);
    render(<Audit api={api} />);

    const list = within(await screen.findByRole("list", { name: "Household activity" }));
    expect(
      list.getByText(/owner@example\.com revealed the passport number on somebody else's record/),
    ).toBeInTheDocument();
    expect(
      list.getByText(/revealed the confirmation number on a booking/),
    ).toBeInTheDocument();
    expect(list.getByText(/added a person to the household/)).toBeInTheDocument();
    // The field NAMES, joined into prose — never a value.
    expect(
      list.getByText(/changed the phone and passport number on somebody else's record/),
    ).toBeInTheDocument();
    expect(list.getByText(/invited someone to the household/)).toBeInTheDocument();
    expect(list.getByText(/changed what someone in the household may do/)).toBeInTheDocument();
  });

  it("says whose record it was, and marks self-service entries", async () => {
    const api = onePage([
      entry({ id: "s1", event: "document_reveal", field: "passport_number", selfService: true }),
      entry({ id: "o1", event: "document_reveal", field: "passport_number" }),
    ]);
    render(<Audit api={api} />);

    const items = within(await screen.findByRole("list", { name: "Household activity" })).getAllByRole(
      "listitem",
    );
    const self = items.find((li) => li.dataset.self === "true")!;
    const other = items.find((li) => li.dataset.self === "false")!;

    expect(within(self).getByText(/on their own record/)).toBeInTheDocument();
    expect(within(self).getByText("Own record")).toBeInTheDocument();
    // The distinction is carried by a class as well as a tag, so the row
    // recedes visually and not only for a screen reader.
    expect(self.className).toContain("activity-item--self");

    expect(within(other).getByText(/on somebody else's record/)).toBeInTheDocument();
    expect(within(other).getByText("Someone else's")).toBeInTheDocument();
    expect(other.className).not.toContain("activity-item--self");
  });

  it("filters self-service entries out, and back in again", async () => {
    const user = userEvent.setup();
    const api = onePage([
      entry({ id: "s1", event: "document_reveal", field: "passport_number", selfService: true }),
      entry({ id: "o1", event: "document_reveal", field: "known_traveler_number" }),
    ]);
    render(<Audit api={api} />);
    await screen.findByRole("list", { name: "Household activity" });

    const toggle = screen.getByRole("button", { name: "Only other people's records" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/on their own record/)).not.toBeInTheDocument();
    expect(screen.getByText(/revealed the known traveler number/)).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText(/on their own record/)).toBeInTheDocument();
  });

  it("explains an empty log, and an empty filtered view differently", async () => {
    const { unmount } = render(<Audit api={onePage([])} />);
    expect(await screen.findByText("Nothing has happened yet")).toBeInTheDocument();
    unmount();

    const user = userEvent.setup();
    render(
      <Audit
        api={onePage([
          entry({ id: "s1", event: "person_updated", fields: ["phone"], selfService: true }),
        ])}
      />,
    );
    await screen.findByRole("list", { name: "Household activity" });
    await user.click(screen.getByRole("button", { name: "Only other people's records" }));
    expect(screen.getByText("Nothing but your own records")).toBeInTheDocument();
  });

  it("pages with the server's cursor and appends, then reports the end", async () => {
    const api = makeApi([
      { entries: [entry({ id: "a1", event: "person_created" })], nextCursor: "cur-1" },
      { entries: [entry({ id: "a2", event: "member_invited" })], nextCursor: null },
    ]);
    const user = userEvent.setup();
    render(<Audit api={api} />);
    await screen.findByText(/added a person to the household/);

    await user.click(screen.getByRole("button", { name: "Show older" }));
    // Appended, not replaced: the first page is still on screen.
    expect(screen.getByText(/added a person to the household/)).toBeInTheDocument();
    expect(screen.getByText(/invited someone to the household/)).toBeInTheDocument();

    const activity = (api as unknown as { audit: { activity: ReturnType<typeof vi.fn> } }).audit
      .activity;
    expect(activity).toHaveBeenNthCalledWith(1, { limit: 50 });
    expect(activity).toHaveBeenNthCalledWith(2, { limit: 50, cursor: "cur-1" });

    expect(screen.queryByRole("button", { name: "Show older" })).not.toBeInTheDocument();
    expect(screen.getByText("That is the whole log.")).toBeInTheDocument();
  });

  it("states that values are never stored, and never renders one", async () => {
    render(
      <Audit
        api={onePage([
          entry({ id: "a1", event: "document_reveal", field: "passport_number" }),
        ])}
      />,
    );
    await screen.findByRole("list", { name: "Household activity" });
    expect(screen.getByText("Revealed values are never stored in this log.")).toBeInTheDocument();
  });

  it("reports a failed load instead of sitting on Loading…", async () => {
    const api = { audit: { activity: vi.fn(async () => { throw new Error("boom"); }) } } as never;
    render(<Audit api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Something went wrong/);
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});
