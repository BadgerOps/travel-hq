import { useEffect, useState } from "react";
import { FloppyDisk, Flask, Key, Robot, Trash } from "@phosphor-icons/react";
import { api as defaultApi, ApiError } from "../api/client.js";
import type {
  AiProvider,
  CatalogModel,
  ExtractedBooking,
  HouseholdSettings,
  InboundEmailMetadata,
} from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { useCanWrite } from "../api/identity.js";
import { DraftBookingCard } from "../components/DraftBookingCard.js";
import { InboundEmailDetailDialog } from "../components/InboundEmailDetailDialog.js";
import {
  DEFAULT_WORKERS_AI_MAX_TOKENS,
  MAX_WORKERS_AI_MAX_TOKENS,
  MIN_WORKERS_AI_MAX_TOKENS,
  SUPPORTED_WORKERS_AI_MODELS,
} from "../../shared/workers-ai-models.js";
import "./settings.css";

/* Fallback presets only — the dropdown normally lists what the account can
   actually run, pulled from /api/settings/ai-models (the server caches the
   Cloudflare catalog). These cover an unreachable catalog: offline, or
   Workers AI itself down. */
const FALLBACK_WORKERS_MODELS: CatalogModel[] = [...SUPPORTED_WORKERS_AI_MODELS];
const ANTHROPIC_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;
const MAX_INSTRUCTIONS = 2_000;

type KeyMode = "unchanged" | "replace" | "remove";

export function Settings({ api = defaultApi }: { api?: typeof defaultApi }) {
  const [settings, setSettings] = useState<HouseholdSettings | null>(null);
  const [forwardAddress, setForwardAddress] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiMaxTokens, setAiMaxTokens] = useState(String(DEFAULT_WORKERS_AI_MAX_TOKENS));
  const [aiProvider, setAiProvider] = useState<AiProvider>("workers-ai");
  const [workersModels, setWorkersModels] = useState<CatalogModel[]>(FALLBACK_WORKERS_MODELS);
  const [anthropicModel, setAnthropicModel] = useState<string>(ANTHROPIC_MODELS[0]);
  const [anthropicKeyConfigured, setAnthropicKeyConfigured] = useState(false);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [keyMode, setKeyMode] = useState<KeyMode>("replace");
  const [extractionInstructions, setExtractionInstructions] = useState("");
  const [activity, setActivity] = useState<InboundEmailMetadata[]>([]);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [viewingEmail, setViewingEmail] = useState<InboundEmailMetadata | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testSubject, setTestSubject] = useState("");
  const [testText, setTestText] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testBookings, setTestBookings] = useState<ExtractedBooking[]>([]);
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
        setAiMaxTokens(String(s.aiMaxTokens ?? DEFAULT_WORKERS_AI_MAX_TOKENS));
        setAiProvider(s.aiProvider ?? "workers-ai");
        setAnthropicModel(s.anthropicModel ?? ANTHROPIC_MODELS[0]);
        setAnthropicKeyConfigured(s.anthropicKeyConfigured ?? false);
        setKeyMode(s.anthropicKeyConfigured ? "unchanged" : "replace");
        setExtractionInstructions(s.extractionInstructions ?? "");
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setLoadFailed(errorMessage(err));
      },
    );

    const listActivity = api.inboundEmails?.list;
    if (listActivity) {
      listActivity().then(
        (rows) => {
          if (!cancelled) setActivity(rows);
        },
        (err: unknown) => {
          if (!cancelled && !(err instanceof ApiError && err.status === 403)) {
            setActivityError(errorMessage(err));
          }
        },
      );
    }

    const listModels = api.settings.aiModels;
    if (listModels) {
      listModels().then(
        (r) => {
          if (!cancelled && r.models.length > 0) setWorkersModels(r.models);
        },
        () => {
          /* catalog unreachable: the fallback presets stay */
        },
      );
    }
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
      .filter(Boolean);
    if (aiProvider === "workers-ai" && aiModel.trim() === "") {
      setSaveError("A Workers AI model id is required.");
      return;
    }
    const parsedAiMaxTokens = Number(aiMaxTokens);
    if (
      aiProvider === "workers-ai" &&
      (!Number.isInteger(parsedAiMaxTokens) ||
        parsedAiMaxTokens < MIN_WORKERS_AI_MAX_TOKENS ||
        parsedAiMaxTokens > MAX_WORKERS_AI_MAX_TOKENS)
    ) {
      setSaveError(
        `Maximum output tokens must be an integer from ${MIN_WORKERS_AI_MAX_TOKENS} to ${MAX_WORKERS_AI_MAX_TOKENS}.`,
      );
      return;
    }
    if (
      aiProvider === "anthropic" &&
      (keyMode === "remove" || (!anthropicKeyConfigured && anthropicApiKey.trim() === ""))
    ) {
      setSaveError("Configure an Anthropic API key before selecting Anthropic.");
      return;
    }

    const input: Parameters<typeof api.settings.update>[0] = {
      forwardAddress: address === "" ? null : address,
      senderAllowlist: allowlist,
      aiModel: aiModel.trim(),
      aiMaxTokens: parsedAiMaxTokens,
      aiProvider,
      anthropicModel,
      extractionInstructions,
    };
    if (keyMode === "replace" && anthropicApiKey.trim() !== "") {
      input.anthropicApiKey = anthropicApiKey;
    }
    if (keyMode === "remove") input.anthropicApiKey = null;

    setBusy(true);
    setSaveError(null);
    try {
      const next = await api.settings.update(input);
      setSettings(next);
      setForwardAddress(next.forwardAddress ?? "");
      setAllowlistText(next.senderAllowlist.join("\n"));
      setAiModel(next.aiModel);
      setAiMaxTokens(String(next.aiMaxTokens));
      setAiProvider(next.aiProvider);
      setAnthropicModel(next.anthropicModel);
      setAnthropicKeyConfigured(next.anthropicKeyConfigured);
      setAnthropicApiKey("");
      setKeyMode(next.anthropicKeyConfigured ? "unchanged" : "replace");
      setExtractionInstructions(next.extractionInstructions);
      setSaved(true);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(event: React.FormEvent) {
    event.preventDefault();
    setTestBusy(true);
    setTestError(null);
    setTestBookings([]);
    try {
      const result = await api.settings.testExtraction({
        ...(testSubject.trim() ? { subject: testSubject.trim() } : {}),
        text: testText,
      });
      if ("error" in result) setTestError(result.error);
      else setTestBookings(result.bookings);
    } catch (err) {
      setTestError(errorMessage(err));
    } finally {
      setTestBusy(false);
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
    return <p className="warning" role="alert">{loadFailed}</p>;
  }

  return (
    <>
      <SettingsHeader />
      {settings === null && <p className="text-muted">Loading…</p>}
      {settings !== null && (
        <div className="split-main-rail">
          <div className="settings-main">
            <form noValidate onSubmit={save} className="card settings-form">
              <h4>Extraction agent</h4>
              {saveError && <p className="warning" role="alert" style={{ margin: 0 }}>{saveError}</p>}
              {saved && <p className="text-muted" role="status" style={{ margin: 0 }}>Settings saved.</p>}

              <h6 className="section-kicker">Email ingest</h6>
              <div className="field">
                <label htmlFor="st-forward">Forward address</label>
                <input id="st-forward" className="input" placeholder="trips@example.com"
                  value={forwardAddress} onChange={(e) => setForwardAddress(e.target.value)}
                  readOnly={!canWrite} />
              </div>
              <div className="field">
                <label htmlFor="st-allowlist">Sender allowlist</label>
                <textarea id="st-allowlist" className="input" rows={4}
                  placeholder={"you@example.com\nairline.com"} value={allowlistText}
                  onChange={(e) => setAllowlistText(e.target.value)} readOnly={!canWrite} />
                <p className="text-muted field-hint">
                  One address or domain per line. Exact addresses can use verified DKIM
                  when Cloudflare omits its authentication verdict; domain entries require
                  Cloudflare verification. An empty list disables email ingest.
                </p>
              </div>

              <hr className="hr" />
              <h6 className="section-kicker">Extraction model</h6>
              <div className="field">
                <label htmlFor="st-provider">AI provider</label>
                <select id="st-provider" className="input" value={aiProvider}
                  onChange={(e) => setAiProvider(e.target.value as AiProvider)}
                  disabled={!canWrite}>
                  <option value="workers-ai">Workers AI</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </div>

              {aiProvider === "workers-ai" ? (
                <>
                  <div className="field">
                    <label htmlFor="st-model-preset">Extraction model</label>
                    <select id="st-model-preset" className="input" value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)} disabled={!canWrite}>
                      {workersModels.map(({ name, description }) => (
                        <option value={name} key={name} title={description || undefined}>{name}</option>
                      ))}
                    </select>
                    <p className="text-muted field-hint">
                      Only current extraction-compatible models are listed. If strict schema mode
                      fails, Travel HQ retries with validated JSON mode.
                    </p>
                  </div>
                  <div className="field">
                    <label htmlFor="st-ai-max-tokens">Maximum output tokens</label>
                    <input
                      id="st-ai-max-tokens"
                      className="input"
                      type="number"
                      min={MIN_WORKERS_AI_MAX_TOKENS}
                      max={MAX_WORKERS_AI_MAX_TOKENS}
                      step={256}
                      value={aiMaxTokens}
                      onChange={(e) => setAiMaxTokens(e.target.value)}
                      readOnly={!canWrite}
                    />
                    <p className="text-muted field-hint">
                      Includes reasoning and the structured result. Use 4096 for forwarded
                      itineraries; lower values cost less but can truncate extraction.
                    </p>
                  </div>
                </>
              ) : (
                <div className="field">
                  <label htmlFor="st-anthropic-model">Anthropic model</label>
                  <select id="st-anthropic-model" className="input" value={anthropicModel}
                    onChange={(e) => setAnthropicModel(e.target.value)} disabled={!canWrite}>
                    {ANTHROPIC_MODELS.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                </div>
              )}

              <div className="field">
                <label htmlFor="st-anthropic-key">Anthropic API key</label>
                {anthropicKeyConfigured && keyMode === "unchanged" ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span><Key size={14} /> Configured ••••</span>
                    {canWrite && <button type="button" className="btn btn-secondary"
                      onClick={() => setKeyMode("replace")}>Replace</button>}
                    {canWrite && <button type="button" className="btn btn-secondary"
                      onClick={() => setKeyMode("remove")}><Trash size={14} /> Remove</button>}
                  </div>
                ) : keyMode === "remove" ? (
                  <div>
                    <span className="warning">Key will be removed when settings are saved.</span>
                    <button type="button" className="btn btn-ghost"
                      onClick={() => setKeyMode("unchanged")}>Keep configured key</button>
                  </div>
                ) : (
                  <>
                    <input id="st-anthropic-key" className="input" type="password"
                      autoComplete="new-password" placeholder="sk-ant-…"
                      value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)}
                      readOnly={!canWrite} />
                    {anthropicKeyConfigured && <button type="button" className="btn btn-ghost"
                      onClick={() => { setKeyMode("unchanged"); setAnthropicApiKey(""); }}>Cancel replace</button>}
                  </>
                )}
              </div>

              <hr className="hr" />
              <h6 className="section-kicker">Household guidance</h6>
              <div className="field">
                <label htmlFor="st-instructions">Household extraction instructions</label>
                <textarea id="st-instructions" className="input" rows={5}
                  maxLength={MAX_INSTRUCTIONS} value={extractionInstructions}
                  onChange={(e) => setExtractionInstructions(e.target.value)} readOnly={!canWrite} />
                <p className="text-muted field-hint field-hint--end">
                  Guidance is appended after fixed safety/schema rules. {extractionInstructions.length}/{MAX_INSTRUCTIONS}
                </p>
              </div>
              {canWrite && <div><button type="submit" className="btn btn-primary" disabled={busy}>
                <FloppyDisk size={14} /> Save settings
              </button></div>}
            </form>

            <form onSubmit={runTest} className="card settings-form">
              <h4><Flask size={18} style={{ verticalAlign: "-2px" }} /> Test extraction</h4>
              <p className="text-muted" style={{ margin: 0 }}>
                Paste a confirmation to preview extraction. Nothing is saved.
              </p>
              <div className="field">
                <label htmlFor="test-subject">Subject</label>
                <input id="test-subject" className="input" value={testSubject}
                  onChange={(e) => setTestSubject(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="test-body">Email body</label>
                <textarea id="test-body" className="input" rows={8} value={testText}
                  onChange={(e) => setTestText(e.target.value)} />
              </div>
              <div><button type="submit" className="btn btn-primary"
                disabled={testBusy || testText.length === 0}>
                <Flask size={14} /> Run test
              </button></div>
              {testError && <p className="warning" role="alert">{testError}</p>}
              {testBookings.map((booking, index) => (
                <DraftBookingCard booking={booking} key={`${booking.title}-${index}`} />
              ))}
            </form>
          </div>

          <section aria-label="Recent ingest activity" className="rail">
            <h4 className="section-kicker" style={{ margin: 0 }}>Recent ingest activity</h4>
            {activityError && <p className="warning" role="alert" style={{ margin: 0 }}>{activityError}</p>}
            {activity.length === 0 && !activityError ? (
              <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
                <span className="card-title"><Robot size={16} style={{ marginRight: 6 }} />Nothing ingested yet</span>
                <p className="card-body" style={{ margin: 0 }}>
                  Recent extraction results and failures will appear here.
                </p>
              </div>
            ) : (
              <div className="ingest-list">
                {activity.map((email) => (
                  // One interactive element per row: the button IS the card.
                  <article className="ingest-item" key={email.id}>
                    <button type="button" className="ingest-row"
                      aria-label={`View parsed data for ${email.subject || "(no subject)"}`}
                      onClick={() => setViewingEmail(email)}>
                      <span className="ingest-row-top">
                        <span className="ingest-subject">{email.subject || "(no subject)"}</span>
                        <StatusChip status={email.status} />
                      </span>
                      <span className="ingest-from">From {email.from}</span>
                      {email.error && <span className="warning">{email.error}</span>}
                      <time className="card-meta" dateTime={email.receivedAt}>
                        {new Date(email.receivedAt).toLocaleString()}
                      </time>
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      {viewingEmail && (
        <InboundEmailDetailDialog
          email={viewingEmail}
          api={api}
          onClose={() => setViewingEmail(null)}
        />
      )}
    </>
  );
}

function StatusChip({ status }: { status: InboundEmailMetadata["status"] }) {
  // .ingest-status keeps the pill its natural size next to a multi-line
  // subject; the row's top line pins it with align-items: flex-start.
  return (
    <span className={`tag ingest-status ${status === "extracted" ? "tag-accent" : "tag-neutral"}`}>
      {status}
    </span>
  );
}

function SettingsHeader() {
  return (
    <header className="page-header">
      <div className="page-title-group">
        <h3>Settings</h3>
        <p className="page-subline">How the email ingest agent works for this household.</p>
      </div>
    </header>
  );
}
