import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Shell } from "../../src/client/components/Shell.js";

function renderAt(path: string, identity?: { email: string; role: string }) {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <Shell identity={identity as never}>
        <p>page content</p>
      </Shell>
    </Router>,
  );
}

describe("Shell", () => {
  it("renders the brand and the primary nav links", () => {
    renderAt("/");
    expect(screen.getByText("Travel HQ")).toBeInTheDocument();
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    for (const label of ["Today", "Trips", "Checklist", "You", "Cards", "Settings"]) {
      expect(nav.getByRole("link", { name: label })).toBeInTheDocument();
    }
    // The roster moved into Settings; nothing may still point at /people.
    expect(nav.queryByRole("link", { name: "People" })).not.toBeInTheDocument();
  });

  it("renders the mobile tab bar links", () => {
    renderAt("/");
    const tabs = within(screen.getByRole("navigation", { name: "Tabs" }));
    for (const label of ["Today", "Trips", "Import", "Checklist", "You"]) {
      expect(tabs.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(tabs.queryByRole("link", { name: "People" })).not.toBeInTheDocument();
  });

  it("points You at /me in both navs", () => {
    renderAt("/me");
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: "You" })).toHaveAttribute("href", "/me");
    expect(nav.getByRole("link", { name: "You" })).toHaveAttribute("aria-current", "page");
    const tabs = within(screen.getByRole("navigation", { name: "Tabs" }));
    expect(tabs.getByRole("link", { name: "You" })).toHaveAttribute("href", "/me");
  });

  it("marks the current route as the active page", () => {
    renderAt("/trips");
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: "Trips" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("link", { name: "Today" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("keeps the Trips tab lit on a trip-detail route (prefix match)", () => {
    renderAt("/trips/abc123");
    const tabs = within(screen.getByRole("navigation", { name: "Tabs" }));
    expect(tabs.getByRole("link", { name: "Trips" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(tabs.getByRole("link", { name: "Today" })).not.toHaveAttribute(
      "aria-current",
    );
    // The top nav matches exactly, so it goes dark on detail routes.
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: "Trips" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders Cards as a real nav link (the phase-1 stub is gone)", () => {
    renderAt("/cards");
    expect(screen.queryByText(/Cards · soon/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cards" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders its children", () => {
    renderAt("/");
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("shows a user avatar chip once the identity is known, and nothing before", () => {
    const { unmount } = renderAt("/");
    expect(screen.queryByTitle(/badger@example.com/)).not.toBeInTheDocument();
    unmount();

    renderAt("/", { email: "badger@example.com", role: "owner" });
    expect(screen.getByTitle("badger@example.com")).toHaveTextContent("B");
  });

  it("opens the avatar menu with the account email, profile, activity and Settings/Cards links", async () => {
    const user = userEvent.setup();
    renderAt("/", { email: "badger@example.com", role: "owner" });

    const button = screen.getByRole("button", { name: "Account menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("nav-user-menu")).not.toBeInTheDocument();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = within(screen.getByTestId("nav-user-menu"));
    expect(menu.getByText("badger@example.com")).toBeInTheDocument();
    expect(menu.getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/me");
    expect(menu.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(menu.getByRole("link", { name: "Cards" })).toBeInTheDocument();
    expect(menu.getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/audit");
  });

  it("hides household-wide navigation from an invite-only account", async () => {
    renderAt("/", { email: "guest@example.com", role: "viewer" });
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: "Trips" })).toBeInTheDocument();
    for (const label of ["People", "Cards", "Settings", "Import"]) {
      expect(nav.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
    const tabs = within(screen.getByRole("navigation", { name: "Tabs" }));
    expect(tabs.queryByRole("link", { name: "People" })).not.toBeInTheDocument();
    expect(tabs.queryByRole("link", { name: "Import" })).not.toBeInTheDocument();
  });

  /* The regression this pins: /me is the one page built FOR a viewer — their
     own details, documents and notification settings. Marking it householdWide
     alongside Cards and Settings would have filtered it out of every navigation
     a viewer has, leaving them no way in at all. */
  it("still lets an invite-only account reach their own profile and the activity log", async () => {
    renderAt("/", { email: "guest@example.com", role: "viewer" });

    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: "You" })).toHaveAttribute("href", "/me");
    const tabs = within(screen.getByRole("navigation", { name: "Tabs" }));
    expect(tabs.getByRole("link", { name: "You" })).toHaveAttribute("href", "/me");

    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = within(screen.getByTestId("nav-user-menu"));
    expect(menu.getByText("guest@example.com")).toBeInTheDocument();
    expect(menu.getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/me");
    // Open to every role: the server returns only the entries a viewer is the
    // actor or subject of, so "what happened to my record" stays answerable.
    expect(menu.getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/audit");
    expect(menu.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(menu.queryByRole("link", { name: "Cards" })).not.toBeInTheDocument();
  });

  it("closes the avatar menu on Escape and returns focus to the button", async () => {
    const user = userEvent.setup();
    renderAt("/", { email: "badger@example.com", role: "owner" });

    const button = screen.getByRole("button", { name: "Account menu" });
    await user.click(button);
    expect(screen.getByTestId("nav-user-menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("nav-user-menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("closes the avatar menu when a menu link navigates", async () => {
    const user = userEvent.setup();
    renderAt("/", { email: "badger@example.com", role: "owner" });

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(
      within(screen.getByTestId("nav-user-menu")).getByRole("link", { name: "Settings" }),
    );
    expect(screen.queryByTestId("nav-user-menu")).not.toBeInTheDocument();
  });
});
