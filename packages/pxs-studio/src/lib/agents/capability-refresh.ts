/**
 * Capability refresh — run the grounded research across ALL models and persist the SOURCED facts as
 * seed_override ModelCards, which composeCatalog then overlays onto the hand-typed seed. This is the
 * loop that keeps the registry accurate on its own: the agent reads each model's docs, extracts what
 * the sources state (with provenance), and only applies medium/high-confidence results (low stays seed
 * — honest). No hand-typing, no hand-correcting.
 */

import type { Repository } from '../db/repository';
import type { ModelCard } from '../db/models';
import type { ImageModel, Capability } from '../engine/model-registry';
import { PROVIDERS, registryTag } from '../engine/provider-roster';
import { researchModelCapabilities, type CapabilityResearch } from './model-agent/research-capabilities';

const SYSTEM_USER_ID = 'system';

export interface CapabilityRefreshDeps {
  now: number;
  /** Injected for tests; defaults to the real Tavily+Claude research. */
  research?: (m: { id: string; label: string; provider: string; docsUrl?: string }) => Promise<CapabilityResearch>;
}

export interface CapabilityRefreshResult {
  modelId: string;
  confidence: 'low' | 'medium' | 'high';
  applied: boolean;
  patch: Partial<ImageModel>;
  sources: string[];
}

/** Research one model and, if confident, persist a seed_override card with the sourced patch. */
async function refreshOne(
  m: ImageModel,
  repo: Repository,
  deps: CapabilityRefreshDeps,
): Promise<CapabilityRefreshResult> {
  const research = deps.research ?? researchModelCapabilities;
  const provider = PROVIDERS.find((p) => registryTag(p) === m.provider);
  const r = await research({ id: m.id, label: m.label, provider: m.provider, docsUrl: provider?.docsUrl });

  const patch: Partial<ImageModel> = {};
  if (typeof r.maxReferenceImages === 'number') patch.maxReferenceImages = r.maxReferenceImages;
  if (typeof r.supportsEditing === 'boolean') patch.supportsEditing = r.supportsEditing;
  if (Array.isArray(r.capabilities) && r.capabilities.length > 0) patch.capabilities = r.capabilities as Capability[];
  if (Array.isArray(r.aspectRatios) && r.aspectRatios.length > 0) patch.aspectRatios = r.aspectRatios;

  const applied = r.confidence !== 'low' && Object.keys(patch).length > 0;
  if (applied) {
    const card: ModelCard = {
      id: `model_card:${m.id}`,
      user_id: SYSTEM_USER_ID,
      category: 'model_card',
      status: 'active',
      created_at: deps.now,
      updated_at: deps.now,
      model_id: m.id,
      provider: m.provider,
      card: patch,
      origin: 'seed_override',
      confidence: r.confidence,
      researched_at: deps.now,
      source: r.sources.map((s) => s.url).join(' · '),
    };
    await repo.put(card);
  }
  return { modelId: m.id, confidence: r.confidence, applied, patch, sources: r.sources.map((s) => s.url) };
}

/** Research + persist across every model (sequential — each is a Tavily + Claude call; rate-safe). */
export async function refreshCapabilities(
  models: ImageModel[],
  repo: Repository,
  deps: CapabilityRefreshDeps,
): Promise<CapabilityRefreshResult[]> {
  const results: CapabilityRefreshResult[] = [];
  for (const m of models) {
    try {
      results.push(await refreshOne(m, repo, deps));
    } catch (err) {
      console.warn(`[capability-refresh] ${m.id} failed:`, err);
      results.push({ modelId: m.id, confidence: 'low', applied: false, patch: {}, sources: [] });
    }
  }
  return results;
}
