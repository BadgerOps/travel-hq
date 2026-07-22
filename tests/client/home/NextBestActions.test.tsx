import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { NextBestActions } from "../../../src/client/home/NextBestActions.js";

function item(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    tripId: "t1",
    personId: null,
    label: "Check in for DL 2214",
    dueOn: "2026-07-25",
    doneAt: null,
    ...over,
  };
}

function makeApi(items = [item()]) {
  return {
    checklist: {
      list: vi.fn(async () => items),
      setDone: vi.fn(async () => undefined),
    },
  };
}

function renderCard(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/" });
  render(
    <Router hook={hook}>
      <NextBestActions api={api as never} today="2026-07-21" />
    </Router>,
  );
  return api;
}

describe("NextBestActions", () => {
  it("lists open items", async () => {
    renderCard();
    expect(await screen.findByText("Check in for DL 2214")).toBeInTheDocument();
  });

  it("puts undone items above done ones", async () => {
    renderCard(
      makeApi([
        item({ id: "c1", label: "Already done", doneAt: "2026-07-20T00:00:00Z", dueOn: null }),
        item({ id: "c2", label: "Still open", dueOn: null }),
      ]),
    );
    const labels = (await screen.findAllByTestId("action-label")).map((el) => el.textContent);
    expect(labels).toEqual(["Still open", "Already done"]);
  });

  it("orders undone items by due date with undated ones last", async () => {
    renderCard(
      makeApi([
        item({ id: "c1", label: "No date", dueOn: null }),
        item({ id: "c2", label: "Later", dueOn: "2026-08-01" }),
        item({ id: "c3", label: "Sooner", dueOn: "2026-07-22" }),
      ]),
    );
    const labels = (await screen.findAllByTestId("action-label")).map((el) => el.textContent);
    expect(labels).toEqual(["Sooner", "Later", "No date"]);
  });

  it("shows how long is left, and flags an overdue item", async () => {
    renderCard(
      makeApi([
        item({ id: "c1", label: "Overdue", dueOn: "2026-07-19" }),
        item({ id: "c2", label: "Due today", dueOn: "2026-07-21" }),
        item({ id: "c3", label: "Later", dueOn: "2026-07-25" }),
      ]),
    );
    expect(await screen.findByText("overdue")).toBeInTheDocument();
    expect(screen.getByText("today")).toBeInTheDocument();
    expect(screen.getByText("4 days")).toBeInTheDocument();
  });

  it("toggles an item done on click", async () => {
    const api = renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /Check in for DL 2214/ }));
    expect(api.checklist.setDone).toHaveBeenCalledWith("c1", true);
    expect(await screen.findByTestId("action-row-c1")).toHaveAttribute("data-done", "true");
  });

  it("leaves the row as it was when the write is rejected", async () => {
    // Optimistically showing a state the server refused is worse than showing
    // nothing: the operator believes the passport renewal is ticked off.
    const api = makeApi();
    api.checklist.setDone = vi.fn(async () => {
      throw new Error("403");
    });
    renderCard(api);
    await userEvent.click(await screen.findByRole("button", { name: /Check in for DL 2214/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("action-row-c1")).toHaveAttribute("data-done", "false");
  });

  it("renders nothing at all when there are no checklist items", async () => {
    const { container } = render(
      <Router hook={memoryLocation({ path: "/" }).hook}>
        <NextBestActions api={makeApi([]) as never} today="2026-07-21" />
      </Router>,
    );
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("reports a failed load rather than looking like an empty checklist", async () => {
    const api = makeApi();
    api.checklist.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderCard(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load|could not load/i);
  });
});
