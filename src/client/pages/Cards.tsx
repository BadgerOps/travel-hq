import { useEffect, useState } from "react";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Card, CardWithPerks, PerkWithStatus } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { formatMoney } from "../lib/money.js";
import { useCanWrite } from "../api/identity.js";
import { CardForm } from "../cards/CardForm.js";
import { PerkForm } from "../cards/PerkForm.js";
import { Dialog } from "../components/Dialog.js";
import "./cards.css";

const number = new Intl.NumberFormat("en-US");

const KIND_LABELS = {
  statement_credit: "Statement credit",
  free_night: "Free night",
  lounge: "Lounge access",
  multiplier: "Earn multiplier",
  fee_offset: "Fee offset",
} as const;

const CADENCE_LABELS = { annual: "annual", monthly: "monthly", one_time: "one-time" } as const;

/**
 * Mirrors the server's unspent rule (CardRepo's unspentTotal) for local state
 * updates after a toggle/edit, so the page doesn't refetch the whole list to
 * move one number. Small, documented duplication; the server's figure is the
 * authoritative one on every load.
 */
function unspent(perks: PerkWithStatus[]): number {
  let total = 0;
  for (const p of perks) {
    if (p.kind === "multiplier" || p.usedThisPeriod || p.valueCents === null) continue;
    total += p.valueCents;
  }
  return total;
}

function describePerk(perk: PerkWithStatus): string {
  if (perk.kind === "multiplier") {
    return `${number.format(perk.multiplier ?? 0)}× ${perk.category ?? ""}`.trim();
  }
  const parts: string[] = [KIND_LABELS[perk.kind]];
  if (perk.valueCents !== null) parts.push(formatMoney(perk.valueCents));
  if (perk.cadence === "annual") {
    parts.push(`annual · resets ${perk.resetMonthDay ?? "01-01"}`);
  } else {
    parts.push(CADENCE_LABELS[perk.cadence]);
  }
  return parts.join(" · ");
}

export function Cards({ api = defaultApi }: { api?: typeof defaultApi }) {
  const canWrite = useCanWrite();

  const [cards, setCards] = useState<CardWithPerks[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [addingCard, setAddingCard] = useState(false);
  const [editingCard, setEditingCard] = useState<Card | null>(null);
  const [addingPerkFor, setAddingPerkFor] = useState<CardWithPerks | null>(null);
  const [editingPerk, setEditingPerk] = useState<{ cardId: string; perk: PerkWithStatus } | null>(
    null,
  );
  // Delete confirms follow TripDetail's two-step Dialog pattern: opening the
  // dialog is step one, the first click inside only arms the button.
  const [deletingCard, setDeletingCard] = useState<CardWithPerks | null>(null);
  const [deletingPerk, setDeletingPerk] = useState<{
    card: CardWithPerks;
    perk: PerkWithStatus;
  } | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.cards
      .list()
      .then((rows) => {
        if (!cancelled) setCards(rows);
      })
      // An empty portfolio and a failed fetch must never look the same --
      // same policy as People.
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  function replaceCard(next: CardWithPerks) {
    setCards((prev) => {
      const rows = prev ?? [];
      const exists = rows.some((c) => c.id === next.id);
      const merged = exists ? rows.map((c) => (c.id === next.id ? next : c)) : [...rows, next];
      return [...merged].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  function onCardSaved(saved: Card) {
    setActionError(null);
    setCards((prev) => {
      const rows = prev ?? [];
      const existing = rows.find((c) => c.id === saved.id);
      // A freshly created card has no perks yet; an edited one keeps its own.
      const next: CardWithPerks = existing
        ? { ...existing, ...saved }
        : { ...saved, perks: [], unspentCents: 0 };
      const merged = existing
        ? rows.map((c) => (c.id === saved.id ? next : c))
        : [...rows, next];
      return [...merged].sort((a, b) => a.name.localeCompare(b.name));
    });
    setAddingCard(false);
    setEditingCard(null);
  }

  function onPerkSaved(cardId: string, saved: PerkWithStatus) {
    setActionError(null);
    setCards((prev) =>
      (prev ?? []).map((c) => {
        if (c.id !== cardId) return c;
        const exists = c.perks.some((p) => p.id === saved.id);
        const perks = exists ? c.perks.map((p) => (p.id === saved.id ? saved : p)) : [...c.perks, saved];
        return { ...c, perks, unspentCents: unspent(perks) };
      }),
    );
    setAddingPerkFor(null);
    setEditingPerk(null);
  }

  async function toggleUsed(card: CardWithPerks, perk: PerkWithStatus, used: boolean) {
    setActionError(null);
    try {
      await api.cards.setPerkUsed(card.id, perk.id, used);
      const perks = card.perks.map((p) =>
        p.id === perk.id
          ? { ...p, usedAt: used ? new Date().toISOString() : null, usedThisPeriod: used }
          : p,
      );
      replaceCard({ ...card, perks, unspentCents: unspent(perks) });
    } catch (err) {
      // The checkbox stays in its server-truthful position; the failure is
      // reported instead of silently un-toggling.
      setActionError(errorMessage(err));
    }
  }

  function closeDeleteDialogs() {
    setDeletingCard(null);
    setDeletingPerk(null);
    setDeleteArmed(false);
  }

  async function removeCard(card: CardWithPerks) {
    setActionError(null);
    setDeleteBusy(true);
    try {
      await api.cards.remove(card.id);
      setCards((prev) => (prev ?? []).filter((c) => c.id !== card.id));
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setDeleteBusy(false);
      closeDeleteDialogs();
    }
  }

  async function removePerk(card: CardWithPerks, perk: PerkWithStatus) {
    setActionError(null);
    setDeleteBusy(true);
    try {
      await api.cards.removePerk(card.id, perk.id);
      const perks = card.perks.filter((p) => p.id !== perk.id);
      replaceCard({ ...card, perks, unspentCents: unspent(perks) });
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setDeleteBusy(false);
      closeDeleteDialogs();
    }
  }

  const totalUnspent = (cards ?? []).reduce((sum, c) => sum + c.unspentCents, 0);

  return (
    <>
      <header className="page-header">
        <div className="page-title-group">
          <h3>Cards</h3>
          <p className="page-subline">
            The household card portfolio: points balances and the credits each card carries, so
            nothing expires unused. Card numbers are never stored.
          </p>
        </div>
        {canWrite && (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => setAddingCard(true)}>
              <Plus size={14} /> Add card
            </button>
          </div>
        )}
      </header>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {actionError && (
        <p className="warning" role="alert">
          {actionError}
        </p>
      )}

      {!error && cards === null && <p className="text-muted">Loading…</p>}

      {!error && cards !== null && cards.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">No cards yet</span>
          <p className="card-body" style={{ margin: 0 }}>
            Add the travel cards the family actually holds, then record each card's credits and
            perks — the page will keep a running total of what's still unspent this period.
          </p>
          {canWrite && (
            <button type="button" className="btn btn-primary" onClick={() => setAddingCard(true)}>
              <Plus size={14} /> Add the first card
            </button>
          )}
        </div>
      )}

      {!error && cards !== null && cards.length > 0 && (
        <>
          {totalUnspent > 0 && (
            <section className="card cards-summary">
              <h6 className="card-kicker">Unspent credits</h6>
              <div className="stat-big">
                {formatMoney(totalUnspent)}{" "}
                <span className="stat-note">still on the table this period, across every card</span>
              </div>
            </section>
          )}

          <div className="grid-cards">
            {cards.map((card) => (
              <section key={card.id} className="card card-tile">
                <div className="card-tile-head">
                  <span className="card-title">{card.name}</span>
                  {card.issuer && <span className="card-meta">{card.issuer}</span>}
                  {canWrite && (
                    <span className="card-tile-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-label={`Edit ${card.name}`}
                        onClick={() => setEditingCard(card)}
                      >
                        <PencilSimple size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-label={`Delete ${card.name}`}
                        onClick={() => {
                          setDeleteArmed(false);
                          setDeletingCard(card);
                        }}
                      >
                        <Trash size={14} />
                      </button>
                    </span>
                  )}
                </div>

                {card.pointsProgram && (
                  <div className="card-meta">
                    {card.pointsBalance !== null
                      ? `${number.format(card.pointsBalance)} ${card.pointsProgram}`
                      : card.pointsProgram}
                    {card.balanceUpdatedAt && (
                      <span className="text-muted"> · updated {card.balanceUpdatedAt.slice(0, 10)}</span>
                    )}
                  </div>
                )}

                {card.perks.length === 0 ? (
                  <p className="card-body" style={{ margin: 0 }}>
                    No perks recorded.
                  </p>
                ) : (
                  <ul className="perk-list">
                    {card.perks.map((perk) => (
                      <li key={perk.id} className="perk-row">
                        <div className="perk-main">
                          <div className="perk-name">{perk.name}</div>
                          <div className="card-meta">{describePerk(perk)}</div>
                        </div>
                        <span className="perk-controls">
                          {perk.kind !== "multiplier" &&
                            (canWrite ? (
                              <label className="perk-used">
                                <input
                                  type="checkbox"
                                  checked={perk.usedThisPeriod}
                                  aria-label={`Mark ${perk.name} used`}
                                  onChange={(e) => toggleUsed(card, perk, e.target.checked)}
                                />
                                used
                              </label>
                            ) : (
                              <span className="tag tag-neutral">
                                {perk.usedThisPeriod ? "used" : "unspent"}
                              </span>
                            ))}
                          {canWrite && (
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost"
                                aria-label={`Edit ${perk.name}`}
                                onClick={() => setEditingPerk({ cardId: card.id, perk })}
                              >
                                <PencilSimple size={13} />
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost"
                                aria-label={`Delete ${perk.name}`}
                                onClick={() => {
                                  setDeleteArmed(false);
                                  setDeletingPerk({ card, perk });
                                }}
                              >
                                <Trash size={13} />
                              </button>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="card-tile-foot">
                  {card.unspentCents > 0 && (
                    <span className="card-meta">
                      {formatMoney(card.unspentCents)} unspent this period
                    </span>
                  )}
                  {canWrite && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setAddingPerkFor(card)}
                    >
                      <Plus size={13} /> Add perk
                    </button>
                  )}
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      {addingCard && (
        <CardForm api={api} onSaved={onCardSaved} onClose={() => setAddingCard(false)} />
      )}
      {editingCard && (
        <CardForm
          // Remount per card, same reason PersonForm remounts per person.
          key={editingCard.id}
          card={editingCard}
          api={api}
          onSaved={onCardSaved}
          onClose={() => setEditingCard(null)}
        />
      )}
      {addingPerkFor && (
        <PerkForm
          cardId={addingPerkFor.id}
          api={api}
          onSaved={(perk) => onPerkSaved(addingPerkFor.id, perk)}
          onClose={() => setAddingPerkFor(null)}
        />
      )}
      {editingPerk && (
        <PerkForm
          key={editingPerk.perk.id}
          cardId={editingPerk.cardId}
          perk={editingPerk.perk}
          api={api}
          onSaved={(perk) => onPerkSaved(editingPerk.cardId, perk)}
          onClose={() => setEditingPerk(null)}
        />
      )}

      {deletingCard && (
        <Dialog title={`Delete ${deletingCard.name}?`} onClose={closeDeleteDialogs}>
          <p style={{ margin: 0, fontSize: 13.5 }}>
            This permanently deletes the card
            {deletingCard.perks.length > 0 && (
              <>
                {" "}and its {deletingCard.perks.length}{" "}
                {deletingCard.perks.length === 1 ? "perk" : "perks"}
              </>
            )}
            . It cannot be undone.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={closeDeleteDialogs}>
              Keep card
            </button>
            {deleteArmed ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={deleteBusy}
                onClick={() => void removeCard(deletingCard)}
              >
                Yes, permanently delete
              </button>
            ) : (
              // The second confirm: the first click only arms the button.
              <button type="button" className="btn btn-primary" onClick={() => setDeleteArmed(true)}>
                Delete card
              </button>
            )}
          </div>
        </Dialog>
      )}

      {deletingPerk && (
        <Dialog title={`Delete ${deletingPerk.perk.name}?`} onClose={closeDeleteDialogs}>
          <p style={{ margin: 0, fontSize: 13.5 }}>
            This removes the perk from {deletingPerk.card.name}, including its used/unspent
            history. It cannot be undone.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={closeDeleteDialogs}>
              Keep perk
            </button>
            {deleteArmed ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={deleteBusy}
                onClick={() => void removePerk(deletingPerk.card, deletingPerk.perk)}
              >
                Yes, permanently delete
              </button>
            ) : (
              // The second confirm: the first click only arms the button.
              <button type="button" className="btn btn-primary" onClick={() => setDeleteArmed(true)}>
                Delete perk
              </button>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
