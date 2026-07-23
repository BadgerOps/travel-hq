import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../../src/client/pages/Settings.js";
import { ApiError } from "../../../src/client/api/client.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity, InboundEmailMetadata } from "../../../src/client/api/types.js";

const SETTINGS = {
  forwardAddress: "trips@badgerops.foo",
  senderAllowlist: ["badger@example.com", "airline.com"],
  aiModel: "@cf/meta/llama-3.1-8b-instruct",
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
      ...over,
    },
    inboundEmails: { list: vi.fn(async (): Promise<InboundEmailMetadata[]> => []) },
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
  it("renders the three agent-configuration fields from the server", async () => {
    renderSettings();
    expect(await screen.findByLabelText("Forward address")).toHaveValue("trips@badgerops.foo");
    expect(screen.getByLabelText("Sender allowlist")).toHaveValue(
      "badger@example.com\nairline.com",
    );
    expect(screen.getByLabelText("Extraction model")).toHaveValue(
      "@cf/meta/llama-3.1-8b-instruct",
    );
  });

  it("shows the model default when the household has no row yet", async () => {
    const api = makeApi({
      get: vi.fn(async () => ({
        forwardAddress: null,
        senderAllowlist: [],
        aiModel: "@cf/meta/llama-3.1-8b-instruct",
      })),
    });
    renderSettings(api);
    expect(await screen.findByLabelText("Extraction model")).toHaveValue(
      "@cf/meta/llama-3.1-8b-instruct",
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
      aiModel: "@cf/meta/llama-3.1-8b-instruct",
    }));
  });

  it("saves an in-app household model change", async () => {
    const api = renderSettings();
    const model = await screen.findByLabelText("Extraction model");
    await userEvent.selectOptions(model, "__custom__");
    const custom = screen.getByLabelText("Custom Workers AI model id");
    await userEvent.type(custom, "@cf/meta/custom-travel-model");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));

    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
    expect(api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ aiModel: "@cf/meta/custom-travel-model" }),
    );
    expect(screen.getByText(/saved for this household in travel hq/i)).toBeInTheDocument();
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
    await userEvent.selectOptions(model, "__custom__");
    const custom = screen.getByLabelText("Custom Workers AI model id");
    await userEvent.type(custom, "@cf/meta/custom-travel-model");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(custom).toHaveValue("@cf/meta/custom-travel-model");
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
});
