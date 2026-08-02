import { memo, useEffect, useState } from "react";
import { BellRinging, FloppyDisk, Trash } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type {
  NotificationSettingsResponse,
  PushDeviceView,
  TestNotificationResult,
} from "../api/types.js";
import { currentEndpoint, disablePush, enablePush, pushAvailability } from "../lib/push.js";
import type { PushAvailability } from "../lib/push.js";
import { errorMessage } from "../lib/errors.js";
import "../pages/settings.css";

/*
 * Kept in sync by hand with DEFAULT_REMINDER_LEAD_MINUTES in
 * src/server/repos/notification.ts and MAX_REMINDER_LEAD_MINUTES in
 * src/server/repos/booking.ts. The client may import TYPES from the server but
 * not values, so there is nothing to share — the same arrangement as
 * LOGISTICS_KEYS in components/BookingDetailDialog.tsx.
 */
const DEFAULT_REMINDER_LEAD_MINUTES = 60;
const MAX_REMINDER_LEAD = 7 * 24 * 60;

/**
 * Per-user notification settings (issue #61).
 *
 * It lives under `settings/` and renders on `/me`, which is not a
 * contradiction: it is the settings card that belongs to the PERSON. It used
 * to sit on `/settings` beside email-ingest and extraction-model controls only
 * an owner can change, and being the one card there that ignored
 * `useCanWrite()` was the standing evidence it was in the wrong place.
 *
 * The card is honest about what it cannot do. On an iPhone in a Safari tab
 * there is no button, because there is no API behind one — web push on iOS
 * requires the app to have been installed to the home screen (16.4+) and the
 * permission prompt to come from a real tap. So that state renders the
 * install steps instead, and a denied permission renders how to undo it,
 * rather than a control that would quietly do nothing.
 */
export const NotificationsCard = memo(function NotificationsCard({
  api,
}: {
  api: typeof defaultApi;
}) {
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
         renders even when something else on the page failed to load, since
         notification settings are per-user and independent of everything
         around them. Saying "Loading" here made a page that had already
         reported an error still look like it was mid-load. */}
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
