import { useEffect, useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { X } from "@phosphor-icons/react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * One modal shell for all three forms in this plan. The token sheet already
 * provides `.dialog-backdrop`, `.dialog`, `.dialog-title`, and
 * `.dialog-actions`; this supplies the behaviour those classes imply —
 * Escape to close, backdrop-click to close, an accessible name, initial
 * focus inside the panel, a Tab focus-trap so keyboard focus cannot escape to
 * the inert page behind the modal, and focus restored to the trigger on close
 * so a keyboard user is not dumped at the top of the document. The last two
 * are WCAG requirements for a modal and every dialog in the app inherits them
 * from here.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  restoreFocusTo,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * The control that opened the dialog. Focus returns here on unmount. Defaults
   * to whatever was focused at open time, which is almost always the trigger.
   */
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      // Keep Tab and Shift+Tab cycling within the panel. Without this, tabbing
      // past the last control lands on the page behind the modal, which is
      // exactly what aria-modal promises does not happen.
      const items = panel.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // Remember whatever had focus when the dialog opened, so it can be
    // restored on close. Prefer an explicit trigger ref if given.
    const previouslyFocused = (restoreFocusTo?.current ??
      document.activeElement) as HTMLElement | null;
    // Focus the panel itself rather than hunting for the first input: the
    // three forms have different first fields, and `tabIndex={-1}` makes the
    // panel focusable without putting it in the tab order.
    panel.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
    // Intentionally run once: capturing focus at mount and restoring at unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="dialog-backdrop"
      data-testid="dialog-backdrop"
      // Fires only when the backdrop itself is the target, so a click that
      // began inside the panel never closes the dialog.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h4 id={titleId} className="dialog-title" style={{ margin: 0 }}>
            {title}
          </h4>
          {subtitle && <span className="text-muted" style={{ fontSize: 12 }}>{subtitle}</span>}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginLeft: "auto" }}
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
