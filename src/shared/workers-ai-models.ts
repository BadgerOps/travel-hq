/**
 * Workers AI models that have been exercised against Travel HQ's constrained
 * JSON schema request. The public Workers AI catalog contains text-generation
 * models that are deprecated, require a separate licence, or do not implement
 * JSON Schema, so being present in the catalog is not sufficient.
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

const SUPPORTED_MODEL_NAMES = new Set<string>(
  SUPPORTED_WORKERS_AI_MODELS.map(({ name }) => name),
);

export function isSupportedWorkersAiModel(model: string): boolean {
  return SUPPORTED_MODEL_NAMES.has(model);
}
