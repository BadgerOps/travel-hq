import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DuplicateNotice } from "../../../src/client/imports/DuplicateNotice.js";
import type { PendingImportDuplicate } from "../../../src/client/api/types.js";

function duplicate(over: Partial<PendingImportDuplicate> = {}): PendingImportDuplicate {
  return {
    reason: "confirmation",
    confidence: "high",
    target: "booking",
    id: "b1",
    title: "Delta 1423 SEA-JFK",
    startsAt: "2026-09-04T14:30:00.000Z",
    startsAtTz: "America/Los_Angeles",
    tripId: "t1",
    tripTitle: "Tokyo",
    ...over,
  };
}

describe("DuplicateNotice", () => {
  it("renders nothing for an ordinary import", () => {
    const { container } = render(<DuplicateNotice duplicates={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the trip a confident match already sits on, in amber", () => {
    render(<DuplicateNotice duplicates={[duplicate()]} />);
    const notice = screen.getByTestId("duplicate-notice");
    expect(notice).toHaveTextContent(/Already on Tokyo as “Delta 1423 SEA-JFK”/);
    expect(notice.className).toContain("warning");
  });

  it("hedges a weak match and does not dress it as a warning", () => {
    render(<DuplicateNotice duplicates={[duplicate({ confidence: "medium", reason: "same-slot" })]} />);
    const notice = screen.getByTestId("duplicate-notice");
    expect(notice).toHaveTextContent(/Might already be on Tokyo/);
    expect(notice.className).not.toContain("warning");
  });

  it("says so when the twin is another import still in the queue", () => {
    render(
      <DuplicateNotice
        duplicates={[duplicate({ target: "draft", id: "d2", tripId: null, tripTitle: null })]}
      />,
    );
    expect(screen.getByTestId("duplicate-notice")).toHaveTextContent(
      /Also waiting in this queue as “Delta 1423 SEA-JFK”/,
    );
  });

  it("leads with the match that will actually block the import", () => {
    render(
      <DuplicateNotice
        duplicates={[
          duplicate({ confidence: "medium", reason: "same-slot", tripTitle: "Kyoto" }),
          duplicate({ confidence: "high", tripTitle: "Tokyo" }),
        ]}
      />,
    );
    const notice = screen.getByTestId("duplicate-notice");
    expect(notice).toHaveTextContent(/Already on Tokyo/);
    expect(notice).toHaveTextContent(/\(\+1 more\)/);
    expect(notice.className).toContain("warning");
  });

  it("falls back when the matching booking's trip could not be named", () => {
    render(<DuplicateNotice duplicates={[duplicate({ tripTitle: null })]} />);
    expect(screen.getByTestId("duplicate-notice")).toHaveTextContent(/Already on another trip/);
  });
});
