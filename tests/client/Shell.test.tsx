import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
    for (const label of ["Today", "Trips", "Checklist", "People"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the current route as the active page", () => {
    renderAt("/trips");
    expect(screen.getByRole("link", { name: "Trips" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders the cards stub as non-interactive", () => {
    renderAt("/");
    const cards = screen.getByText(/Cards/);
    expect(cards.tagName).not.toBe("A");
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
});
