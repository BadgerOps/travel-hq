import { useEffect, useState } from "react";
import { FloppyDisk, Robot } from "@phosphor-icons/react";
import { api as defaultApi, ApiError } from "../api/client.js";
import type { HouseholdSettings, InboundEmailActivity, RevealAuditEntry } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { useCanWrite, useIdentity } from "../api/identity.js";

/** Outcome vocabulary → what an operator should read it as. */
const STATUS_LABELS: Record<InboundEmailActivity["status"], string> = {
  received: "Queued",
  extracted: "Extracted",
  failed: "Failed",
  rejected: "Rejected",
};

const FIELD_LABELS: Record<RevealAuditEntry["field"], string> = {
  passport_number: "passport number",
  known_traveler_number: "Known Traveler Number",
  redress_number: "redress number",
};

/** "2026-07-23T10:15:42.000Z" → "2026-07-23 10:15 UTC" — deterministic, no locale. */
function formatWhen(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The agent-configuration page: the household's forward address, sender
 * allowlist, and Workers AI model — the three values the email ingest
 * pipeline reads. GET /api/settings answers with the defaults applied (the
 * default model, an empty allowlist), so this form never has to know what
 * the defaults are.
 *
 * Below the form, two observability feeds (issue #8):
 * - Recent ingest activity: every stored inbound email's outcome and reason,
 *   next to the configuration that produced it. Owner/adult only, like the
 *   settings themselves.
 * - Sensitive data access log: who revealed which document number, when.
 *   OWNER-only — the server 403s everyone else, and the section is not even
 *   offered to non-owners.
 *
 * Role-gating: the server answers 403 for a viewer on the GET as well as
 * the PUT, so a viewer gets the access card below, not a read-only form.
 * useCanWrite() additionally hides the save affordance while the identity
 * is a known viewer — same "no button that can only 403" rule as
 * MaskedValue and the checklist toggles.
 */
export function Settings({
  api = defaultApi,
}: {
  api?: typeof defaultApi;
}) {
  const [settings, setSettings] = useState<HouseholdSettings | null>(null);
  const [forwardAddress, setForwardAddress] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<InboundEmailActivity[] | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [reveals, setReveals] = useState<RevealAuditEntry[] | null>(null);
  const [revealsError, setRevealsError] = useState<string | null>(null);
  const canWrite = useCanWrite();
  const isOwner = useIdentity()?.role === "owner";

  useEffect(() => {
    let cancelled = false;
    api.settings.get().then(
      (s) => {
        if (cancelled) return;
        setSettings(s);
        setForwardAddress(s.forwardAddress ?? "");
        setAllowlistText(s.senderAllowlist.join("\n"));
        setAiModel(s.aiModel);
      },
      (err: unknown) => {
        if (cancelled) return;
        // 403 is not a fault: it means the caller is a viewer and settings
        // are owner/adult only. Everything else is a real failed load and
        // must not render like an unconfigured household.
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setLoadFailed(errorMessage(err));
      },
    );
    api.settings.ingestActivity().then(
      (rows) => {
        if (!cancelled) setActivity(rows);
      },
      (err: unknown) => {
        if (cancelled) return;
        // 403 = viewer; the whole page already shows the access card, so a
        // second error for the same cause would be noise.
        if (err instanceof ApiError && err.status === 403) return;
        setActivityError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Fetched only once the identity is a KNOWN owner: the endpoint 403s
  // everyone else, and a request that can only fail is not worth sending.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    api.audit.reveals().then(
      (rows) => {
        if (!cancelled) setReveals(rows);
      },
      (err: unknown) => {
        if (!cancelled) setRevealsError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, isOwner]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);

    const address = forwardAddress.trim();
    if (address !== "" && !/^[^\s@]+@[^\s@]+$/.test(address)) {
      setSaveError("The forward address must be a single email address.");
      return;
    }
    const allowlist = allowlistText
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const model = aiModel.trim();
    if (model === "") {
      setSaveError("A model id is required.");
      return;
    }

    setBusy(true);
    setSaveError(null);
    try {
      const next = await api.settings.update({
        forwardAddress: address === "" ? null : address,
        senderAllowlist: allowlist,
        aiModel: model,
      });
      setSettings(next);
      setForwardAddress(next.forwardAddress ?? "");
      setAllowlistText(next.senderAllowlist.join("\n"));
      setAiModel(next.aiModel);
      setSaved(true);
    } catch (err) {
      // Keep whatever the operator typed -- don't blow away their input on a
      // rejected write. Same rule TripForm/PersonForm follow.
      setSaveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <>
        <SettingsHeader />
        <div className="card" style={{ maxWidth: 560, alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">Owners and adults only</span>
          <p className="card-body" style={{ margin: 0 }}>
            Household settings control whose email can write into this household, so viewing and
            editing them is limited to owners and adults.
          </p>
        </div>
      </>
    );
  }

  if (loadFailed) {
    return (
      <p className="warning" role="alert">
        {loadFailed}
      </p>
    );
  }

  return (
    <>
      <SettingsHeader />

      {settings === null && <p className="text-muted">Loading…</p>}

      {settings !== null && (
        <div style={{ display: "grid", gap: 24, maxWidth: 560 }}>
          <form onSubmit={save} style={{ display: "grid", gap: 14 }}>
            {saveError && (
              <p className="warning" role="alert" style={{ margin: 0 }}>
                {saveError}
              </p>
            )}
            {saved && (
              <p className="text-muted" role="status" style={{ margin: 0 }}>
                Settings saved.
              </p>
            )}

            <div className="field">
              <label htmlFor="st-forward">Forward address</label>
              <input
                id="st-forward"
                className="input"
                placeholder="trips@example.com"
                value={forwardAddress}
                onChange={(e) => setForwardAddress(e.target.value)}
                readOnly={!canWrite}
              />
              <p className="text-muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                The address confirmation emails are forwarded to for this household. Leave blank
                to turn email ingest off.
              </p>
            </div>

            <div className="field">
              <label htmlFor="st-allowlist">Sender allowlist</label>
              <textarea
                id="st-allowlist"
                className="input"
                rows={4}
                placeholder={"you@example.com\nairline.com"}
                value={allowlistText}
                onChange={(e) => setAllowlistText(e.target.value)}
                readOnly={!canWrite}
              />
              <p className="text-muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                One address or domain per line. Only mail from these senders is ingested; an
                empty list means no mail is ingested at all.
              </p>
            </div>

            <div className="field">
              <label htmlFor="st-model">Extraction model</label>
              <input
                id="st-model"
                className="input"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                readOnly={!canWrite}
              />
              <p className="text-muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                The Workers AI model that turns a forwarded email into a draft booking.
              </p>
            </div>

            {canWrite && (
              <div>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  <FloppyDisk size={14} /> Save settings
                </button>
              </div>
            )}
          </form>

          {/* The ingest status feed (issue #8): every stored inbound email's
              outcome — including rejections and failures with their reasons —
              rendered next to the configuration that produced it. Raw message
              text never appears here; that stays behind the Import page's
              explicit "view original". */}
          <section aria-label="Recent ingest activity">
            <h5 className="card-title" style={{ marginBottom: 10 }}>
              Recent ingest activity
            </h5>
            {activityError && (
              <p className="warning" role="alert" style={{ margin: 0 }}>
                {activityError}
              </p>
            )}
            {!activityError && activity === null && <p className="text-muted">Loading…</p>}
            {activity !== null && activity.length === 0 && (
              <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
                <span className="card-title">
                  <Robot size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
                  Nothing ingested yet
                </span>
                <p className="card-body" style={{ margin: 0 }}>
                  Forward a confirmation email to the address above and its outcome — extracted,
                  rejected, or failed, with the reason — will appear here.
                </p>
              </div>
            )}
            {activity !== null && activity.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {activity.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} />
                ))}
              </div>
            )}
          </section>

          {/* Owner-only (issue #8): the durable reveal audit trail. The server
              enforces this (403 for adults and viewers); the section is not
              even offered below owner so there is no affordance that can only
              fail. */}
          {isOwner && (
            <section aria-label="Sensitive data access log">
              <h5 className="card-title" style={{ marginBottom: 4 }}>
                Sensitive data access log
              </h5>
              <p className="text-muted" style={{ margin: "0 0 10px", fontSize: 12.5 }}>
                Every reveal of a passport, Known Traveler, or redress number — who, whose, and
                when. Visible only to the household owner.
              </p>
              {revealsError && (
                <p className="warning" role="alert" style={{ margin: 0 }}>
                  {revealsError}
                </p>
              )}
              {!revealsError && reveals === null && <p className="text-muted">Loading…</p>}
              {reveals !== null && reveals.length === 0 && (
                <p className="text-muted" style={{ margin: 0 }}>
                  No document numbers have been revealed.
                </p>
              )}
              {reveals !== null && reveals.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {reveals.map((entry) => (
                    <RevealRow key={entry.id} entry={entry} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}

function ActivityRow({ entry }: { entry: InboundEmailActivity }) {
  return (
    <div className="card" style={{ gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{entry.subject ?? "(no subject)"}</span>
        <span className="tag">{STATUS_LABELS[entry.status]}</span>
        <span className="text-muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          {formatWhen(entry.receivedAt)}
        </span>
      </div>
      <div className="card-meta">
        <span>from {entry.from}</span>
      </div>
      {entry.error && (
        <p className="card-body" style={{ margin: 0 }}>
          {entry.error}
        </p>
      )}
    </div>
  );
}

function RevealRow({ entry }: { entry: RevealAuditEntry }) {
  return (
    <div className="card" style={{ gap: 4 }}>
      <span style={{ fontSize: 13.5 }}>
        <strong>{entry.userEmail}</strong> revealed the {FIELD_LABELS[entry.field]} of{" "}
        {/* The audit row outlives the person it names; a deleted person shows
            as such rather than silently dropping the entry. */}
        <strong>{entry.personName ?? "a person no longer listed"}</strong>
      </span>
      <span className="text-muted" style={{ fontSize: 12 }}>
        {formatWhen(entry.revealedAt)}
      </span>
    </div>
  );
}

function SettingsHeader() {
  return (
    <header style={{ marginBottom: 20 }}>
      <h3 style={{ marginBottom: 4 }}>Settings</h3>
      <p className="text-muted" style={{ margin: 0 }}>
        How the email ingest agent works for this household.
      </p>
    </header>
  );
}
