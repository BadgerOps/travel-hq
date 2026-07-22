import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "../../../src/client/components/Dialog.js";

function renderDialog(onClose = vi.fn()) {
  render(
    <Dialog title="Add person" subtitle="Badger household" onClose={onClose}>
      <p>body content</p>
    </Dialog>,
  );
  return onClose;
}

describe("Dialog", () => {
  it("renders as a labelled modal dialog", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Add person");
  });

  it("renders its children", () => {
    renderDialog();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = renderDialog();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click of the backdrop", async () => {
    const onClose = renderDialog();
    await userEvent.click(screen.getByTestId("dialog-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a click inside the dialog", async () => {
    // A click that starts on a form control and lands on the panel must not
    // discard a half-filled passport form.
    const onClose = renderDialog();
    await userEvent.click(screen.getByText("body content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on the explicit close control", async () => {
    const onClose = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab focus at the end of the dialog back to the start", async () => {
    const user = userEvent.setup();
    render(
      <Dialog title="Add person" onClose={vi.fn()}>
        <input aria-label="first" />
        <input aria-label="last" />
      </Dialog>,
    );
    const first = screen.getByLabelText("first");
    const last = screen.getByLabelText("last");
    const close = screen.getByRole("button", { name: /close/i });

    // Forward-tab off the last focusable wraps back inside the modal, never to body.
    last.focus();
    await user.tab();
    expect([first, last, close]).toContain(document.activeElement);

    // Shift+Tab off the first focusable wraps to the end, not out of the modal.
    first.focus();
    await user.tab({ shift: true });
    expect([first, last, close]).toContain(document.activeElement);
  });

  it("restores focus to the trigger when it closes", async () => {
    const { rerender } = render(<TriggerHarness open />);
    const trigger = screen.getByRole("button", { name: "open" });
    // While open, focus is inside the dialog, not on the trigger behind it.
    expect(document.activeElement).not.toBe(trigger);
    rerender(<TriggerHarness open={false} />);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

function TriggerHarness({ open }: { open: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef}>open</button>
      {open && (
        <Dialog title="t" onClose={() => {}} restoreFocusTo={triggerRef}>
          <input aria-label="field" />
        </Dialog>
      )}
    </>
  );
}
