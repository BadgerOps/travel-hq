import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../../src/client/pages/Settings.js";
import { ApiError } from "../../../src/client/api/client.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type {
  AuditEntry,
  Identity,
  InboundEmailDetail,
  InboundEmailMetadata,
} from "../../../src/client/api/types.js";
import {
  RAW_RETENTION_EXTRACTED_DAYS,
  RAW_RETENTION_UNRESOLVED_DAYS,
} from "../../../src/shared/email-retention.js";
import pkg from "../../../package.json" with { type: "json" };

const SETTINGS = {
  forwardAddress: "trips@badgerops.foo",
  senderAllowlist: ["badger@example.com", "airline.com"],
  aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  aiMaxTokens: 4_096,
  aiProvider: "workers-ai" as const,
  anthropicModel: "claude-opus-4-8",
  anthropicKeyConfigured: false,
  extractionInstructions: "",
};

function makeApi(over: Record<string, unknown> = {}) {
  return {
    settings: {
      get: vi.fn(async () => SETTINGS),
      update: vi.fn(async (input: Record<string, unknown>) => ({ ...SETTINGS, ...input })),
      testExtraction: vi.fn(async () => ({ bookings: [] })),
      // Empty catalog: the component keeps its built-in presets, so the
      // existing tests see the same options they always did.
      aiModels: vi.fn(async () => ({ models: [] })),
      ...over,
    },
    inboundEmails: {
      list: vi.fn(async (): Promise<InboundEmailMetadata[]> => []),
      get: vi.fn(async (): Promise<InboundEmailDetail> => {
        throw new Error("inboundEmails.get not mocked");
      }),
    },
    audit: {
      reveals: vi.fn(async (): Promise<AuditEntry[]> => []),
    },
    notifications: makeNotificationsApi(),
  };
}

const NOTIFICATION_STATE = {
  preferences: {
    digestEnabled: false,
    digestSendTime: null as string | null,
    remindersEnabled: true,
    reminderLeadMinutes: 60,
  },
  timezone: { timezone: null as string | null, source: null, updatedAt: null as string | null },
  vapidPublicKey: "test-key",
};

/**
 * The per-user notification group. Split out of makeApi so a test can hand it
 * its own devices or its own test-notification results without restating the
 * whole client.
 */
function makeNotificationsApi(over: Record<string, unknown> = {}) {
  return {
    preferences: vi.fn(async () => NOTIFICATION_STATE),
    update: vi.fn(async (input: Record<string, unknown>) => ({
      ...NOTIFICATION_STATE,
      preferences: { ...NOTIFICATION_STATE.preferences, ...input },
    })),
    setTimezone: vi.fn(async (timezone: string | null, source: string) => ({
      ...NOTIFICATION_STATE,
      timezone: { timezone, source, updatedAt: "2026-08-01T00:00:00.000Z" },
    })),
    devices: vi.fn(async () => ({ devices: [] as unknown[] })),
    registerDevice: vi.fn(),
    removeDevice: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ results: [] as unknown[] })),
    forBooking: vi.fn(),
    setBooking: vi.fn(),
    setTrip: vi.fn(),
    ...over,
  };
}

function asRole(role: Identity["role"], ui: ReactNode) {
  const me = async () => ({
    userId: "u1",
    email: "badger@example.com",
    householdId: "hh-a",
    role,
  });
  return render(<IdentityProvider api={{ me } as never}>{ui}</IdentityProvider>);
}

function renderSettings(api = makeApi(), role: Identity["role"] = "owner") {
  asRole(role, <Settings api={api as never} />);
  return api;
}

describe("Settings", () => {
  it("states how long forwarded mail is kept, using the enforced constants", async () => {
    // The point is not the wording but that the numbers on screen are the
    // same ones the purge uses — a hard-coded "30 days" in JSX is how a
    // privacy promise drifts away from the behaviour behind it.
    renderSettings();
    const policy = await screen.findByText(/kept in this household|forwarded mail is stored/i);
    const section = policy.closest(".settings-retention");
    expect(section).not.toBeNull();
    expect(section).toHaveTextContent(`${RAW_RETENTION_EXTRACTED_DAYS} days`);
    expect(section).toHaveTextContent(`${RAW_RETENTION_UNRESOLVED_DAYS} days`);
    expect(section).toHaveTextContent(/stored encrypted/i);
    expect(section).toHaveTextContent(/bookings extracted from it are kept/i);
  });

  it("populates the Workers AI model presets from the catalog endpoint", async () => {
    const api = makeApi({
      aiModels: vi.fn(async () => ({
        models: [
          {
            name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            description: "Meta's 70B instruct",
          },
          { name: "@cf/openai/gpt-oss-20b", description: "OpenAI GPT-OSS 20B" },
        ],
      })),
    });
    renderSettings(api);
    const select = await screen.findByLabelText("Extraction model");
    expect(
      await within(select).findByRole("option", { name: "@cf/openai/gpt-oss-20b" }),
    ).toBeInTheDocument();
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByText(/custom model id/i)).not.toBeInTheDocument();
    expect(api.settings.aiModels).toHaveBeenCalledTimes(1);
  });

  it("keeps the built-in presets when the catalog pull fails", async () => {
    const api = makeApi({
      aiModels: vi.fn(async () => {
        throw new Error("catalog down");
      }),
    });
    renderSettings(api);
    const select = await screen.findByLabelText("Extraction model");
    expect(
      within(select).getByRole("option", {
        name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole("option", { name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
    ).toBeInTheDocument();
  });

  it("renders the three agent-configuration fields from the server", async () => {
    renderSettings();
    expect(await screen.findByLabelText("Forward address")).toHaveValue("trips@badgerops.foo");
    expect(screen.getByLabelText("Sender allowlist")).toHaveValue(
      "badger@example.com\nairline.com",
    );
    expect(screen.getByLabelText("Extraction model")).toHaveValue(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
    expect(screen.getByLabelText("Maximum output tokens")).toHaveValue(4_096);
    expect(screen.getByText(/exact addresses can use verified DKIM/i)).toBeInTheDocument();
    expect(screen.getByText(/domain entries require Cloudflare verification/i)).toBeInTheDocument();
  });

  it("shows the model default when the household has no row yet", async () => {
    const api = makeApi({
      get: vi.fn(async () => ({
        forwardAddress: null,
        senderAllowlist: [],
        aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      })),
    });
    renderSettings(api);
    expect(await screen.findByLabelText("Extraction model")).toHaveValue(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
    expect(screen.getByLabelText("Forward address")).toHaveValue("");
  });

  it("saves the edited fields, splitting the allowlist on lines", async () => {
    const api = renderSettings();
    const allowlist = await screen.findByLabelText("Sender allowlist");
    await userEvent.clear(allowlist);
    await userEvent.type(allowlist, "one@example.com{enter}hotels.com");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
    expect(api.settings.update).toHaveBeenCalledWith(expect.objectContaining({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["one@example.com", "hotels.com"],
      aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    }));
  });

  it("saves an in-app household model change", async () => {
    const api = renderSettings();
    const model = await screen.findByLabelText("Extraction model");
    await userEvent.selectOptions(model, "@cf/openai/gpt-oss-20b");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));

    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
    expect(api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ aiModel: "@cf/openai/gpt-oss-20b" }),
    );
    expect(screen.getByText(/only current extraction-compatible models/i)).toBeInTheDocument();
  });

  it("saves and validates the Workers AI output-token budget", async () => {
    const api = renderSettings();
    const tokens = await screen.findByLabelText("Maximum output tokens");
    await userEvent.clear(tokens);
    await userEvent.type(tokens, "6144");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ aiMaxTokens: 6_144 }),
    );

    await userEvent.clear(tokens);
    await userEvent.type(tokens, "9000");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/256 to 8192/);
  });

  it("sends null for a cleared forward address", async () => {
    const api = renderSettings();
    await userEvent.clear(await screen.findByLabelText("Forward address"));
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
    expect(api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ forwardAddress: null }),
    );
  });

  it("rejects an obviously malformed forward address before calling the server", async () => {
    const api = renderSettings();
    const address = await screen.findByLabelText("Forward address");
    await userEvent.clear(address);
    await userEvent.type(address, "not-an-address");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(api.settings.update).not.toHaveBeenCalled();
  });

  it("shows the owners-and-adults card to a viewer (server 403), not the form", async () => {
    const api = makeApi({
      get: vi.fn(async () => {
        throw new ApiError("/api/settings failed: Forbidden", 403);
      }),
    });
    renderSettings(api, "viewer");
    expect(await screen.findByText(/owners and adults only/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Forward address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save settings/i })).not.toBeInTheDocument();
  });

  it("reports a failed load rather than looking unconfigured", async () => {
    const api = makeApi({
      get: vi.fn(async () => {
        throw new ApiError("/api/settings failed: boom", 500);
      }),
    });
    renderSettings(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Forward address")).not.toBeInTheDocument();
  });

  it("keeps the operator's input when a save is rejected", async () => {
    const api = makeApi({
      update: vi.fn(async () => {
        throw new ApiError("/api/settings failed: Invalid settings", 400);
      }),
    });
    renderSettings(api);
    const model = await screen.findByLabelText("Extraction model");
    await userEvent.selectOptions(model, "@cf/openai/gpt-oss-20b");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(model).toHaveValue("@cf/openai/gpt-oss-20b");
  });

  it("renders the ingest-activity placeholder with an honest empty state", async () => {
    renderSettings();
    await screen.findByLabelText("Forward address");
    const section = screen.getByRole("region", { name: /recent ingest activity/i });
    expect(section).toBeInTheDocument();
    expect(screen.getByText(/nothing ingested yet/i)).toBeInTheDocument();
  });

  /**
   * The build string only earns its place if it is the real one. Comparing
   * against package.json (rather than a literal, or against __APP_VERSION__
   * itself — which would pass even if the define were echoing nothing) is what
   * makes this catch the likely failure: the constant is injected by a `define`
   * that the client config has to repeat, and a missing one renders
   * "vundefined" while every other test still passes.
   */
  it("shows the running version so a bug report can name its build", async () => {
    renderSettings();
    const about = await screen.findByRole("region", { name: /about this build/i });
    expect(within(about).getByText(`v${pkg.version}`)).toBeInTheDocument();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(about).toHaveTextContent(/quote this version/i);
  });

  it("still shows the version to a viewer who cannot read the settings", async () => {
    // A viewer sees only the "owners and adults only" card, and is exactly the
    // person most likely to be reporting a problem to someone else.
    const api = makeApi({
      get: vi.fn(async () => {
        throw new ApiError("/api/settings failed: Forbidden", 403);
      }),
    });
    renderSettings(api, "viewer");
    const about = await screen.findByRole("region", { name: /about this build/i });
    expect(within(about).getByText(`v${pkg.version}`)).toBeInTheDocument();
  });

  it("configures Anthropic with a write-only key and instruction counter", async () => {
    const api = renderSettings();
    await screen.findByLabelText("AI provider");
    await userEvent.selectOptions(screen.getByLabelText("AI provider"), "anthropic");
    expect(screen.getByLabelText("Anthropic model")).toHaveValue("claude-opus-4-8");
    await userEvent.type(screen.getByLabelText("Anthropic API key"), "sk-ant-new");
    await userEvent.type(
      screen.getByLabelText("Household extraction instructions"),
      "Prefer BOI.",
    );
    expect(screen.getByText(/11\/2000/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(api.settings.update).toHaveBeenCalledWith(expect.objectContaining({
      aiProvider: "anthropic",
      anthropicApiKey: "sk-ant-new",
      extractionInstructions: "Prefer BOI.",
    }));
  });

  it("shows configured key controls without rendering a key value even on Workers AI", async () => {
    const api = makeApi({
      get: vi.fn(async () => ({
        ...SETTINGS,
        anthropicKeyConfigured: true,
      })),
    });
    renderSettings(api);
    expect(await screen.findByText(/configured ••••/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/sk-ant/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("runs a dry extraction and renders draft-style results", async () => {
    const api = makeApi({
      testExtraction: vi.fn(async () => ({
        bookings: [{
          kind: "flight",
          title: "BOI to STS",
          location: "Boise",
          startsAt: null,
          startsAtTz: null,
          endsAt: null,
          endsAtTz: null,
          confirmationNumber: "FLY123",
          costCents: null,
          details: {},
        }],
      })),
    });
    renderSettings(api);
    await screen.findByLabelText("Email body");
    await userEvent.type(screen.getByLabelText("Subject"), "Flight");
    await userEvent.type(screen.getByLabelText("Email body"), "Confirmation FLY123");
    await userEvent.click(screen.getByRole("button", { name: /run test/i }));
    expect(await screen.findByText("BOI to STS")).toBeInTheDocument();
    expect(api.settings.testExtraction).toHaveBeenCalledWith({
      subject: "Flight",
      text: "Confirmation FLY123",
    });
  });

  it("renders recent ingest failure metadata", async () => {
    const api = makeApi();
    api.inboundEmails.list.mockResolvedValue([{
      id: "ie-fail",
      from: "airline@example.com",
      to: "trips@example.com",
      subject: "Broken extraction",
      status: "failed",
      error: "Extraction failed: rate limited",
      receivedAt: "2026-07-23T12:00:00.000Z",
    }]);
    renderSettings(api);
    expect(await screen.findByText("Broken extraction")).toBeInTheDocument();
    expect(screen.getByText("Extraction failed: rate limited")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  /**
   * Issue #8: the reveal audit trail is only worth persisting if an owner can
   * actually read it, so the surface is part of the feature, not a follow-up.
   */
  describe("reveal activity", () => {
    const ENTRY: AuditEntry = {
      id: "a1",
      event: "document_reveal",
      actorUserId: "u2",
      actorEmail: "ava@example.com",
      subjectType: "person",
      subjectId: "person-0191c3d4e5f6a7b8",
      field: "passport_number",
      tripId: null,
      // Somebody else's passport number, which is the case this panel exists
      // to surface; a self-reveal is the one it can afford to bury.
      selfService: false,
      fields: null,
      at: "2026-07-29T18:04:00.000Z",
    };

    it("shows who revealed what and when, and says the value is not stored", async () => {
      const api = makeApi();
      api.audit.reveals.mockResolvedValue([ENTRY]);
      renderSettings(api);

      const section = await screen.findByRole("region", { name: /reveal activity/i });
      expect(within(section).getByText(/passport number/i)).toBeInTheDocument();
      expect(within(section).getByText("ava@example.com")).toBeInTheDocument();
      expect(within(section).getByText(/never stored/i)).toBeInTheDocument();
    });

    it("renders an honest empty state rather than an empty box", async () => {
      renderSettings();
      const section = await screen.findByRole("region", { name: /reveal activity/i });
      expect(within(section).getByText(/no reveals yet/i)).toBeInTheDocument();
    });

    /**
     * The endpoint is owner-only and 403s for an adult. A panel that cannot be
     * populated should not be shown at all -- and, crucially, that failure must
     * not surface as an error over the settings form, which works fine.
     */
    it("hides itself when the endpoint denies the caller, without reporting an error", async () => {
      const api = makeApi();
      api.audit.reveals.mockRejectedValue(new ApiError("nope", 403));
      renderSettings(api, "adult");

      await screen.findByLabelText("Forward address");
      expect(screen.queryByRole("region", { name: /reveal activity/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("opens the parsed-data dialog when an ingest activity entry is clicked", async () => {
    const api = makeApi();
    const metadata: InboundEmailMetadata = {
      id: "ie-1",
      from: "sol@example.com",
      to: "trips@example.com",
      subject: "Fwd: Your Silverwood RV Park Reservation",
      status: "extracted",
      error: null,
      receivedAt: "2026-07-27T14:37:17.000Z",
    };
    api.inboundEmails.list.mockResolvedValue([metadata]);
    api.inboundEmails.get.mockResolvedValue({
      ...metadata,
      rawState: "retained",
      rawExpiresAt: "2026-08-03T14:37:17.000Z",
      rawUnavailableReason: null,
      textBody: "Site A12, arriving July 30.",
      calendars: [],
      drafts: [{
        id: "draft-1",
        inboundEmailId: "ie-1",
        ordinal: 0,
        kind: "lodging",
        title: "Silverwood RV Park",
        location: "Athol, ID",
        startsAt: null,
        startsAtTz: null,
        endsAt: null,
        endsAtTz: null,
        confirmationNumber: "RV-4001",
        source: "ai",
        extracted: { costCents: 12_500 },
        status: "pending",
        bookingId: null,
        createdAt: "2026-07-27T14:37:20.000Z",
        resolvedAt: null,
      }],
    });
    renderSettings(api);

    await userEvent.click(await screen.findByRole("button", {
      name: /view parsed data for fwd: your silverwood/i,
    }));

    const dialog = await screen.findByRole("dialog");
    expect(api.inboundEmails.get).toHaveBeenCalledWith("ie-1");
    expect(await within(dialog).findByText("Silverwood RV Park")).toBeInTheDocument();
    expect(within(dialog).getByText("Confirmation RV-4001")).toBeInTheDocument();
    expect(within(dialog).getByText(/site a12, arriving july 30/i)).toBeInTheDocument();
  });
});

/**
 * The Notifications card. It is the one section of this page that belongs to
 * the PERSON rather than the household, and the one that has to be honest
 * about a platform it cannot control.
 */
describe("Settings — notifications", () => {
  function iphoneInASafariTab() {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  }

  function installedPwa() {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: async () => undefined },
      configurable: true,
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "default" });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "userAgent", { value: "vitest", configurable: true });
    Object.defineProperty(navigator, "standalone", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
  });

  /**
   * The explicit acceptance criterion. An "Enable notifications" button in an
   * iOS Safari tab cannot work — the API is absent, not merely restricted — so
   * showing one would be a button that silently does nothing.
   */
  it("shows install instructions, and NO enable button, on an iPhone in a Safari tab", async () => {
    iphoneInASafariTab();
    renderSettings();
    expect(await screen.findByTestId("push-install-instructions")).toHaveTextContent(
      /add to home screen/i,
    );
    expect(screen.queryByRole("button", { name: /enable notifications/i })).toBeNull();
  });

  it("offers the enable button once the PWA is installed to the home screen", async () => {
    installedPwa();
    renderSettings();
    expect(
      await screen.findByRole("button", { name: /enable notifications on this device/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("push-install-instructions")).toBeNull();
  });

  it("explains how to undo a denied permission instead of offering a button that fails", async () => {
    installedPwa();
    vi.stubGlobal("Notification", { permission: "denied" });
    renderSettings();
    expect(await screen.findByTestId("push-denied")).toHaveTextContent(/settings/i);
    expect(screen.queryByRole("button", { name: /enable notifications/i })).toBeNull();
  });

  it("says the SERVER is unconfigured when there is no VAPID key, rather than blaming the device", async () => {
    installedPwa();
    const api = makeApi();
    api.notifications.preferences = vi.fn(async () => ({
      ...NOTIFICATION_STATE,
      vapidPublicKey: null,
      error: "Push notifications are not configured on this server",
    })) as never;
    renderSettings(api);
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable notifications/i })).toBeNull();
  });

  it("saves the digest time and the lead time together", async () => {
    const api = makeApi();
    renderSettings(api);

    // fireEvent.change, never userEvent.type: jsdom leaves a type="time" value
    // empty for typed keystrokes (see tests/client/trip/BookingDialog.test.tsx).
    const time = await screen.findByLabelText(/digest send time/i);
    fireEvent.change(time, { target: { value: "06:45" } });
    await userEvent.click(screen.getByLabelText(/send me a daily digest/i));
    const lead = screen.getByLabelText(/reminder lead time/i);
    fireEvent.change(lead, { target: { value: "0" } });
    await userEvent.click(screen.getByRole("button", { name: /save notification settings/i }));

    // 0 minutes is "right when it starts" — a real lead time, and it must
    // survive as the number 0 rather than being read as "nothing chosen".
    expect(api.notifications.update).toHaveBeenCalledWith({
      digestEnabled: true,
      digestSendTime: "06:45",
      remindersEnabled: true,
      reminderLeadMinutes: 0,
    });
  });

  it("refuses a lead time outside the allowed range without calling the API", async () => {
    const api = makeApi();
    renderSettings(api);
    const lead = await screen.findByLabelText(/reminder lead time/i);
    fireEvent.change(lead, { target: { value: "-5" } });
    await userEvent.click(screen.getByRole("button", { name: /save notification settings/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/whole number of minutes/i);
    expect(api.notifications.update).not.toHaveBeenCalled();
  });

  it("clears the pin before reporting the device zone, so 'use my device's timezone' actually resets", async () => {
    const api = makeApi();
    api.notifications.preferences = vi.fn(async () => ({
      ...NOTIFICATION_STATE,
      timezone: { timezone: "America/Boise", source: "manual", updatedAt: "2026-07-01T00:00:00.000Z" },
    })) as never;
    renderSettings(api);
    expect(await screen.findByText(/pinned by you/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /use my device's timezone/i }));
    // The first call is the clear. Without it, a `device` report cannot
    // displace the pin and the button would appear to do nothing.
    expect(api.notifications.setTimezone).toHaveBeenNthCalledWith(1, null, "device");
    expect(api.notifications.setTimezone).toHaveBeenNthCalledWith(2, expect.any(String), "device");
  });

  it("pins a manually entered zone", async () => {
    const api = makeApi();
    renderSettings(api);
    const field = await screen.findByLabelText(/^timezone$/i);
    await userEvent.type(field, "Asia/Tokyo");
    await userEvent.click(screen.getByRole("button", { name: /pin this timezone/i }));
    expect(api.notifications.setTimezone).toHaveBeenCalledWith("Asia/Tokyo", "manual");
  });

  it("reports the test notification per device, and re-reads the list when one was pruned", async () => {
    const api = makeApi();
    api.notifications.devices = vi
      .fn()
      .mockResolvedValueOnce({
        devices: [
          { id: "d1", endpoint: "https://push.example.com/d1", host: "push.example.com", createdAt: "2026-07-01T00:00:00.000Z", lastSuccessAt: null, failureCount: 0 },
        ],
      })
      .mockResolvedValue({ devices: [] }) as never;
    api.notifications.test = vi.fn(async () => ({
      results: [
        { id: "d1", host: "push.example.com", outcome: "gone" as const, status: 410, reason: null, pruned: true },
      ],
    })) as never;

    renderSettings(api);
    await userEvent.click(await screen.findByRole("button", { name: /send me a test notification/i }));

    const results = await screen.findByRole("list", { name: /test notification results/i });
    expect(results).toHaveTextContent(/no longer reachable/i);
    // The row it just pruned must not still be sitting in "Registered devices".
    expect(api.notifications.devices).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/no devices registered yet/i)).toBeInTheDocument();
  });

  it("does not offer the test button with nothing registered", async () => {
    renderSettings();
    expect(await screen.findByRole("button", { name: /send me a test notification/i })).toBeDisabled();
  });

  it("removes a registered device", async () => {
    const api = makeApi();
    api.notifications.devices = vi.fn(async () => ({
      devices: [
        { id: "d1", endpoint: "https://push.example.com/d1", host: "push.example.com", createdAt: "2026-07-01T00:00:00.000Z", lastSuccessAt: null, failureCount: 0 },
      ],
    })) as never;
    renderSettings(api);
    await userEvent.click(await screen.findByRole("button", { name: /remove push\.example\.com/i }));
    expect(api.notifications.removeDevice).toHaveBeenCalledWith("d1");
  });

  /**
   * A household viewer is refused /api/settings, which is correct — and is
   * exactly the account this feature exists for. Stopping at "not for you"
   * would leave a shared-trip parent no way to register their phone.
   */
  it("still renders for a viewer who is refused the household settings", async () => {
    const api = makeApi({
      get: vi.fn(async () => {
        throw new ApiError("/api/settings failed", 403);
      }),
    });
    renderSettings(api, "viewer");
    expect(await screen.findByText(/owners and adults only/i)).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: /notifications/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/reminder lead time/i)).toBeInTheDocument();
  });
});
