/**
 * Workers AI models observed accepting structured-output requests and eligible
 * for Travel HQ extraction. Cloudflare can still reject a particular complex
 * schema at runtime, so the provider has a validated JSON-object fallback.
 * The public catalog also contains deprecated, separately licensed, and
 * incompatible models, so catalog presence alone is not sufficient.
 */
export const SUPPORTED_WORKERS_AI_MODELS = [
  {
    name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    description: "Recommended default for travel extraction.",
  },
  {
    name: "@cf/meta/llama-4-scout-17b-16e-instruct",
    description: "Llama 4 Scout 17B instruction model.",
  },
  {
    name: "@cf/qwen/qwen3-30b-a3b-fp8",
    description: "Qwen 3 30B mixture-of-experts model.",
  },
  {
    name: "@cf/openai/gpt-oss-20b",
    description: "OpenAI GPT-OSS 20B model.",
  },
  {
    name: "@cf/openai/gpt-oss-120b",
    description: "OpenAI GPT-OSS 120B model.",
  },
  {
    name: "@cf/zai-org/glm-4.7-flash",
    description: "GLM 4.7 Flash model.",
  },
  {
    name: "@cf/ibm-granite/granite-4.0-h-micro",
    description: "IBM Granite 4.0 H Micro model.",
  },
  {
    name: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    description: "DeepSeek R1 Distill Qwen 32B model.",
  },
  {
    name: "@cf/moonshotai/kimi-k2.6",
    description: "Moonshot AI Kimi K2.6 model.",
  },
  {
    name: "@cf/nvidia/nemotron-3-120b-a12b",
    description: "NVIDIA Nemotron 3 120B model.",
  },
] as const;

export type CatalogModel = { name: string; description: string };

export const DEFAULT_WORKERS_AI_MODEL = SUPPORTED_WORKERS_AI_MODELS[0].name;
export const DEFAULT_WORKERS_AI_MAX_TOKENS = 4_096;
export const MIN_WORKERS_AI_MAX_TOKENS = 256;
export const MAX_WORKERS_AI_MAX_TOKENS = 8_192;

const SUPPORTED_MODEL_NAMES = new Set<string>(
  SUPPORTED_WORKERS_AI_MODELS.map(({ name }) => name),
);

export function isSupportedWorkersAiModel(model: string): boolean {
  return SUPPORTED_MODEL_NAMES.has(model);
}
