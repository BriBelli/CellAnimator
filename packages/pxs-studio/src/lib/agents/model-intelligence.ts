/**
 * THE MODEL-INTELLIGENCE WORKFLOW — the ONE daily pass that keeps the registry true.
 *
 * Brian's rule, verbatim: "A single workflow can check every API is available, and then do a research
 * lookup." There used to be three separately-triggered processes (existence refresh, capability
 * research, maintenance) with four endpoints — this file is their single front door. The pieces stay
 * pure + individually tested; this is the ORCHESTRATION, in the only order that makes sense:
 *
 *   1. AVAILABILITY — hit every provider's live listing: which models still exist, which are new
 *      (discoveries), which vanished (ghosts). Free + deterministic. (engine/model-refresh)
 *   2. JUDGMENT — research fresh discoveries into routable cards; age/retire ghosts on repeated-miss
 *      evidence. Runs right after availability so a discovery is researched the same pass it's found.
 *      (model-maintenance)
 *   3. CAPABILITIES — re-verify the LIVE catalog's stale records against provider docs (Tavily + the
 *      research brain) and persist sourced corrections as seed_override cards. This is what fixes
 *      "FLUX = 1 reference"-style lies without a human. (capability-refresh)
 *   4. DOCTRINE — fetch each model's PINNED official docs in FULL and (re-)distill its prompt
 *      doctrine when the docs changed. The knowledge layer: real formulas, principles, task
 *      patterns — what the Prompt Guide and the craft score stand on. (doctrine-refresh)
 *   5. VIDEO DOCTRINE — the same pass over the video models, under the VIDEO craft lens (camera,
 *      motion, duration, synced audio) and the video task vocabulary. Same engine, not a fork: two
 *      copies of a self-maintaining loop is how the copies drift apart.
 *   6. SUCCESSION — for every model we route to, IMAGE AND VIDEO, ask the provider whether a newer
 *      version of it exists. The other steps answer "does this still work?"; none of them answer
 *      "has this been superseded?", and that is the question whose absence let FLUX sit two
 *      generations stale, Recraft route to V3 while V4.1 was the API default, Happy Horse seed at 1.0
 *      with 1.1 live, and Seedance run at 2.0 while 2.5 shipped. Every one was caught by a person
 *      reading a docs site — exactly the work this system exists to do.
 *
 * BOUNDED BY DEFAULT. A pass used to run every step over every model with no cap: one POST ground
 * for an hour, held a request open long after the caller had given up, and starved the app's own
 * requests (observed 2026-08-25 — an abandoned curl kept the whole registry churning). Work is now
 * capped per call and STAGGERS across calls via the TTL, so any single trigger returns promptly and
 * repeated triggers finish the catalog. `force` exists for a deliberate, operator-initiated rebuild.
 *
 * Two entries:
 *   · runModelIntelligence      — a bounded pass (POST /api/models/maintain; cron or manual).
 *   · runModelIntelligenceIfDue — TTL-gated, fire-and-forget from the image-agent hot path: on most
 *     turns nothing is due → a couple of cheap DB reads, zero network. This is what makes the DAILY
 *     cycle real even with no cron: the first turn after each TTL window pays for the refresh.
 */

import type { Repository } from '../db/repository';
import { liveRefreshDeps, providersDue } from '../engine/model-refresh';
import { PROVIDERS } from '../engine/provider-roster';
import { DEFAULT_TTL_HOURS } from '../engine/staleness';
import { IMAGE_MODELS } from '../engine/model-registry';
import {
  refreshRegistry,
  refreshRegistryIfDue,
  loadRefreshState,
  overlayFreshness,
  type RefreshSummary,
} from './model-refresh-runner';
import { runMaintenance, liveMaintenanceDeps, type MaintenanceSummary } from './model-maintenance';
import {
  refreshCapabilities,
  refreshCapabilitiesIfDue,
  type CapabilityRefreshResult,
} from './capability-refresh';
import {
  refreshDoctrine,
  refreshDoctrineIfDue,
  type DoctrineRefreshResult,
} from './doctrine-refresh';
import { getLiveCatalog } from './live-catalog';
import { videoModelsForDoctrine, MEDIA_MODELS } from '../engine/media-registry';
import { sweepForSuccessors, type SuccessionReport } from '../engine/model-succession';
import { getProvider, registryTag } from '../engine/provider-roster';

export interface IntelligenceSummary {
  ranAt: number;
  /** Step 1 — provider availability sweep (null when nothing was due on an ifDue run). */
  availability: RefreshSummary | null;
  /** Step 2 — discoveries researched / ghosts aged or retired. */
  maintenance: MaintenanceSummary;
  /** Step 3 — capability corrections applied (sourced, confidence-gated). */
  capabilities: CapabilityRefreshResult[];
  /** Step 4 — doctrines distilled / restamped from the pinned official docs. */
  doctrine: DoctrineRefreshResult[];
  /** Step 5 — the same, for VIDEO models (their own craft lens + task vocabulary). */
  videoDoctrine: DoctrineRefreshResult[];
  /** Step 6 — newer versions of models we route to. A prompt to research, never an auto-swap. */
  succession: SuccessionReport[];
}

export interface IntelligenceOptions {
  /** Max models to re-research per call (capability facts). Staggers across calls via the TTL. */
  capabilityLimit?: number;
  /** Max doctrines to distill per call — each is several full document reads plus an LLM pass. */
  doctrineLimit?: number;
  /** Ignore freshness and re-run everything. Operator-initiated rebuilds ONLY: unbounded work. */
  force?: boolean;
}

/**
 * A pass over the catalog: availability → judgment → capabilities → doctrine. Bounded unless
 * `force`, so a single trigger returns in a predictable time and the next one picks up where this
 * left off. Deliberate + metered (Tavily + LLM spend).
 */
export async function runModelIntelligence(
  repo: Repository,
  now: number,
  opts: IntelligenceOptions = {},
): Promise<IntelligenceSummary> {
  const availability = await refreshRegistry(repo, liveRefreshDeps(now));
  const maintenance = await runMaintenance(repo, liveMaintenanceDeps(now));
  const catalog = await getLiveCatalog(repo);
  // ONLY models we would actually route to. Unvetted discoveries (preview/needsResearch) are
  // knowledge, not products: researching their capabilities or distilling their prompt doctrine is
  // pure waste — and with a polluted catalog it is unbounded waste.
  const routable = catalog.filter((m) => !m.preview && !m.needsResearch);

  if (opts.force) {
    const capabilities = await refreshCapabilities(routable, repo, { now });
    const doctrine = await refreshDoctrine(routable, repo, { now });
    const videoDoctrine = await refreshDoctrine(videoModelsForDoctrine(), repo, { now, modality: 'video' });
    const succession = await checkSuccession(routable);
    return { ranAt: now, availability, maintenance, capabilities, doctrine, videoDoctrine, succession };
  }

  // Due-gated + capped: unchanged records cost nothing, and one call can't monopolize the server.
  const capabilities = await refreshCapabilitiesIfDue(routable, repo, { now, maxPerPass: opts.capabilityLimit ?? 4 });
  const doctrine = await refreshDoctrineIfDue(routable, repo, { now, maxPerPass: opts.doctrineLimit ?? 2 });
  const videoDoctrine = await refreshDoctrineIfDue(videoModelsForDoctrine(), repo, {
    now,
    modality: 'video',
    maxPerPass: opts.doctrineLimit ?? 2,
  });
  const succession = await checkSuccession(routable);
  return { ranAt: now, availability, maintenance, capabilities, doctrine, videoDoctrine, succession };
}

/**
 * Ask each provider whether a newer version of anything we route to has shipped — for IMAGE AND
 * VIDEO models together. Video was previously absent from every sweep, so its registry was never
 * self-maintaining at all despite being described as such.
 */
async function checkSuccession(routableImages: { id: string; provider: string; providerModelId?: string }[]): Promise<SuccessionReport[]> {
  const videos = MEDIA_MODELS.filter((m) => m.modalities.includes('video') && !m.preview && !m.needsResearch).map((m) => ({
    id: m.id,
    provider: m.provider,
    providerModelId: m.providerModelId,
  }));

  const models = [...routableImages.map((m) => ({ id: m.id, provider: m.provider, providerModelId: m.providerModelId })), ...videos];

  return sweepForSuccessors(models, {
    search: async (providerTag, keyword) => {
      const provider = getProvider(providerTag) ?? PROVIDERS.find((p) => registryTag(p) === providerTag);
      const endpoint = provider?.modelsEndpoint;
      const key = provider ? process.env[provider.envKey] : undefined;
      if (!endpoint || !key) return [];
      // A keyword endpoint (fal) takes the family; a plain listing ignores it.
      const url = endpoint.endsWith('=') ? `${endpoint}${encodeURIComponent(keyword)}` : endpoint;
      const res = await fetch(url, { headers: { Authorization: `Key ${key}` } });
      if (!res.ok) return [];
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const rows = (json?.items ?? json?.models ?? json?.data ?? json?.results) as unknown;
      if (!Array.isArray(rows)) return [];
      return rows
        .map((r) => (r as Record<string, unknown>).id)
        .filter((id): id is string => typeof id === 'string');
    },
  });
}

/**
 * The TTL-gated pass for the hot path. Fire-and-forget safe:
 * `void runModelIntelligenceIfDue(db, Date.now()).catch(() => {})`.
 * Availability + capabilities are each due-checked (24h TTL); maintenance runs only when the
 * availability sweep actually ran (that's the only time discoveries/ghost evidence can change).
 */
export async function runModelIntelligenceIfDue(
  repo: Repository,
  now: number,
  ttlHours: number = DEFAULT_TTL_HOURS
): Promise<IntelligenceSummary | { skipped: true }> {
  const availabilityRes = await refreshRegistryIfDue(repo, now, ttlHours);
  const ran = !('skipped' in availabilityRes);

  const maintenance = ran
    ? await runMaintenance(repo, liveMaintenanceDeps(now))
    : null;

  const catalog = await getLiveCatalog(repo);
  const routable = catalog.filter((m) => !m.preview && !m.needsResearch);
  // HOT PATH: deliberately tiny. This is fire-and-forget from a user's turn, so it must never
  // compete with the request that triggered it — one doctrine distillation is several document
  // fetches plus an LLM call. The TTL spreads the rest over subsequent turns.
  const capabilities = await refreshCapabilitiesIfDue(routable, repo, { now, ttlHours, maxPerPass: 2 });
  const doctrine = await refreshDoctrineIfDue(routable, repo, { now, ttlHours, maxPerPass: 1 });
  const videoDoctrine = await refreshDoctrineIfDue(videoModelsForDoctrine(), repo, {
    now,
    ttlHours,
    modality: 'video',
    maxPerPass: 1,
  });
  // Succession only rides the availability sweep: it is the same "what changed at the provider?"
  // question, and asking it on every turn would be a request per model family per turn for an
  // answer that changes monthly.
  const succession = ran ? await checkSuccession(routable) : [];

  if (!ran && capabilities.length === 0 && doctrine.length === 0 && videoDoctrine.length === 0) return { skipped: true };
  return {
    ranAt: now,
    availability: ran ? (availabilityRes as RefreshSummary) : null,
    maintenance: maintenance ?? { ranAt: now, researched: [], rejected: [], retired: [], incremented: [], reset: [], discoveriesSeen: 0, ghostsSeen: 0 },
    capabilities,
    doctrine,
    videoDoctrine,
    succession,
  };
}

/** Cheap "is anything due?" probe (no network, no LLM) — for status surfaces. */
export async function intelligenceDue(repo: Repository, now: number, ttlHours: number = DEFAULT_TTL_HOURS): Promise<boolean> {
  const state = await loadRefreshState(repo);
  const effective = overlayFreshness(IMAGE_MODELS, state);
  return providersDue(PROVIDERS, effective, now, ttlHours).length > 0;
}
