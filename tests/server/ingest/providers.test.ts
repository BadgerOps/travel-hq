import { describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  WorkersAiProvider,
  resolveExtractionProvider,
} from "../../../src/server/ingest/providers.js";
import { EXTRACTED_JSON_SCHEMA, ExtractionError } from "../../../src/server/ingest/extracted.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import type { IngestHouseholdSettings } from "../../../src/server/repos/household-settings.js";

const BOOKING = {
  kind: "lodging",
  title: "Dawn Ranch",
  location: null,
  startsAt: null,
  startsAtTz: null,
  endsAt: null,
  endsAtTz: null,
  confirmationNumber: "ABC123",
  costCents: null,
  travelerEmails: [
    " DAVID@example.com ",
    "david@example.com",
    "not an email",
  ],
  details: {},
};
const PROMPT = { system: "fixed rules", user: "confirmation" };

describe("extraction providers", () => {
  it("uses Workers AI JSON schema mode and validates the complete result", async () => {
    const run = vi.fn(async () => ({ response: { bookings: [BOOKING] } }));
    const provider = new WorkersAiProvider({ run }, "@cf/test", 2_048);
    expect(await provider.extract(PROMPT)).toMatchObject([{
      title: "Dawn Ranch",
      travelerEmails: ["david@example.com"],
    }]);
    expect(run).toHaveBeenCalledWith("@cf/test", {
      messages: [
        { role: "system", content: "fixed rules" },
        { role: "user", content: "confirmation" },
      ],
      response_format: { type: "json_schema", json_schema: EXTRACTED_JSON_SCHEMA },
      max_tokens: 2_048,
    });
  });

  it("retries a 5024 schema failure in JSON-object mode with the schema in the prompt", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("5024: JSON Model couldn't be met"))
      .mockResolvedValueOnce({ response: { bookings: [BOOKING] } });
    const provider = new WorkersAiProvider({ run }, "@cf/meta/llama-3.3", 4_096);

    expect(await provider.extract(PROMPT)).toMatchObject([{ title: "Dawn Ranch" }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(2, "@cf/meta/llama-3.3", {
      messages: [
        {
          role: "system",
          content: expect.stringContaining(JSON.stringify(EXTRACTED_JSON_SCHEMA)),
        },
        { role: "user", content: "confirmation" },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4_096,
    });
  });

  it("does not retry unrelated Workers AI failures", async () => {
    const run = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const provider = new WorkersAiProvider({ run }, "@cf/test");
    await expect(provider.extract(PROMPT)).rejects.toThrow(/rate limited/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("accepts the OpenAI-compatible response envelope used by current models", async () => {
    const run = vi.fn(async () => ({
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({ bookings: [BOOKING] }),
        },
      }],
    }));
    const provider = new WorkersAiProvider({ run }, "@cf/openai/gpt-oss-20b");
    expect(await provider.extract(PROMPT)).toMatchObject([{ title: "Dawn Ranch" }]);
  });

  it("unwraps valid fenced and prose-wrapped JSON without relaxing JSON syntax", async () => {
    const json = JSON.stringify({
      bookings: [{ ...BOOKING, details: { note: "gate {A12}" } }],
    });
    const fenced = new WorkersAiProvider({
      run: vi.fn(async () => ({ response: `\`\`\`json\n${json}\n\`\`\`` })),
    }, "@cf/test");
    await expect(fenced.extract(PROMPT)).resolves.toMatchObject([
      { title: "Dawn Ranch", details: { note: "gate {A12}" } },
    ]);

    const prose = new WorkersAiProvider({
      run: vi.fn(async () => ({
        choices: [{
          message: { content: `<think>extraction complete</think>\nHere is the result:\n${json}\nDone.` },
        }],
      })),
    }, "@cf/test");
    await expect(prose.extract(PROMPT)).resolves.toMatchObject([
      { confirmationNumber: "ABC123" },
    ]);

    const invalid = new WorkersAiProvider({
      run: vi.fn(async () => ({
        response: "Result: {'bookings': [],}",
      })),
    }, "@cf/test");
    await expect(invalid.extract(PROMPT)).rejects.toThrow(/not valid JSON/);
  });

  it("reports malformed, empty, and refused Workers AI responses clearly", async () => {
    const malformed = new WorkersAiProvider({
      run: vi.fn(async () => ({ choices: [{ message: { content: "not json" } }] })),
    }, "@cf/test");
    await expect(malformed.extract(PROMPT)).rejects.toThrow(/not valid JSON/);

    const empty = new WorkersAiProvider({
      run: vi.fn(async () => ({
        choices: [{
          finish_reason: "length",
          message: { content: "", reasoning: "used the available budget" },
        }],
        usage: { completion_tokens: 256, total_tokens: 1_024 },
      })),
    }, "@cf/test");
    await expect(empty.extract(PROMPT)).rejects.toThrow(
      /model=@cf\/test, finish_reason=length, reasoning_chars=25, output_tokens=256, total_tokens=1024/,
    );

    const refused = new WorkersAiProvider({
      run: vi.fn(async () => ({
        choices: [{ message: { content: "", refusal: "cannot comply" } }],
      })),
    }, "@cf/test");
    await expect(refused.extract(PROMPT)).rejects.toThrow(/refused/);
  });

  it("reports the token limit when truncated output still contains a complete inner object", async () => {
    // Real shape observed from @cf/qwen/qwen3-30b-a3b-fp8: reasoning burns the
    // budget, content is cut mid-array, and the first booking object is the
    // only balanced JSON in the string. That fragment must never be salvaged
    // and validated as the response envelope.
    const truncated = `{"bookings": [${JSON.stringify(BOOKING)}, {"confirmationNumber": "254`;
    const run = vi.fn(async () => ({
      choices: [{
        finish_reason: "length",
        message: { content: truncated, reasoning: "long deliberation" },
      }],
      usage: { completion_tokens: 2_048, total_tokens: 7_837 },
    }));
    const provider = new WorkersAiProvider({ run }, "@cf/qwen/qwen3-30b-a3b-fp8", 2_048);
    await expect(provider.extract(PROMPT)).rejects.toThrow(
      /ran out of output tokens.*model=@cf\/qwen\/qwen3-30b-a3b-fp8.*max_tokens=2048/,
    );
    await expect(provider.extract(PROMPT)).rejects.not.toThrow(/bookings.*\[\.\.\.\]/);
  });

  it("reports the token limit when the truncated payload arrives in the legacy response field", async () => {
    // qwen3 (observed live) populates BOTH the legacy top-level `response`
    // and the OpenAI `choices` envelope; the payload path must not decide
    // whether the finish_reason diagnosis applies.
    const truncated = `{"bookings": [${JSON.stringify(BOOKING)}, {"confirmationNumber": "254`;
    const run = vi.fn(async () => ({
      response: truncated,
      choices: [{
        finish_reason: "length",
        message: { content: truncated, reasoning: "long deliberation" },
      }],
      usage: { completion_tokens: 4_096, total_tokens: 7_837 },
    }));
    const provider = new WorkersAiProvider({ run }, "@cf/qwen/qwen3-30b-a3b-fp8", 4_096);
    await expect(provider.extract(PROMPT)).rejects.toThrow(
      /ran out of output tokens.*max_tokens=4096/,
    );
  });

  it("never salvages a balanced fragment that is not the bookings envelope", async () => {
    // Legacy `response` path has no finish_reason to blame; a truncated body
    // whose only balanced object is an inner booking must read as invalid
    // JSON, not as a wrong-shaped response.
    const truncated = `Result: {"bookings": [${JSON.stringify(BOOKING)}, {"title": "cut off`;
    const provider = new WorkersAiProvider({
      run: vi.fn(async () => ({ response: truncated })),
    }, "@cf/test");
    await expect(provider.extract(PROMPT)).rejects.toThrow(/not valid JSON/);
  });

  it("uses Anthropic structured output without a live model call", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ bookings: [BOOKING] }) }],
      stop_reason: "end_turn",
    }));
    const factory = vi.fn((key: string) => {
      expect(key).toBe("sk-ant-test");
      return { create };
    });
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-5", factory);

    expect(await provider.extract(PROMPT)).toMatchObject([{ confirmationNumber: "ABC123" }]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet-5",
      system: "fixed rules",
      output_config: {
        format: { type: "json_schema", schema: EXTRACTED_JSON_SCHEMA },
      },
    }));
  });

  it("surfaces Anthropic API and malformed-output failures as ExtractionError", async () => {
    const apiFailure = new AnthropicProvider("key", "model", () => ({
      create: vi.fn(async () => { throw new Error("rate limited"); }),
    }));
    await expect(apiFailure.extract(PROMPT)).rejects.toThrow(ExtractionError);
    await expect(apiFailure.extract(PROMPT)).rejects.toThrow(/rate limited/);

    const malformed = new AnthropicProvider("key", "model", () => ({
      create: vi.fn(async () => ({
        content: [{ type: "text", text: "{}" }],
        stop_reason: "end_turn",
      })),
    }));
    await expect(malformed.extract(PROMPT)).rejects.toThrow(ExtractionError);
  });

  it("falls back to Workers AI when Anthropic ciphertext cannot be decrypted", async () => {
    const ring = new Keyring("new", { new: crypto.getRandomValues(new Uint8Array(32)) });
    const settings: IngestHouseholdSettings = {
      forwardAddress: "trips@example.com",
      senderAllowlist: [],
      aiModel: "@cf/fallback",
      aiMaxTokens: 2_048,
      aiProvider: "anthropic",
      anthropicModel: "claude-opus-4-8",
      anthropicKeyConfigured: true,
      anthropicApiKeyCiphertext: "v1.old.bad.bad",
      extractionInstructions: "",
    };
    const run = vi.fn(async () => ({ response: { bookings: [BOOKING] } }));
    const provider = await resolveExtractionProvider({
      settings,
      ai: { run },
      ring,
      logContext: "test",
    });
    expect(provider?.name).toBe("workers-ai");
    await provider?.extract(PROMPT);
    expect(run).toHaveBeenCalledWith(
      "@cf/fallback",
      expect.objectContaining({ max_tokens: 2_048 }),
    );
  });
});
