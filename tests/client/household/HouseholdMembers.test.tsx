import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HouseholdMembers } from "../../../src/client/household/HouseholdMembers.js";
import { ApiError } from "../../../src/client/api/client.js";
import type { HouseholdMember } from "../../../src/client/api/types.js";

const ONBOARDED: HouseholdMember = {
  personId: "p-owner",
  displayName: "Badger",
  email: "badger@example.com",
  userId: "u-owner",
  role: "owner",
  claimed: true,
  status: "onboarded",
};

const INVITED: HouseholdMember = {
  personId: "p-partner",
  displayName: "Robin",
  email: "robin@example.com",
  userId: "u-partner",
  role: "admin",
  claimed: false,
  status: "invited",
};

const UNCLAIMED: HouseholdMember = {
  personId: "p-kid",
  displayName: "Wren",
  email: null,
  userId: null,
  role: null,
  claimed: false,
  status: "unclaimed",
};

const GUEST: HouseholdMember = {
  personId: null,
  displayName: null,
  email: "weekend@example.com",
  userId: "u-guest",
  role: "viewer",
  claimed: false,
  status: "guest",
};

const ROSTER = [ONBOARDED, INVITED, UNCLAIMED, GUEST];

function makeApi(members: HouseholdMember[] = ROSTER) {
  return {
    household: {
      members: vi.fn(async () => members),
      invite: vi.fn(async () => ({
        ...INVITED,
        personId: "p-new",
        displayName: "New Person",
        email: "new@example.com",
        userId: "u-new",
        role: "viewer" as const,
      })),
      setRole: vi.fn(async () => ({ ...INVITED, role: "viewer" as const })),
    },
  };
}

function renderMembers(api = makeApi(), role = "owner") {
  render(<HouseholdMembers api={api as never} role={role} />);
  return api;
}

function rowFor(status: string) {
  return screen
    .getAllByRole("listitem")
    .find((li) => li.dataset.status === status)!;
}

describe("HouseholdMembers", () => {
  it("renders all four statuses, distinguishably", async () => {
    renderMembers();
    await screen.findByRole("list", { name: "Household roster" });

    for (const status of ["onboarded", "invited", "unclaimed", "guest"]) {
      expect(rowFor(status)).toBeDefined();
      // A class per status, so the states differ to the eye and not only in
      // their wording.
      expect(rowFor(status).className).toContain(`member-row--${status}`);
    }

    expect(within(rowFor("onboarded")).getByText("Signed in")).toBeInTheDocument();
    // The single most useful thing on this screen.
    expect(within(rowFor("invited")).getByText("Not signed in yet")).toBeInTheDocument();
    expect(within(rowFor("unclaimed")).getByText("No account")).toBeInTheDocument();
    expect(within(rowFor("guest")).getByText("Trip guest")).toBeInTheDocument();
  });

  it("lists a trip guest rather than hiding them", async () => {
    renderMembers();
    await screen.findByRole("list", { name: "Household roster" });
    const guest = within(rowFor("guest"));
    // No person row, so no display name — the address is the only handle
    // there is, and it has to be shown or the row names nobody.
    expect(guest.getByText("weekend@example.com")).toBeInTheDocument();
    expect(guest.getByText(/single shared trip/)).toBeInTheDocument();
  });

  it("says out loud that inviting sends nothing", async () => {
    renderMembers();
    await screen.findByRole("list", { name: "Household roster" });
    expect(screen.getByRole("note")).toHaveTextContent(/does not send anything/i);
    expect(screen.getByRole("note")).toHaveTextContent(/Cloudflare Access/);
  });

  it("invites an email with a role and an optional name, and adds the row", async () => {
    const user = userEvent.setup();
    const api = renderMembers();
    await screen.findByRole("list", { name: "Household roster" });

    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Name (optional)"), "New Person");
    await user.selectOptions(screen.getByLabelText("Role"), "viewer");
    await user.click(screen.getByRole("button", { name: /Invite/ }));

    expect(api.household.invite).toHaveBeenCalledWith({
      email: "new@example.com",
      role: "viewer",
      displayName: "New Person",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/new@example\.com is in the household/);
    expect(screen.getByText("New Person")).toBeInTheDocument();
  });

  it("omits displayName entirely when the name is left blank", async () => {
    const user = userEvent.setup();
    const api = renderMembers();
    await screen.findByRole("list", { name: "Household roster" });

    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: /Invite/ }));

    // Not `displayName: ""` — the server falls back to the email's local part
    // only when the key is absent.
    expect(api.household.invite).toHaveBeenCalledWith({
      email: "new@example.com",
      role: "viewer",
    });
  });

  it("shows the server's own words when an invite is refused", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.household.invite = vi.fn(async () => {
      throw new ApiError("POST /api/household/members", 400, "Enter a valid email address");
    }) as never;
    renderMembers(api);
    await screen.findByRole("list", { name: "Household roster" });

    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: /Invite/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address");
  });

  it("promotes and demotes through setRole", async () => {
    const user = userEvent.setup();
    const api = renderMembers();
    await screen.findByRole("list", { name: "Household roster" });

    await user.selectOptions(screen.getByLabelText("Role for Robin"), "viewer");
    expect(api.household.setRole).toHaveBeenCalledWith("u-partner", "viewer");
  });

  /* The refusal that is worth showing verbatim: it explains why (a household
     must never be left without an owner) and what to do instead (the other
     owner does it). "That didn't work" would throw both away. */
  it("shows the refusal when an owner tries to change their own role", async () => {
    const user = userEvent.setup();
    const message =
      "You cannot change your own role. Another owner has to do it, so a household is never left without one.";
    const api = makeApi([{ ...INVITED, role: "admin" }]);
    api.household.setRole = vi.fn(async () => {
      throw new ApiError("PUT role", 400, message);
    }) as never;
    renderMembers(api);
    await screen.findByRole("list", { name: "Household roster" });

    await user.selectOptions(screen.getByLabelText("Role for Robin"), "viewer");
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("offers no role control for an owner, or for a row with no account", async () => {
    renderMembers();
    await screen.findByRole("list", { name: "Household roster" });

    // Demoting an owner is a transfer of the household; the server refuses it,
    // so no control is offered for it.
    expect(screen.queryByLabelText("Role for Badger")).not.toBeInTheDocument();
    expect(within(rowFor("onboarded")).getByText("Owner")).toBeInTheDocument();
    // An unclaimed person is not a member of anything yet — there is no
    // household_member row to set a role on.
    expect(screen.queryByLabelText("Role for Wren")).not.toBeInTheDocument();
  });

  it("shows an admin the roster and none of the owner-only controls", async () => {
    renderMembers(makeApi(), "admin");
    await screen.findByRole("list", { name: "Household roster" });

    expect(screen.getByText("Robin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Invite/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Robin")).not.toBeInTheDocument();
    // The role is still reported, just not editable.
    expect(within(rowFor("invited")).getByText("Admin")).toBeInTheDocument();
  });

  it("reports a failed load instead of an empty household", async () => {
    const api = makeApi();
    api.household.members = vi.fn(async () => {
      throw new ApiError("GET /api/household/members", 403);
    }) as never;
    renderMembers(api);

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not have permission/);
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});
