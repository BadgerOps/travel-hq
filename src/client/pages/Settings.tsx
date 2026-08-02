import { memo, useEffect, useState } from "react";
import { BellRinging, Eye, FloppyDisk, Flask, Info, Key, Robot, Trash } from "@phosphor-icons/react";
import { api as defaultApi, ApiError } from "../api/client.js";
import type {
  AiProvider,
  AuditEntry,
  CatalogModel,
  ExtractedBooking,
  HouseholdSettings,
  InboundEmailMetadata,
  NotificationSettingsResponse,
  PushDeviceView,
  TestNotificationResult,
} from "../api/types.js";
import {
  currentEndpoint,
  disablePush,
  enablePush,
  pushAvailability,
} from "../lib/push.js";
import type { PushAvailability } from "../lib/push.js";
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
import {
  RAW_RETENTION_EXTRACTED_DAYS,
  RAW_RETENTION_UNRESOLVED_DAYS,
} from "../../shared/email-retention.js";
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

/*
 * Kept in sync by hand with DEFAULT_REMINDER_LEAD_MINUTES in
 * src/server/repos/notification.ts and MAX_REMINDER_LEAD_MINUTES in
 * src/server/repos/booking.ts. The client may import TYPES from the server but
 * not values, so there is nothing to share — the same arrangement as
 * LOGISTICS_KEYS in components/BookingDetailDialog.tsx.
 */
const DEFAULT_REMINDER_LEAD_MINUTES = 60;
const MAX_REMINDER_LEAD = 7 * 24 * 60;

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
  // Owner-only (the endpoint 403s for anyone else), so this stays null for an
  // admin and the panel simply never renders — the same "not for you" handling
  // the ingest feed already uses, rather than an error nobody can act on.
  const [revealLog, setRevealLog] = useState<AuditEntry[] | null>(null);
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

    const listReveals = api.audit?.reveals;
    if (listReveals) {
      listReveals().then(
        (rows) => {
          if (!cancelled) setRevealLog(rows);
        },
        () => {
          // Swallowed: 403 is the expected answer for a non-owner, and any
          // other failure of an *auxiliary* panel must not take the settings
          // form down with it.
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

  // A household viewer — which every shared-trip account is — gets a 403 from
  // /api/settings and lands here. Their NOTIFICATION settings are still theirs
  // to manage: a parent following a kid's connection has exactly this role, and
  // stopping at "not for you" would leave them no way to register their phone.
  if (forbidden) {
    return (
      <>
        <SettingsHeader />
        <div className="settings-main">
          <div className="card" style={{ maxWidth: 560, alignItems: "flex-start", gap: 10 }}>
            <span className="card-title">Owners and admins only</span>
            <p className="card-body" style={{ margin: 0 }}>
              Household settings control whose email can write into this household, so viewing and
              editing them is limited to owners and admins.
            </p>
          </div>
          <NotificationsCard api={api} />
        </div>
        {/* Still shown to a viewer: the one thing on this page they can use is
            the number that identifies the build they are reporting against. */}
        <AboutBuild />
      </>
    );
  }
  if (loadFailed) {
    return (
      <>
        <SettingsHeader />
        <div className="settings-main">
          <p className="warning" role="alert">{loadFailed}</p>
          <NotificationsCard api={api} />
        </div>
      </>
    );
  }

  return (
    <>
      <SettingsHeader />
      {settings === null && <p className="text-muted">Loading…</p>}
      {settings !== null && (
        <div className="split-main-rail">
          <div className="settings-main">
            {/* First, deliberately: it is the only card on this page that is
                about THIS PERSON rather than about the household. */}
            <NotificationsCard api={api} />
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

              {/* The retention promise, in the place the forwarding address is
                  configured — the moment someone decides to send their mail
                  here is the moment they should learn how long it stays. The
                  day counts come from the same constants the purge enforces,
                  so this paragraph cannot drift away from the behaviour. */}
              <div className="settings-retention">
                <h6 className="section-kicker" style={{ margin: 0 }}>What is kept, and for how long</h6>
                <p className="text-muted" style={{ margin: 0 }}>
                  Forwarded mail is stored encrypted, with the same key ring that protects
                  passport and confirmation numbers. The full message is kept for{" "}
                  <strong>{RAW_RETENTION_EXTRACTED_DAYS} days</strong> after it is extracted
                  successfully, and for up to{" "}
                  <strong>{RAW_RETENTION_UNRESOLVED_DAYS} days</strong> while it is still
                  queued or after extraction failed — long enough to retry a bad extraction
                  or diagnose it.
                </p>
                <p className="text-muted" style={{ margin: 0 }}>
                  After that the message text is deleted automatically. The sender, subject,
                  status and the bookings extracted from it are kept, so your trips are
                  unaffected; the original message simply stops being readable here.
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

          <div className="rail settings-rail">
            <section aria-label="Recent ingest activity">
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

            {revealLog !== null && <RevealLog entries={revealLog} />}

            <AboutBuild />
          </div>
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

/**
 * Per-user notification settings (issue #61).
 *
 * NOT gated on `useCanWrite()`, unlike every other form on this page, and that
 * is the point: nothing here is household data. It is this person's phone,
 * this person's 8am, and the trips this person wants to hear about. A
 * shared-trip account is a household viewer, and it is the account the feature
 * was built for.
 *
 * The card is honest about what it cannot do. On an iPhone in a Safari tab
 * there is no button, because there is no API behind one — web push on iOS
 * requires the app to have been installed to the home screen (16.4+) and the
 * permission prompt to come from a real tap. So that state renders the
 * install steps instead, and a denied permission renders how to undo it,
 * rather than a control that would quietly do nothing.
 */
const NotificationsCard = memo(function NotificationsCard({ api }: { api: typeof defaultApi }) {
  const [state, setState] = useState<NotificationSettingsResponse | null>(null);
  const [devices, setDevices] = useState<PushDeviceView[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [availability, setAvailability] = useState<PushAvailability | null>(null);
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestSendTime, setDigestSendTime] = useState("08:00");
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [leadMinutes, setLeadMinutes] = useState(String(DEFAULT_REMINDER_LEAD_MINUTES));
  const [timezoneDraft, setTimezoneDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestNotificationResult[] | null>(null);

  const group = api.notifications;

  function adopt(next: NotificationSettingsResponse) {
    setState(next);
    setDigestEnabled(next.preferences.digestEnabled);
    setDigestSendTime(next.preferences.digestSendTime ?? "08:00");
    setRemindersEnabled(next.preferences.remindersEnabled);
    setLeadMinutes(String(next.preferences.reminderLeadMinutes));
    setTimezoneDraft(next.timezone.timezone ?? "");
    setAvailability(pushAvailability(next.vapidPublicKey));
  }

  useEffect(() => {
    if (!group) return;
    let cancelled = false;
    group.preferences().then(
      (next) => {
        if (!cancelled) adopt(next);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    group.devices().then(
      (r) => {
        if (!cancelled) setDevices(r.devices);
      },
      () => {
        /* An unreadable device list must not take the preferences down. */
      },
    );
    currentEndpoint().then(
      (endpoint) => {
        if (!cancelled) setThisEndpoint(endpoint);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, group]);

  if (!group) return null;

  const thisDevice = thisEndpoint
    ? (devices.find((device) => device.endpoint === thisEndpoint) ?? null)
    : null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshDevices() {
    setDevices((await group!.devices()).devices);
    setThisEndpoint(await currentEndpoint());
  }

  const enable = () =>
    run(async () => {
      // The key is present exactly when availability is "ready"; the guard is
      // for the type, not for the flow.
      if (!state?.vapidPublicKey) throw new Error("This server has no push key configured.");
      await enablePush(api, state.vapidPublicKey);
      await refreshDevices();
      setNotice("Notifications are on for this device.");
    });

  const disable = () =>
    run(async () => {
      await disablePush(api, thisDevice?.id ?? null);
      await refreshDevices();
      setNotice("Notifications are off for this device.");
    });

  const savePreferences = (event: React.FormEvent) => {
    event.preventDefault();
    // Validated here rather than inside run(): errorMessage() rewrites a
    // thrown Error into the generic "something went wrong" it reserves for
    // transport failures, and a rule the form itself knows deserves to be
    // stated in the words of the field it is about.
    const minutes = Number(leadMinutes.trim());
    if (leadMinutes.trim() === "" || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REMINDER_LEAD) {
      setNotice(null);
      setError(`Reminder lead time must be a whole number of minutes from 0 to ${MAX_REMINDER_LEAD}.`);
      return;
    }
    void run(async () => {
      adopt(
        await group!.update({
          digestEnabled,
          digestSendTime: digestSendTime === "" ? null : digestSendTime,
          remindersEnabled,
          reminderLeadMinutes: minutes,
        }),
      );
      setNotice("Notification settings saved.");
    });
  };

  const pinTimezone = () => {
    // Same reason as savePreferences: a rule this form knows is stated here,
    // not laundered through errorMessage()'s transport-failure wording.
    const zone = timezoneDraft.trim();
    if (zone === "") {
      setNotice(null);
      setError("Enter a timezone name such as America/Los_Angeles.");
      return Promise.resolve();
    }
    return run(async () => {
      adopt(await group!.setTimezone(zone, "manual"));
      setNotice(`Timezone pinned to ${zone}.`);
    });
  };

  const useDeviceTimezone = () =>
    run(async () => {
      // Two calls on purpose. The first clears the value AND the pin — a
      // `device` report cannot displace a `manual` one, so clearing is the only
      // way back to automatic. The second is this device reporting itself,
      // which now lands normally.
      await group!.setTimezone(null, "device");
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      adopt(await group!.setTimezone(zone || null, "device"));
      setNotice("Using this device's timezone.");
    });

  const sendTest = () =>
    run(async () => {
      setTestResults(null);
      const result = await group!.test();
      if (result.error) setError(result.error);
      setTestResults(result.results);
      // A pruned endpoint means the push service told us this device is gone;
      // the list on screen must stop claiming otherwise.
      if (result.results.some((r) => r.pruned)) await refreshDevices();
    });

  const removeDevice = (id: string) =>
    run(async () => {
      await group!.removeDevice(id);
      await refreshDevices();
    });

  return (
    <section className="card settings-form" aria-label="Notifications">
      <h4>
        <BellRinging size={18} style={{ verticalAlign: "-2px" }} /> Notifications
      </h4>
      <p className="text-muted" style={{ margin: 0 }}>
        These settings are yours alone — your devices, your times — and are not shared with the
        rest of the household.
      </p>
      {error && (
        <p className="warning" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="text-muted" role="status" style={{ margin: 0 }}>
          {notice}
        </p>
      )}

      <h6 className="section-kicker">This device</h6>
      {/* "Checking", not "Loading": this is probing what THIS browser can do --
         standalone mode, permission state, whether push exists at all -- and it
         renders even when the household settings above failed to load, since
         notification settings are per-user and independent of them. Saying
         "Loading" here made a page that had already reported an error still look
         like it was mid-load. */}
      {availability === null && (
        <p className="text-muted" style={{ margin: 0 }}>Checking this device…</p>
      )}

      {availability === "needs-install" && (
        <div className="settings-retention" data-testid="push-install-instructions">
          <strong>Add Travel HQ to your Home Screen first</strong>
          <p style={{ margin: 0 }}>
            On iPhone and iPad, notifications only work once the app has been installed — Safari
            tabs cannot receive them at all, so there is no button here that would work.
          </p>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>Tap the Share button in Safari.</li>
            <li>Choose “Add to Home Screen”.</li>
            <li>Open Travel HQ from the new Home Screen icon.</li>
            <li>Come back to this page and turn notifications on.</li>
          </ol>
          <p style={{ margin: 0 }}>Requires iOS or iPadOS 16.4 or newer.</p>
        </div>
      )}

      {availability === "denied" && (
        <div className="settings-retention" data-testid="push-denied">
          <strong>Notifications are blocked for Travel HQ</strong>
          <p style={{ margin: 0 }}>
            The browser will not ask again, so a button here could only fail silently. To undo it
            on iPhone or iPad, open Settings → Notifications → Travel HQ and allow them. In a
            desktop browser, open the site settings from the padlock in the address bar and reset
            the notifications permission, then reload this page.
          </p>
        </div>
      )}

      {availability === "unsupported" && (
        <p className="text-muted" style={{ margin: 0 }}>
          This browser cannot receive push notifications. Your digest and reminder settings below
          are still saved for your other devices.
        </p>
      )}

      {availability === "not-configured" && (
        <p className="text-muted" style={{ margin: 0 }}>
          Push notifications are not configured on this server yet, so no device can be registered.
        </p>
      )}

      {availability === "ready" &&
        (thisDevice ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span>Notifications are on for this device.</span>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void disable()}>
              Turn off on this device
            </button>
          </div>
        ) : (
          <div>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void enable()}>
              <BellRinging size={14} /> Enable notifications on this device
            </button>
          </div>
        ))}

      <div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || devices.length === 0}
          onClick={() => void sendTest()}
        >
          Send me a test notification
        </button>
        <p className="text-muted field-hint">
          Sends one push to every registered device right now, and reports what each one said.
        </p>
      </div>
      {testResults !== null && testResults.length > 0 && (
        <ul className="reveal-list" aria-label="Test notification results">
          {testResults.map((result) => (
            <li className="reveal-item" key={result.id}>
              <span className="reveal-what">{TEST_OUTCOMES[result.outcome]}</span>
              <span className="reveal-who">
                {result.host}
                {result.pruned && " · removed, this device is no longer reachable"}
                {result.reason && ` · ${result.reason}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <hr className="hr" />
      <h6 className="section-kicker">Registered devices</h6>
      {devices.length === 0 ? (
        <p className="text-muted" style={{ margin: 0 }}>
          No devices registered yet.
        </p>
      ) : (
        <ul className="reveal-list" aria-label="Registered devices">
          {devices.map((device) => (
            <li className="reveal-item" key={device.id}>
              <span className="reveal-what">
                {device.host}
                {device.endpoint === thisEndpoint && " · this device"}
              </span>
              <span className="reveal-who">
                Added {new Date(device.createdAt).toLocaleDateString()}
                {device.lastSuccessAt
                  ? ` · last reached ${new Date(device.lastSuccessAt).toLocaleDateString()}`
                  : " · never reached yet"}
              </span>
              <div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  aria-label={`Remove ${device.host}`}
                  onClick={() => void removeDevice(device.id)}
                >
                  <Trash size={14} /> Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <hr className="hr" />
      <form noValidate onSubmit={savePreferences} style={{ display: "grid", gap: 14 }}>
        <h6 className="section-kicker">Reminders and digest</h6>
        <div className="field">
          <label htmlFor="nt-reminders">
            <input
              id="nt-reminders"
              type="checkbox"
              checked={remindersEnabled}
              onChange={(e) => setRemindersEnabled(e.target.checked)}
            />{" "}
            Remind me before a booking starts
          </label>
        </div>
        <div className="field">
          <label htmlFor="nt-lead">Reminder lead time (minutes)</label>
          <input
            id="nt-lead"
            className="input"
            type="number"
            min={0}
            max={MAX_REMINDER_LEAD}
            value={leadMinutes}
            onChange={(e) => setLeadMinutes(e.target.value)}
          />
          <p className="text-muted field-hint">
            How long before a booking starts you hear about it, unless that booking has its own
            override. 0 means “right when it starts”.
          </p>
        </div>
        <div className="field">
          <label htmlFor="nt-digest">
            <input
              id="nt-digest"
              type="checkbox"
              checked={digestEnabled}
              onChange={(e) => setDigestEnabled(e.target.checked)}
            />{" "}
            Send me a daily digest
          </label>
        </div>
        <div className="field">
          <label htmlFor="nt-digest-time">Digest send time</label>
          <input
            id="nt-digest-time"
            className="input"
            type="time"
            value={digestSendTime}
            onChange={(e) => setDigestSendTime(e.target.value)}
          />
          <p className="text-muted field-hint">
            A local wall clock in your own timezone, below — not a fixed instant.
          </p>
        </div>
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <FloppyDisk size={14} /> Save notification settings
          </button>
        </div>
      </form>

      <hr className="hr" />
      <h6 className="section-kicker">Timezone</h6>
      <p className="text-muted" style={{ margin: 0 }}>
        {state?.timezone.timezone
          ? `Currently ${state.timezone.timezone} (${
              state.timezone.source === "manual" ? "pinned by you" : "reported by your device"
            }).`
          : "No timezone stored yet. Your device reports one automatically when you open Travel HQ."}
      </p>
      <div className="field">
        <label htmlFor="nt-timezone">Timezone</label>
        <input
          id="nt-timezone"
          className="input"
          placeholder="America/Los_Angeles"
          value={timezoneDraft}
          onChange={(e) => setTimezoneDraft(e.target.value)}
        />
        <p className="text-muted field-hint">
          Pinning a zone keeps it through a trip: your device's automatic reports will not
          overwrite it.
        </p>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void pinTimezone()}>
          Pin this timezone
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void useDeviceTimezone()}>
          Use my device's timezone
        </button>
      </div>
    </section>
  );
});

/** Plain language for sendPush's outcome union — a lock-screen diagnosis. */
const TEST_OUTCOMES: Record<TestNotificationResult["outcome"], string> = {
  sent: "Delivered to the push service",
  gone: "This device is no longer reachable",
  retryable: "The push service is temporarily unavailable",
  failed: "The push service rejected it",
  invalid: "Travel HQ refused to send it",
};

/** "passport_number" → "Passport number". Field NAMES only ever reach here. */
function fieldLabel(field: string | null): string {
  // Nullable since audit_log started carrying events other than reveals: an
  // edit names its fields in `fields`, not in the single `field` column. This
  // panel lists reveals only, so the fallback should never render -- it is
  // here because "Reveal" is a better thing to show than a crash if it does.
  if (!field) return "Reveal";
  const words = field.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A stable, human-quotable handle for the record that was revealed. The full
 * id is a UUID nobody can read aloud; the tail is enough for an owner to match
 * an entry against a booking or person they are looking at, and it is what
 * they would paste into a question about it.
 */
function shortRef(id: string): string {
  return id.length > 8 ? `…${id.slice(-8)}` : id;
}

/**
 * The owner-visible reveal audit trail (issue #8). Renders WHO unmasked WHICH
 * record's WHICH field, and WHEN.
 *
 * It cannot render the revealed value because the server never stored one —
 * `audit_log` has no column that could hold it (see
 * migrations/0016_audit_log.sql). That is the point of the panel, not a
 * limitation of it, so the footnote says so out loud: an owner reading an
 * audit trail deserves to know what it does and does not retain.
 */
function RevealLog({ entries }: { entries: AuditEntry[] }) {
  return (
    <section aria-label="Reveal activity">
      <h4 className="section-kicker" style={{ margin: 0 }}>Reveal activity</h4>
      {entries.length === 0 ? (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">
            <Eye size={16} style={{ marginRight: 6 }} />No reveals yet
          </span>
          <p className="card-body" style={{ margin: 0 }}>
            Unmasking a passport, Known Traveler, redress or confirmation number is recorded
            here — who did it and when, never the number itself.
          </p>
        </div>
      ) : (
        <>
          <ul className="reveal-list">
            {entries.map((entry) => (
              <li className="reveal-item" key={entry.id}>
                <span className="reveal-what">
                  {fieldLabel(entry.field)}
                  {" · "}
                  <span className="reveal-ref">
                    {entry.subjectType} {shortRef(entry.subjectId)}
                  </span>
                </span>
                <span className="reveal-who">{entry.actorEmail}</span>
                <time className="card-meta" dateTime={entry.at}>
                  {new Date(entry.at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
          <p className="text-muted field-hint" style={{ margin: 0 }}>
            Revealed values are never stored in this log.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The running build, parked at the foot of the rail. Nobody comes to Settings
 * looking for it, so it is deliberately quiet — but a bug report is worth far
 * more when it can name the build it came from instead of describing it, and
 * "the configuration screen" is where people already go hunting for that kind
 * of fact.
 *
 * __APP_VERSION__ is substituted at build time from package.json's `version`
 * (see the `define` in vite.config.ts, mirrored in vitest.client.config.ts).
 * It is not a string typed in here, because a hand-copied number is exactly
 * the thing that goes stale a release later and then misidentifies the build
 * in every report that quotes it.
 */
function AboutBuild() {
  return (
    <section aria-label="About this build">
      <h4 className="section-kicker" style={{ margin: 0 }}>About this build</h4>
      <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
        <span className="card-title">
          <Info size={16} style={{ marginRight: 6 }} />
          Travel HQ <span className="build-version">v{__APP_VERSION__}</span>
        </span>
        <p className="card-body text-muted" style={{ margin: 0 }}>
          Quote this version when reporting a problem — it identifies the exact
          build you were using. What changed in each release is recorded in
          CHANGELOG.md.
        </p>
      </div>
    </section>
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
