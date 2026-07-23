import { useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type {
  CardPerk,
  CreatePerkInput,
  PerkCadence,
  PerkKind,
  PerkWithStatus,
  UpdatePerkInput,
} from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "../components/Dialog.js";

const KINDS: { id: PerkKind; label: string }[] = [
  { id: "statement_credit", label: "Statement credit" },
  { id: "free_night", label: "Free night" },
  { id: "lounge", label: "Lounge access" },
  { id: "multiplier", label: "Earn multiplier" },
  { id: "fee_offset", label: "Fee offset" },
];

const CADENCES: { id: PerkCadence; label: string }[] = [
  { id: "annual", label: "Annual" },
  { id: "monthly", label: "Monthly" },
  { id: "one_time", label: "One-time" },
];

/**
 * Create when `perk` is absent, edit when present. The form always submits
 * the full perk shape (value/multiplier/category/cadence/reset day coherent
 * with the chosen kind); the server validates the same shape again
 * (validatePerkShape), so a stale or hand-crafted request fails with the
 * same 400 this form would have prevented.
 */
export function PerkForm({
  cardId,
  perk,
  api = defaultApi,
  onSaved,
  onClose,
}: {
  cardId: string;
  perk?: CardPerk;
  api?: typeof defaultApi;
  onSaved: (perk: PerkWithStatus) => void;
  onClose: () => void;
}) {
  const editing = perk !== undefined;

  const [name, setName] = useState(perk?.name ?? "");
  const [kind, setKind] = useState<PerkKind>(perk?.kind ?? "statement_credit");
  const [value, setValue] = useState(
    perk?.valueCents == null ? "" : (perk.valueCents / 100).toFixed(2),
  );
  const [multiplier, setMultiplier] = useState(
    perk?.multiplier == null ? "" : String(perk.multiplier),
  );
  const [category, setCategory] = useState(perk?.category ?? "");
  const [cadence, setCadence] = useState<PerkCadence>(perk?.cadence ?? "annual");
  const [resetMonthDay, setResetMonthDay] = useState(perk?.resetMonthDay ?? "");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isMultiplier = kind === "multiplier";
  // A multiplier is a standing earn rate, not a credit that renews; the
  // cadence control is hidden and one_time submitted for it.
  const effectiveCadence: PerkCadence = isMultiplier ? "one_time" : cadence;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("A perk name is required.");
      return;
    }

    let valueCents: number | null = null;
    if (!isMultiplier && value.trim() !== "") {
      const dollars = Number(value.trim());
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setError("Value must be a positive dollar amount.");
        return;
      }
      valueCents = Math.round(dollars * 100);
    }

    let multiplierNum: number | null = null;
    if (isMultiplier) {
      multiplierNum = Number(multiplier.trim());
      if (!Number.isFinite(multiplierNum) || multiplierNum <= 0) {
        setError("A multiplier perk needs a positive multiplier (e.g. 3 for 3×).");
        return;
      }
      if (category.trim() === "") {
        setError("A multiplier perk needs a spend category (e.g. travel).");
        return;
      }
    }

    const reset = resetMonthDay.trim();

    setBusy(true);
    setError(null);
    try {
      const saved = editing
        ? await api.cards.updatePerk(cardId, perk.id, {
            name: name.trim(),
            kind,
            valueCents,
            multiplier: multiplierNum,
            category: isMultiplier ? category.trim() : null,
            cadence: effectiveCadence,
            resetMonthDay: effectiveCadence === "annual" && reset !== "" ? reset : null,
          } satisfies UpdatePerkInput)
        : await api.cards.createPerk(cardId, {
            name: name.trim(),
            kind,
            ...(valueCents === null ? {} : { valueCents }),
            ...(multiplierNum === null ? {} : { multiplier: multiplierNum }),
            ...(isMultiplier ? { category: category.trim() } : {}),
            cadence: effectiveCadence,
            ...(effectiveCadence === "annual" && reset !== "" ? { resetMonthDay: reset } : {}),
          } satisfies CreatePerkInput);
      onSaved(saved);
    } catch (err) {
      // Never close on failure — the server's message (bad reset day, viewer
      // 403) must leave the typed values on screen, matching every form.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={editing ? `Edit ${perk.name}` : "Add perk"} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="kf-name">Perk name</label>
            <input
              id="kf-name"
              className="input"
              value={name}
              placeholder="Annual travel credit"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="kf-kind">Type</label>
            <select
              id="kf-kind"
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as PerkKind)}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isMultiplier ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label htmlFor="kf-multiplier">Multiplier</label>
              <input
                id="kf-multiplier"
                className="input"
                inputMode="decimal"
                value={multiplier}
                placeholder="3"
                onChange={(e) => setMultiplier(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="kf-category">Category</label>
              <input
                id="kf-category"
                className="input"
                value={category}
                placeholder="travel"
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label htmlFor="kf-value">Value ($)</label>
              <input
                id="kf-value"
                className="input"
                inputMode="decimal"
                value={value}
                placeholder="300"
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="kf-cadence">Cadence</label>
              <select
                id="kf-cadence"
                className="input"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as PerkCadence)}
              >
                {CADENCES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {!isMultiplier && cadence === "annual" && (
          <div className="field">
            <label htmlFor="kf-reset">Resets on (MM-DD)</label>
            <input
              id="kf-reset"
              className="input"
              value={resetMonthDay}
              placeholder="01-01"
              onChange={(e) => setResetMonthDay(e.target.value)}
            />
          </div>
        )}

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
