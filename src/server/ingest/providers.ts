import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTED_JSON_SCHEMA, ExtractionError, validateExtracted } from "./extracted.js";
import type { ExtractedBooking } from "./extracted.js";
import type {
  AiProvider,
  IngestHouseholdSettings,
} from "../repos/household-settings.js";
import type { Keyring } from "../crypto/envelope.js";

export type ExtractionPrompt = {
  system: string;
  user: string;
};

export type ExtractionAi = {
  run(
    model: string,
    inputs: {
      messages: { role: "system" | "user"; content: string }[];
      response_format: { type: "json_schema"; json_schema: unknown };
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
  ) {}

  async extract(prompt: ExtractionPrompt): Promise<ExtractedBooking[]> {
    let result: unknown;
    try {
      result = await this.ai.run(this.model, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        response_format: { type: "json_schema", json_schema: EXTRACTED_JSON_SCHEMA },
      });
    } catch (err) {
      throw providerError("Workers AI", err);
    }
    return validateExtracted(workersPayload(result));
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
  return ai ? new WorkersAiProvider(ai, settings.aiModel) : undefined;
}

function workersPayload(result: unknown): unknown {
  if (result !== null && typeof result === "object" && "response" in result) {
    const response = (result as { response: unknown }).response;
    if (typeof response === "string") {
      try {
        return JSON.parse(response) as unknown;
      } catch {
        throw new ExtractionError("The model response was not valid JSON");
      }
    }
    if (response !== null && response !== undefined) return response;
  }
  throw new ExtractionError("The model returned no response");
}

function providerError(provider: string, err: unknown): ExtractionError {
  if (err instanceof ExtractionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ExtractionError(`${provider} extraction failed: ${message}`);
}
