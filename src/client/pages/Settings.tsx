import { useEffect, useState } from "react";
import { FloppyDisk, Robot } from "@phosphor-icons/react";
import { api as defaultApi, ApiError } from "../api/client.js";
import type { HouseholdSettings } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { useCanWrite } from "../api/identity.js";

/**
 * The agent-configuration page: the household's forward address, sender
 * allowlist, and Workers AI model — the three values the email ingest
 * pipeline reads. GET /api/settings answers with the defaults applied (the
 * default model, an empty allowlist), so this form never has to know what
 * the defaults are.
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
  const canWrite = useCanWrite();

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
    return () => {
      cancelled = true;
    };
  }, [api]);

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

          {/* Placeholder: the ingest status/log feed (issue #8) renders here
              once the ingest pipeline (#4) exists. Until then there is
              nothing to list, and this empty state says so honestly instead
              of pretending zero activity is a healthy pipeline. */}
          <section aria-label="Recent ingest activity">
            <h5 className="card-title" style={{ marginBottom: 10 }}>
              Recent ingest activity
            </h5>
            <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
              <span className="card-title">
                <Robot size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
                Nothing ingested yet
              </span>
              <p className="card-body" style={{ margin: 0 }}>
                Once email ingest is live, recent extraction results and failures will appear
                here, next to the configuration that drives them.
              </p>
            </div>
          </section>
        </div>
      )}
    </>
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
