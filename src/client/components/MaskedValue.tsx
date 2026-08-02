import { useState } from "react";
import { useCanReveal } from "../api/identity.js";

export function MaskedValue({
  masked,
  onReveal,
  /**
   * True when the masked number belongs to the row the signed-in account owns.
   *
   * It exists because "may I unmask this?" stopped being a question about role
   * alone. `PersonRepo.revealDocument` allows your OWN row at any role — a
   * viewer who can store a passport number but never read it back has a
   * write-only field, and no way to tell a typo from a correct entry. Every
   * other row is still role-gated, which is what `useCanReveal()` answers.
   *
   * Passing it does not grant anything: the server decides, and a caller that
   * lies gets the same 403 as before. It only stops the UI from hiding a
   * button that would have worked.
   */
  own = false,
  /** Names the value in the button's accessible label ("passport number"). */
  label,
}: {
  masked: string | null;
  onReveal: () => Promise<string | null>;
  own?: boolean;
  label?: string;
}) {
  const canReveal = useCanReveal();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (masked === null) return null;
  if (revealed !== null) return <span>{revealed}</span>;

  // A viewer's reveal of SOMEBODY ELSE'S number is a guaranteed 403 (the repos
  // throw ForbiddenError for that role), so rendering a button would be an
  // affordance that can only fail. Plain text, no dotted underline, no hover:
  // nothing to click. Their own row skips this — see `own`.
  if (!own && !canReveal) {
    return (
      <span title="Only owners and admins can reveal stored numbers">{masked}</span>
    );
  }

  // The two failures are not the same failure, so they do not say the same
  // thing. On somebody else's row a refusal is the expected outcome and
  // "not allowed" is the honest word. On your own row the server does not
  // refuse — you are permitted at any role — so a failure here means the
  // reveal did not happen for some other reason (the row changed under you,
  // the request did not land), and claiming a permission problem would send
  // you asking an owner to fix something that is not broken.
  if (failed) {
    return own ? (
      <span className="warning">
        {masked} · could not be revealed
      </span>
    ) : (
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
      aria-label={label ? `Reveal ${label}` : undefined}
      title="Click to reveal — access is logged"
      onClick={async () => {
        setBusy(true);
        try {
          const value = await onReveal();
          // A stored mask implies a stored value, so null here means the row
          // changed under us. Treated as a failure rather than rendered as an
          // empty string, which would read as "your passport number is blank".
          if (value === null) setFailed(true);
          else setRevealed(value);
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
