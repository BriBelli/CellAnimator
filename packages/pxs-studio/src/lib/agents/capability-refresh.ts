/**
 * Capability refresh — run the grounded research across ALL models and persist the SOURCED facts as
 * seed_override ModelCards, which composeCatalog then overlays onto the hand-typed seed. This is the
 * loop that keeps the registry accurate on its own: the agent reads each model's docs, extracts what
 * the sources state (with provenance) — hard capability limits AND the ranking axes (strengths/tier/
 * bestFor) — and only applies medium/high-confidence results (low stays seed — honest). No hand-typing,
 * no hand-correcting: the seed is a bootstrap floor, the research pass is the authority.
 */

import type { Repository } from '../db/repository';
import type { ModelCard } from '../db/models';
import type { ImageModel, Capability } from '../engine/model-registry';
import { PROVIDERS, registryTag } from '../engine/provider-roster';
import { researchModelCapabilities, type CapabilityResearch } from './model-agent/research-capabilities';
import { loadCards } from './live-catalog';
import { DEFAULT_TTL_HOURS } from '../engine/staleness';

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
  if (r.referenceLimits) patch.referenceLimits = r.referenceLimits;
  // The model's REAL input channels — structural truth about how references are passed, researched
  // rather than approximated onto a Gemini-shaped {object,character,style} triple.
  if (r.inputSlots) patch.inputSlots = r.inputSlots;
  if (typeof r.supportsEditing === 'boolean') patch.supportsEditing = r.supportsEditing;
  if (Array.isArray(r.capabilities) && r.capabilities.length > 0) patch.capabilities = r.capabilities as Capability[];
  if (Array.isArray(r.aspectRatios) && r.aspectRatios.length > 0) patch.aspectRatios = r.aspectRatios;
  // The RANKING AXES — researched, never hand-typed. This is what keeps selection autonomous:
  // strengths/tier/bestFor come from live quality sources and overlay the seed via composeCatalog.
  if (r.strengths) patch.strengths = r.strengths;
  if (r.tier) patch.tier = r.tier;
  if (Array.isArray(r.bestFor) && r.bestFor.length > 0) patch.bestFor = r.bestFor;

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


/**
 * The DAILY self-heal for capability ACCURACY (not just existence). Researches any model whose sourced
 * card is MISSING or past its TTL — grounded in live docs (Tavily + the research brain, Fable) — and
 * persists the correction as a seed_override the catalog overlays. This is the fix for stale lies like
 * "FLUX = 1 reference" living forever: every model's real limits get re-verified on a cycle, never
 * hand-typed-and-forgotten. Capped per pass so a single trigger never spikes; it staggers across turns
 * until the whole registry is fresh, then idles. Safe to fire-and-forget.
 */
export async function refreshCapabilitiesIfDue(
  models: ImageModel[],
  repo: Repository,
  deps: CapabilityRefreshDeps & { ttlHours?: number; maxPerPass?: number },
): Promise<CapabilityRefreshResult[]> {
  const ttl = deps.ttlHours ?? DEFAULT_TTL_HOURS;
  const maxPerPass = deps.maxPerPass ?? 3;

  // researched_at per model, from the persisted sourced cards.
  let stamped = new Map<string, number>();
  try {
    const cards = await loadCards(repo);
    for (const [modelId, c] of cards) {
      if (c.origin === 'seed_override' && typeof c.researched_at === 'number') stamped.set(modelId, c.researched_at);
    }
  } catch {
    /* no cards yet — everything is due */
  }

  const due = models
    .filter((m) => {
      const at = stamped.get(m.id);
      if (at == null) return true; // never researched → due
      return (deps.now - at) / 3_600_000 >= ttl; // hours since last research past the TTL
    })
    .slice(0, maxPerPass);

  const results: CapabilityRefreshResult[] = [];
  for (const m of due) {
    try {
      results.push(await refreshOne(m, repo, deps));
    } catch (err) {
      console.warn(`[capability-refresh] ${m.id} due-refresh failed:`, err);
    }
  }
  return results;
}
