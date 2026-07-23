import { useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type { Card, CreateCardInput, UpdateCardInput } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "../components/Dialog.js";

/**
 * Create when `card` is absent, edit when present. Nothing here is sensitive
 * (no PAN, no last4 — by design, see the card-perks spec), so unlike
 * PersonForm every field seeds straight from the loaded card.
 *
 * The one subtlety is the balance: the server stamps balance_updated_at on
 * every pointsBalance write, so the key is sent only when the operator
 * actually changed it — otherwise renaming a card would silently "refresh"
 * a months-old balance.
 */
export function CardForm({
  card,
  api = defaultApi,
  onSaved,
  onClose,
}: {
  card?: Card;
  api?: typeof defaultApi;
  onSaved: (card: Card) => void;
  onClose: () => void;
}) {
  const editing = card !== undefined;

  const initialBalance = card?.pointsBalance === null || card === undefined ? "" : String(card.pointsBalance);
  const [name, setName] = useState(card?.name ?? "");
  const [issuer, setIssuer] = useState(card?.issuer ?? "");
  const [pointsProgram, setPointsProgram] = useState(card?.pointsProgram ?? "");
  const [balance, setBalance] = useState(initialBalance);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("A card name is required.");
      return;
    }
    const trimmedBalance = balance.trim();
    const parsedBalance = trimmedBalance === "" ? null : Number(trimmedBalance);
    if (parsedBalance !== null && (!Number.isInteger(parsedBalance) || parsedBalance < 0)) {
      setError("Points balance must be a whole number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = editing
        ? await api.cards.update(card.id, {
            name: name.trim(),
            issuer: issuer.trim() === "" ? null : issuer.trim(),
            pointsProgram: pointsProgram.trim() === "" ? null : pointsProgram.trim(),
            // Only when changed — see the docstring.
            ...(trimmedBalance === initialBalance ? {} : { pointsBalance: parsedBalance }),
          } satisfies UpdateCardInput)
        : await api.cards.create({
            name: name.trim(),
            ...(issuer.trim() === "" ? {} : { issuer: issuer.trim() }),
            ...(pointsProgram.trim() === "" ? {} : { pointsProgram: pointsProgram.trim() }),
            ...(parsedBalance === null ? {} : { pointsBalance: parsedBalance }),
          } satisfies CreateCardInput);
      onSaved(saved);
    } catch (err) {
      // Never close on failure: a 403 (viewer) or a validation 400 must leave
      // the typed values on screen, matching PersonForm.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={editing ? `Edit ${card.name}` : "Add card"} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="cf-name">Card name</label>
            <input
              id="cf-name"
              className="input"
              value={name}
              placeholder="Sapphire Reserve"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cf-issuer">Issuer</label>
            <input
              id="cf-issuer"
              className="input"
              value={issuer}
              placeholder="Chase"
              onChange={(e) => setIssuer(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="cf-program">Points program</label>
            <input
              id="cf-program"
              className="input"
              value={pointsProgram}
              placeholder="Ultimate Rewards"
              onChange={(e) => setPointsProgram(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cf-balance">Points balance</label>
            <input
              id="cf-balance"
              className="input"
              inputMode="numeric"
              value={balance}
              placeholder="85000"
              onChange={(e) => setBalance(e.target.value)}
            />
          </div>
        </div>

        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          Card numbers are never stored — a card is just its name, program, and perks.
        </p>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
