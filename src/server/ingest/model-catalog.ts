/**
 * Workers AI model catalog: pulled through the AI binding's search API
 * (`env.AI.models()`), intersected with the models verified against Travel
 * HQ's JSON schema, and cached per catalog instance so the Cloudflare
 * endpoint is hit at most once per TTL per isolate.
 *
 * The catalog is a createApp() override (like anthropicClientFactory) so
 * tests inject a fresh instance with a fake clock; production uses one
 * module-scope instance, which is exactly the isolate-lifetime cache we want.
 */

import {
  SUPPORTED_WORKERS_AI_MODELS,
  isSupportedWorkersAiModel,
} from "../../shared/workers-ai-models.js";
import type { CatalogModel } from "../../shared/workers-ai-models.js";

export type { CatalogModel } from "../../shared/workers-ai-models.js";

export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
// Backstop against a runaway pagination loop, not a real limit: the
// text-generation catalog is ~60 models today.
const MAX_PAGES = 6;
const TEXT_GENERATION = "Text Generation";

/**
 * Structural slice of the `Ai` binding (workers-types `models()`), so tests
 * stub a plain object and the catalog never depends on the ambient global.
 */
export type ModelLister = {
  models(params?: {
    task?: string;
    per_page?: number;
    page?: number;
  }): Promise<SearchedModel[]>;
};

type SearchedModel = {
  name: string;
  description?: string | null;
  task?: { name?: string | null } | null;
};

export class WorkersAiModelCatalog {
  private cached: { at: number; models: CatalogModel[] } | null = null;
  private pending: Promise<CatalogModel[]> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async list(ai: ModelLister): Promise<CatalogModel[]> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.models;

    // One in-flight pull, shared by concurrent requests.
    if (!this.pending) {
      this.pending = this.pull(ai).finally(() => {
        this.pending = null;
      });
    }
    try {
      const models = await this.pending;
      this.cached = { at: this.now(), models };
      return models;
    } catch (err) {
      // A failed refresh after expiry serves the stale list; only a cold
      // failure surfaces (the route maps it to its soft-error envelope).
      if (cached) return cached.models;
      throw err;
    }
  }

  private async pull(ai: ModelLister): Promise<CatalogModel[]> {
    const seen = new Map<string, CatalogModel>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await ai.models({ task: TEXT_GENERATION, per_page: PAGE_SIZE, page });
      for (const m of batch) {
        // The task param already filters server-side; re-check here so a
        // pass-through quirk can't leak classifiers into the dropdown.
        if (m.task?.name && m.task.name !== TEXT_GENERATION) continue;
        if (!isSupportedWorkersAiModel(m.name)) continue;
        if (m.name) seen.set(m.name, { name: m.name, description: m.description ?? "" });
      }
      if (batch.length < PAGE_SIZE) break;
    }
    // Stable, intentional order: the recommended model stays first while
    // catalog descriptions replace the concise offline descriptions.
    return SUPPORTED_WORKERS_AI_MODELS.flatMap((fallback) => {
      const live = seen.get(fallback.name);
      return live ? [{ ...fallback, description: live.description || fallback.description }] : [];
    });
  }
}
