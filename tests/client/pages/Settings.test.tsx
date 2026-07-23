import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../../src/client/pages/Settings.js";
import { ApiError } from "../../../src/client/api/client.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity } from "../../../src/client/api/types.js";

const SETTINGS = {
  forwardAddress: "trips@badgerops.foo",
  senderAllowlist: ["badger@example.com", "airline.com"],
  aiModel: "@cf/meta/llama-3.1-8b-instruct",
};

function makeApi(over: Record<string, unknown> = {}) {
  return {
    settings: {
      get: vi.fn(async () => SETTINGS),
      update: vi.fn(async (input: Record<string, unknown>) => ({ ...SETTINGS, ...input })),
      ...over,
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
    expect(api.settings.update).toHaveBeenCalledWith({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["one@example.com", "hotels.com"],
      aiModel: "@cf/meta/llama-3.1-8b-instruct",
    });
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
    await userEvent.clear(model);
    await userEvent.type(model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(model).toHaveValue("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("renders the ingest-activity placeholder with an honest empty state", async () => {
    renderSettings();
    await screen.findByLabelText("Forward address");
    const section = screen.getByRole("region", { name: /recent ingest activity/i });
    expect(section).toBeInTheDocument();
    expect(screen.getByText(/nothing ingested yet/i)).toBeInTheDocument();
  });
});
