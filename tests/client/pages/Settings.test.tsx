import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../../src/client/pages/Settings.js";
import { ApiError } from "../../../src/client/api/client.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type {
  Identity,
  InboundEmailDetail,
  InboundEmailMetadata,
} from "../../../src/client/api/types.js";

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
