import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TravelerToggles } from "../../../src/client/components/TravelerToggles.js";

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function renderToggles(selected: string[] = [], onToggle = vi.fn()) {
  render(
    <TravelerToggles people={PEOPLE as never} selected={selected} onToggle={onToggle} />,
  );
  return onToggle;
}

describe("TravelerToggles", () => {
  it("renders a toggle per person", () => {
    renderToggles();
    expect(screen.getByRole("button", { name: /Badger/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ava/ })).toBeInTheDocument();
  });

  it("reflects selection with aria-pressed rather than colour alone", () => {
    renderToggles(["p1"]);
    expect(screen.getByRole("button", { name: /Badger/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Ava/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the person id on click", async () => {
    const onToggle = renderToggles();
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    expect(onToggle).toHaveBeenCalledWith("p2");
  });

  it("says so when the household has no people yet", () => {
    render(<TravelerToggles people={[]} selected={[]} onToggle={vi.fn()} />);
    expect(screen.getByText(/no people yet/i)).toBeInTheDocument();
  });
});
