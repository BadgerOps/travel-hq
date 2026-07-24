import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTED_JSON_SCHEMA, ExtractionError, validateExtracted } from "./extracted.js";
import type { ExtractedBooking } from "./extracted.js";
import type {
  AiProvider,
  IngestHouseholdSettings,
} from "../repos/household-settings.js";
import type { Keyring } from "../crypto/envelope.js";
import { DEFAULT_WORKERS_AI_MAX_TOKENS } from "../../shared/workers-ai-models.js";

export type ExtractionPrompt = {
  system: string;
  user: string;
};

export type ExtractionAi = {
  run(
    model: string,
    inputs: {
      messages: { role: "system" | "user"; content: string }[];
      response_format:
        | { type: "json_schema"; json_schema: unknown }
        | { type: "json_object" };
      max_tokens: number;
    },
  ): Promise<unknown>;
};

export interface ExtractionProvider {
  readonly name: AiProvider;
  extract(prompt: ExtractionPrompt): Promise<ExtractedBooking[]>;
}

export class WorkersAiProvider implements ExtractionProvider {
  readonly name = "workers-ai" as const;

  constructor(
    private readonly ai: ExtractionAi,
    private readonly model: string,
    private readonly maxTokens = DEFAULT_WORKERS_AI_MAX_TOKENS,
  ) {}

  async extract(prompt: ExtractionPrompt): Promise<ExtractedBooking[]> {
    const messages = [
      { role: "system" as const, content: prompt.system },
      { role: "user" as const, content: prompt.user },
    ];
    let result: unknown;
    try {
      result = await this.ai.run(this.model, {
        messages,
        response_format: { type: "json_schema", json_schema: EXTRACTED_JSON_SCHEMA },
        max_tokens: this.maxTokens,
      });
    } catch (err) {
      if (!isJsonSchemaFailure(err)) throw providerError("Workers AI", err);

      // Cloudflare explicitly documents that a supported model can still
      // reject a complex schema with 5024. Retry in JSON-object mode, put the
      // schema in the fixed system instruction, then apply our normal Zod
      // validation to the result.
      console.warn(
        `[extract] Workers AI model ${this.model} could not meet JSON Schema; retrying JSON-object mode`,
      );
      try {
        result = await this.ai.run(this.model, {
          messages: [
            {
              role: "system",
              content: [
                prompt.system,
                "Return only one JSON object matching this schema:",
                JSON.stringify(EXTRACTED_JSON_SCHEMA),
              ].join("\n"),
            },
            { role: "user", content: prompt.user },
          ],
          response_format: { type: "json_object" },
          max_tokens: this.maxTokens,
        });
      } catch (fallbackErr) {
        throw providerError("Workers AI JSON fallback", fallbackErr);
      }
    }
    return validateExtracted(workersPayload(result, this.model));
  }
}

export type AnthropicMessage = {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
};

export type AnthropicMessagesClient = {
  create(input: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: "user"; content: string }>;
    output_config: {
      format: { type: "json_schema"; schema: { [key: string]: unknown } };
    };
  }): Promise<AnthropicMessage>;
};

export type AnthropicClientFactory = (apiKey: string) => AnthropicMessagesClient;

export const createAnthropicClient: AnthropicClientFactory = (apiKey) =>
  new Anthropic({ apiKey }).messages;

export class AnthropicProvider implements ExtractionProvider {
  readonly name = "anthropic" as const;
  private readonly messages: AnthropicMessagesClient;

  constructor(
    apiKey: string,
    private readonly model: string,
    clientFactory: AnthropicClientFactory = createAnthropicClient,
  ) {
    this.messages = clientFactory(apiKey);
  }

  async extract(prompt: ExtractionPrompt): Promise<ExtractedBooking[]> {
    let message: AnthropicMessage;
    try {
      message = await this.messages.create({
        model: this.model,
        max_tokens: 4_096,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        output_config: {
          format: {
            type: "json_schema",
            schema: EXTRACTED_JSON_SCHEMA,
          },
        },
      });
    } catch (err) {
      throw providerError("Anthropic", err);
    }

    const text = message.content
      .filter((block): block is { type: string; text: string } => block.type === "text" && !!block.text)
      .map((block) => block.text)
      .join("");
    if (text === "") {
      throw new ExtractionError(
        message.stop_reason === "refusal"
          ? "Anthropic refused the extraction request"
          : "Anthropic returned no structured output",
      );
    }
    try {
      return validateExtracted(JSON.parse(text) as unknown);
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      throw new ExtractionError("Anthropic returned invalid structured JSON");
    }
  }
}

export type ResolveProviderInput = {
  settings: IngestHouseholdSettings;
  ai: ExtractionAi | undefined;
  ring: Keyring | undefined;
  anthropicClientFactory?: AnthropicClientFactory;
  logContext: string;
};

/**
 * Resolve the configured provider for ingest. Credential configuration is
 * loud at save time, but soft here: old/corrupt/undecryptable Anthropic state
 * falls back to Workers AI so a confirmation email is never discarded.
 */
export async function resolveExtractionProvider({
  settings,
  ai,
  ring,
  anthropicClientFactory,
  logContext,
}: ResolveProviderInput): Promise<ExtractionProvider | undefined> {
  if (settings.aiProvider === "anthropic") {
    try {
      if (!settings.anthropicApiKeyCiphertext) {
        throw new Error("Anthropic API key is not configured");
      }
      if (!ring) {
        throw new Error("The encryption keyring is unavailable");
      }
      const apiKey = await ring.decrypt(settings.anthropicApiKeyCiphertext);
      return new AnthropicProvider(apiKey, settings.anthropicModel, anthropicClientFactory);
    } catch (err) {
      console.warn(
        `[extract] ${logContext}: Anthropic credentials unavailable; falling back to Workers AI`,
        err,
      );
    }
  }
  return ai ? new WorkersAiProvider(ai, settings.aiModel, settings.aiMaxTokens) : undefined;
}

function workersPayload(result: unknown, model: string): unknown {
  if (result === null || typeof result !== "object") {
    throw noWorkersResponse(model, result);
  }

  if ("response" in result) {
    const response = (result as { response: unknown }).response;
    if (response !== null && response !== undefined && response !== "") {
      return parseWorkersJson(response);
    }
  }

  // Newer Workers AI models use the OpenAI-compatible chat-completions
  // envelope instead of the legacy top-level `response` field.
  const choices = (result as {
    choices?: Array<{
      finish_reason?: unknown;
      message?: { content?: unknown; reasoning?: unknown; refusal?: unknown };
    }>;
  }).choices;
  const message = choices?.[0]?.message;
  if (message?.refusal) {
    throw new ExtractionError("The model refused the extraction request");
  }
  if (message?.content !== null && message?.content !== undefined && message.content !== "") {
    return parseWorkersJson(message.content);
  }
  throw noWorkersResponse(model, result);
}

function parseWorkersJson(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;

  const trimmed = payload.trim();
  const direct = tryParseJson(trimmed);
  if (direct.ok) return direct.value;

  // JSON-mode models occasionally wrap an otherwise valid response in a
  // Markdown fence despite being told not to. Prefer the complete fenced
  // value before looking for an object inside surrounding prose.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1]!.trim());
    if (parsed.ok) return parsed.value;
  }

  // Some reasoning models include a short preface or a <think> block around
  // the answer. Find a balanced JSON object without treating braces inside
  // JSON strings as structure. Each candidate is still parsed strictly:
  // comments, single quotes, trailing commas, and truncated output fail.
  for (let start = trimmed.indexOf("{"); start >= 0; start = trimmed.indexOf("{", start + 1)) {
    const candidate = balancedObjectAt(trimmed, start);
    if (!candidate) continue;
    const parsed = tryParseJson(candidate);
    if (parsed.ok) return parsed.value;
  }

  throw new ExtractionError("The model response was not valid JSON");
}

type JsonAttempt =
  | { ok: true; value: unknown }
  | { ok: false };

function tryParseJson(value: string): JsonAttempt {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function balancedObjectAt(value: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index++) {
    const char = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return undefined;
}

function isJsonSchemaFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b5024\b|JSON (?:Model|Mode) couldn't be met/i.test(message);
}

function noWorkersResponse(model: string, result: unknown): ExtractionError {
  const details = [`model=${model}`];
  if (result !== null && typeof result === "object") {
    const record = result as {
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown; reasoning?: unknown };
      }>;
      usage?: {
        output_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
      };
    };
    const choice = record.choices?.[0];
    if (typeof choice?.finish_reason === "string") {
      details.push(`finish_reason=${choice.finish_reason}`);
    }
    if (typeof choice?.message?.reasoning === "string") {
      details.push(`reasoning_chars=${choice.message.reasoning.length}`);
    }
    const outputTokens = record.usage?.output_tokens ?? record.usage?.completion_tokens;
    if (typeof outputTokens === "number") details.push(`output_tokens=${outputTokens}`);
    if (typeof record.usage?.total_tokens === "number") {
      details.push(`total_tokens=${record.usage.total_tokens}`);
    }
  }
  return new ExtractionError(`The model returned no response (${details.join(", ")})`);
}

function providerError(provider: string, err: unknown): ExtractionError {
  if (err instanceof ExtractionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ExtractionError(`${provider} extraction failed: ${message}`);
}
