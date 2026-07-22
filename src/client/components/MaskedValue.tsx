import { useState } from "react";
import { useCanReveal } from "../api/identity.js";

export function MaskedValue({
  masked,
  onReveal,
}: {
  masked: string | null;
  onReveal: () => Promise<string | null>;
}) {
  const canReveal = useCanReveal();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (masked === null) return null;
  if (revealed !== null) return <span>{revealed}</span>;

  // A viewer's reveal is a guaranteed 403 (the repos throw ForbiddenError for
  // that role), so rendering a button would be an affordance that can only
  // fail. Plain text, no dotted underline, no hover: nothing to click.
  if (!canReveal) {
    return (
      <span title="Only owners and adults can reveal stored numbers">{masked}</span>
    );
  }

  if (failed) {
    return (
      <span className="warning" title="The server refused this reveal">
        {masked} · not allowed to see this
      </span>
    );
  }

  return (
    <button
      type="button"
      className="masked"
      disabled={busy}
      title="Click to reveal — access is logged"
      onClick={async () => {
        setBusy(true);
        try {
          setRevealed(await onReveal());
        } catch {
          // The reveal endpoints return a deliberately generic body (403
          // "Forbidden", 500 "Internal error"), so there is no detail worth
          // surfacing -- only the fact that it did not happen. Swallowing
          // this without setting state is what left a viewer with a button
          // that visibly did nothing.
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {masked}
    </button>
  );
}
