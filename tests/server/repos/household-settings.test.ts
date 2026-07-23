import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  HouseholdSettingsRepo,
  DEFAULT_AI_MODEL,
  defaultHouseholdSettings,
} from "../../../src/server/repos/household-settings.js";
import { ForbiddenError, ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "adult" };
const ring = new Keyring("test-v1", { "test-v1": crypto.getRandomValues(new Uint8Array(32)) });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
});

describe("HouseholdSettingsRepo", () => {
  it("returns the defaults when the household has no row yet", async () => {
    const settings = await new HouseholdSettingsRepo(env.DB, ctxA).getSettings();
    expect(settings).toEqual(defaultHouseholdSettings());
  });

  it("pins the default model id, which #6 imports", () => {
    expect(DEFAULT_AI_MODEL).toBe("@cf/meta/llama-3.1-8b-instruct");
  });

  it("round-trips forward address, allowlist, and model", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    await repo.updateSettings({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["badger@example.com", "airline.com"],
      aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
    expect(await repo.getSettings()).toMatchObject({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["badger@example.com", "airline.com"],
      aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
  });

  it("normalizes: lowercases addresses, trims, and de-duplicates the allowlist", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    const settings = await repo.updateSettings({
      forwardAddress: "  Trips@BadgerOps.Foo ",
      senderAllowlist: ["Badger@Example.com", "badger@example.com", " AIRLINE.com "],
    });
    expect(settings.forwardAddress).toBe("trips@badgerops.foo");
    expect(settings.senderAllowlist).toEqual(["badger@example.com", "airline.com"]);
  });

  it("leaves absent fields unchanged and upserts into a single row", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    await repo.updateSettings({ forwardAddress: "trips@badgerops.foo" });
    await repo.updateSettings({ senderAllowlist: ["badger@example.com"] });
    const settings = await repo.getSettings();
    expect(settings.forwardAddress).toBe("trips@badgerops.foo");
    expect(settings.senderAllowlist).toEqual(["badger@example.com"]);
    expect(settings.aiModel).toBe(DEFAULT_AI_MODEL);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM household_settings WHERE household_id = ?",
    ).bind("hh-a").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("clears the forward address with null (ingest off)", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    await repo.updateSettings({ forwardAddress: "trips@badgerops.foo" });
    const settings = await repo.updateSettings({ forwardAddress: null });
    expect(settings.forwardAddress).toBeNull();
  });

  it("is tenant-scoped: household B never sees A's settings", async () => {
    await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["badger@example.com"],
    });
    expect(await new HouseholdSettingsRepo(env.DB, ctxB).getSettings()).toEqual(
      defaultHouseholdSettings(),
    );
  });

  it("blocks a viewer from reading settings", async () => {
    const viewer = new HouseholdSettingsRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.getSettings()).rejects.toThrow(ForbiddenError);
  });

  it("blocks a viewer from writing settings", async () => {
    const viewer = new HouseholdSettingsRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.updateSettings({ aiModel: "x" })).rejects.toThrow(ForbiddenError);
  });

  it("rejects a malformed forward address", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    await expect(repo.updateSettings({ forwardAddress: "not-an-address" })).rejects.toThrow(
      ValidationError,
    );
    await expect(repo.updateSettings({ forwardAddress: "two words@example.com" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects blank or multi-token allowlist entries", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    await expect(repo.updateSettings({ senderAllowlist: ["  "] })).rejects.toThrow(ValidationError);
    await expect(repo.updateSettings({ senderAllowlist: ["a@b.com c@d.com"] })).rejects.toThrow(
      ValidationError,
    );
    await expect(repo.updateSettings({ senderAllowlist: ["a@b@c.com"] })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects a blank model id", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    await expect(repo.updateSettings({ aiModel: "   " })).rejects.toThrow(ValidationError);
  });

  it("enforces provider, instructions, encrypted key tri-state, and the mask trap", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA, ring);
    await expect(
      repo.updateSettings({ aiProvider: "bogus" as never }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.updateSettings({ aiProvider: "anthropic" }),
    ).rejects.toThrow(/API key/i);
    await expect(
      repo.updateSettings({ extractionInstructions: "x".repeat(2_001) }),
    ).rejects.toThrow(ValidationError);

    const saved = await repo.updateSettings({
      aiProvider: "anthropic",
      anthropicApiKey: "sk-ant-household-secret",
      extractionInstructions: "Prefer the traveler's local airport.",
    });
    expect(saved).toMatchObject({
      aiProvider: "anthropic",
      anthropicKeyConfigured: true,
      extractionInstructions: "Prefer the traveler's local airport.",
    });
    expect(saved).not.toHaveProperty("anthropicApiKey");

    const before = await env.DB.prepare(
      "SELECT anthropic_api_key FROM household_settings WHERE household_id = ?",
    ).bind("hh-a").first<{ anthropic_api_key: string }>();
    expect(before?.anthropic_api_key).toMatch(/^v1\./);
    expect(before?.anthropic_api_key).not.toContain("household-secret");

    await expect(
      repo.updateSettings({ anthropicApiKey: "Configured ••••" }),
    ).rejects.toThrow(ValidationError);
    const after = await env.DB.prepare(
      "SELECT anthropic_api_key FROM household_settings WHERE household_id = ?",
    ).bind("hh-a").first<{ anthropic_api_key: string }>();
    expect(after).toEqual(before);

    await repo.updateSettings({ extractionInstructions: "Keep this", aiModel: "@cf/new" });
    expect((await repo.getSettings()).anthropicKeyConfigured).toBe(true);
    const cleared = await repo.updateSettings({
      aiProvider: "workers-ai",
      anthropicApiKey: null,
    });
    expect(cleared.anthropicKeyConfigured).toBe(false);
  });

  it("rejects a forward address another household already claimed", async () => {
    await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
      forwardAddress: "trips@badgerops.foo",
    });
    await expect(
      new HouseholdSettingsRepo(env.DB, ctxB).updateSettings({
        forwardAddress: "trips@badgerops.foo",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("lets a household re-save its own forward address", async () => {
    const repo = new HouseholdSettingsRepo(env.DB, ctxA);
    await repo.updateSettings({ forwardAddress: "trips@badgerops.foo" });
    const settings = await repo.updateSettings({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["badger@example.com"],
    });
    expect(settings.forwardAddress).toBe("trips@badgerops.foo");
  });

  describe("findHouseholdByForwardAddress (the ingest handler's entry point)", () => {
    it("resolves the household id and its settings from a To: address", async () => {
      await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
        forwardAddress: "trips@badgerops.foo",
        senderAllowlist: ["badger@example.com"],
      });
      const match = await HouseholdSettingsRepo.findHouseholdByForwardAddress(
        env.DB,
        "trips@badgerops.foo",
      );
      expect(match).toMatchObject({
        householdId: "hh-a",
        settings: {
          forwardAddress: "trips@badgerops.foo",
          senderAllowlist: ["badger@example.com"],
          aiModel: DEFAULT_AI_MODEL,
        },
      });
    });

    it("matches case-insensitively and ignores surrounding whitespace", async () => {
      await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
        forwardAddress: "trips@badgerops.foo",
      });
      const match = await HouseholdSettingsRepo.findHouseholdByForwardAddress(
        env.DB,
        " Trips@BadgerOps.FOO ",
      );
      expect(match?.householdId).toBe("hh-a");
    });

    it("returns undefined for an unclaimed or blank address", async () => {
      expect(
        await HouseholdSettingsRepo.findHouseholdByForwardAddress(env.DB, "nobody@example.com"),
      ).toBeUndefined();
      expect(await HouseholdSettingsRepo.findHouseholdByForwardAddress(env.DB, "  ")).toBeUndefined();
    });
  });
});
