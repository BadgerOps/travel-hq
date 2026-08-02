import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AppRoutes } from "../../src/client/routes.js";

// Every page under AppRoutes fetches on mount. Nothing here asserts on what
// they render — only on which one is chosen — so the network is stubbed once,
// flatly, rather than per page.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } })),
  );
});

function renderAt(path: string) {
  const { hook, history } = memoryLocation({ path, record: true });
  render(
    <Router hook={hook}>
      <AppRoutes />
    </Router>,
  );
  return history;
}

describe("routes", () => {
  it("redirects /people to the members section of Settings", () => {
    const history = renderAt("/people");
    // The roster moved into Settings, and the hash lands on it rather than the
    // top of a long page.
    expect(history.at(-1)).toBe("/settings#members");
    // Replaced, not pushed: back should return where they came from rather
    // than bouncing off the redirect again.
    expect(history).toHaveLength(1);
    // What is NOT asserted here, and why: whether Settings then renders.
    // `memoryLocation` keeps the whole string it was navigated to, so it
    // reports "/settings#members" as the path and no route matches it. The
    // browser hook reads `location.pathname`, which never contains the hash —
    // see wouter's use-browser-location — so in the app the hash is carried by
    // the URL and the match is against "/settings". Asserting the render here
    // would be asserting the test double's behaviour, not the app's.
  });

  it("routes /me and /audit rather than falling through to Not found", () => {
    const { unmount } = render(
      <Router hook={memoryLocation({ path: "/me" }).hook}>
        <AppRoutes />
      </Router>,
    );
    expect(screen.queryByText("Not found")).not.toBeInTheDocument();
    unmount();

    render(
      <Router hook={memoryLocation({ path: "/audit" }).hook}>
        <AppRoutes />
      </Router>,
    );
    expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument();
  });

  it("still answers an unknown path with Not found", () => {
    renderAt("/nowhere");
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });
});
