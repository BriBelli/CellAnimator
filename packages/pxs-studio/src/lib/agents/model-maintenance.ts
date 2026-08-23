/**
 * THE MAINTENANCE AGENT — closes the self-maintaining loop.
 *
 * The refresh worker (model-refresh.ts) only does what's SAFE deterministically: confirm, discover,
 * flag. This agent handles the two judgment halves it deliberately left open:
 *
 *   · DISCOVERIES → research each newly-found model into a full, routable record (an LLM job).
 *   · GHOSTS      → retire a curated model that has vanished — but ONLY on repeated-miss EVIDENCE
 *                   (`miss_count` across passes), never on an LLM guess, and always reversibly
 *                   (it un-retires the moment the model reappears). Retirement is silent deletion's
 *                   cousin; it must be earned, not hallucinated.
 *
 * The `research` step is injected (real impl calls Claude; tests pass a fake), so `runMaintenance`
 * is deterministic and unit-tested with no network. This is a DELIBERATE, metered op (LLM spend) —
 * it runs from POST /api/models/maintain (cron / manual), never fire-and-forget on a user turn.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AGENT_MODELS } from './model-config';
import {
  type ImageModel,
  type Capability,
  type ModelStrengths,
  type BatchStrategy,
} from '../engine/model-registry';
import { getProvider, registryTag } from '../engine/provider-roster';
import { loadRefreshState } from './model-refresh-runner';
import { loadCards, SYSTEM_USER_ID } from './live-catalog';
import type { Repository } from '../db/repository';
import type { ModelCard, ModelRefreshRecord } from '../db/models';

const MODEL = AGENT_MODELS.maintenance;
const DEFAULT_RETIRE_THRESHOLD = 3;

/** A model the refresh worker discovered live, awaiting research. */
export interface Discovery {
  provider: string;
  liveId: string;
  label?: string;
}

/** The structured research result the LLM returns (a conservative subset — the rest gets safe
 *  defaults). `confidence` gates routability: below 'high' the card stays preview/needsResearch. */
export interface ResearchedModel {
  label: string;
  brief: string;
  tier?: 1 | 2 | 3;
  capabilities?: string[];
  supportsEditing?: boolean;
  maxReferenceImages?: number;
  costPerImageUsd?: [number, number];
  aspectRatios?: string[];
  strengths?: Partial<ModelStrengths>;
  confidence: 'low' | 'medium' | 'high';
  source?: string;
}

export interface MaintenanceDeps {
  now: number;
  research: (d: Discovery) => Promise<ResearchedModel | null>;
  /** Consecutive misses before a ghost retires. Default 3. */
  retireThreshold?: number;
}

export interface MaintenanceSummary {
  ranAt: number;
  researched: string[]; // new model ids carded this pass
  retired: string[]; // seed model ids retired this pass (hit the threshold)
  incremented: string[]; // ghosts that gained a miss but aren't retired yet
  reset: string[]; // ghosts cleared because the model reappeared live
  discoveriesSeen: number;
  ghostsSeen: number;
}

const VALID_CAPS: Capability[] = [
  'text_in_image', 'editing', 'multi_reference', 'photorealism', 'vector', 'high_resolution', 'fast', 'cheap',
];
const DEFAULT_STRENGTHS: ModelStrengths = {
  photorealism: 3, prompt_adherence: 3, editing: 3, style_versatility: 3, text_rendering: 3, speed: 3, resolution: 3, consistency: 3, multimodal: 3,
};

/** A stable registry slug from a provider's live id (handles 'owner/name' etc.). */
export function slugId(liveId: string): string {
  return liveId.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Assemble a full, conservative ImageModel from a research result. Missing fields → safe defaults;
 *  below-high confidence → preview + needsResearch (kept out of routing until trusted). Returns null
 *  if the provider isn't on the roster. */
export function toImageModel(r: ResearchedModel, d: Discovery, now: number): ImageModel | null {
  const provider = getProvider(d.provider);
  if (!provider) return null;
  const tag = registryTag(provider);
  const trusted = r.confidence === 'high';
  const caps = Array.isArray(r.capabilities)
    ? (r.capabilities.filter((c) => (VALID_CAPS as string[]).includes(c)) as Capability[])
    : [];
  return {
    id: slugId(d.liveId),
    label: r.label || d.label || d.liveId,
    provider: tag as ImageModel['provider'],
    envKey: provider.envKey,
    providerModelId: d.liveId,
    tier: r.tier ?? 2,
    strengths: { ...DEFAULT_STRENGTHS, ...(r.strengths ?? {}) },
    capabilities: caps,
    bestFor: [],
    supportsEditing: r.supportsEditing ?? false,
    maxReferenceImages: typeof r.maxReferenceImages === 'number' ? r.maxReferenceImages : 1,
    aspectRatios: Array.isArray(r.aspectRatios) && r.aspectRatios.length ? r.aspectRatios : ['1:1', '16:9', '9:16'],
    costPerImageUsd: Array.isArray(r.costPerImageUsd) && r.costPerImageUsd.length === 2 ? r.costPerImageUsd : [0.02, 0.1],
    maxBatchN: 1,
    batchStrategy: 'parallel' as BatchStrategy,
    brief: r.brief || `${r.label || d.liveId} — discovered on ${d.provider}, researched automatically.`,
    sourceRefreshedAt: new Date(now).toISOString().slice(0, 10),
    preview: !trusted,
    needsResearch: !trusted,
  };
}

async function putCard(repo: Repository, rec: Omit<ModelCard, 'user_id' | 'category' | 'status'>): Promise<void> {
  await repo.put({ ...rec, user_id: SYSTEM_USER_ID, category: 'model_card', status: 'active' } as ModelCard);
}

/** Find which provider record flagged a given curated model id as a ghost. */
function providerOfGhost(modelId: string, state: Map<string, ModelRefreshRecord>): string {
  for (const rec of state.values()) if (rec.unconfirmed.includes(modelId)) return rec.provider;
  return 'unknown';
}

/**
 * Run one maintenance pass: research every un-carded discovery, and age/retire/reset ghosts on
 * repeated-miss evidence. Never throws on a single failure (a research miss just skips that model).
 */
export async function runMaintenance(repo: Repository, deps: MaintenanceDeps): Promise<MaintenanceSummary> {
  const now = deps.now;
  const threshold = deps.retireThreshold ?? DEFAULT_RETIRE_THRESHOLD;
  const state = await loadRefreshState(repo);
  const cards = await loadCards(repo);

  const confirmedIds = new Set<string>();
  for (const rec of state.values()) rec.confirmed.forEach((id) => confirmedIds.add(id));

  // RESET: any ghost/retired seed model that is confirmed again → un-flag (reversible).
  const reset: string[] = [];
  for (const c of cards.values()) {
    if (c.origin === 'seed_override' && confirmedIds.has(c.model_id) && ((c.miss_count ?? 0) > 0 || c.retired)) {
      await repo.update<ModelCard>('model_card', c.id, { miss_count: 0, retired: false, updated_at: now });
      reset.push(c.model_id);
    }
  }

  // DISCOVERIES: research the ones not already carded (dedup live ids within the pass too).
  const researched: string[] = [];
  let discoveriesSeen = 0;
  const cardedThisPass = new Set<string>();
  for (const rec of state.values()) {
    for (const d of rec.discovered) {
      discoveriesSeen++;
      const slug = slugId(d.id);
      if (cards.has(slug) || cardedThisPass.has(slug)) continue;
      let model: ImageModel | null = null;
      let confidence: ResearchedModel['confidence'] = 'low';
      let source: string | undefined;
      try {
        const r = await deps.research({ provider: rec.provider, liveId: d.id, label: d.label });
        if (r) {
          model = toImageModel(r, { provider: rec.provider, liveId: d.id, label: d.label }, now);
          confidence = r.confidence;
          source = r.source;
        }
      } catch {
        model = null;
      }
      if (!model) continue;
      await putCard(repo, {
        id: `model_card:${model.id}`,
        created_at: now,
        updated_at: now,
        model_id: model.id,
        provider: rec.provider,
        card: model,
        origin: 'discovered',
        confidence,
        researched_at: now,
        source,
      });
      researched.push(model.id);
      cardedThisPass.add(model.id);
    }
  }

  // GHOSTS: a curated id unconfirmed AND not confirmed anywhere → age it; retire at the threshold.
  const ghostIds = new Set<string>();
  for (const rec of state.values()) for (const id of rec.unconfirmed) if (!confirmedIds.has(id)) ghostIds.add(id);
  const incremented: string[] = [];
  const retired: string[] = [];
  for (const modelId of ghostIds) {
    const existing = cards.get(modelId);
    const prevMiss = existing?.origin === 'seed_override' ? existing.miss_count ?? 0 : 0;
    const miss = prevMiss + 1;
    const willRetire = miss >= threshold;
    if (existing && existing.origin === 'seed_override') {
      await repo.update<ModelCard>('model_card', existing.id, { miss_count: miss, retired: willRetire, updated_at: now });
    } else {
      await putCard(repo, {
        id: `model_card:${modelId}`,
        created_at: now,
        updated_at: now,
        model_id: modelId,
        provider: providerOfGhost(modelId, state),
        card: null,
        origin: 'seed_override',
        confidence: 'medium',
        miss_count: miss,
        retired: willRetire,
        researched_at: now,
      });
    }
    (willRetire ? retired : incremented).push(modelId);
  }

  return { ranAt: now, researched, retired, incremented, reset, discoveriesSeen, ghostsSeen: ghostIds.size };
}

// ── Real research via Claude (injected in tests) ─────────────────────────────────────────────────

const RESEARCH_SYSTEM = `You are Pixcel's model-research specialist. Given a generative-media model \
(its provider, docs URL, and id), produce a CONSERVATIVE capability record as JSON.

Rules:
- Only assert what you're reasonably confident about from the id/provider/your knowledge. NEVER fabricate specifics.
- If you're unsure, set "confidence":"low" and omit fields you can't support. Low confidence keeps the model out of live routing until a human/better pass confirms it — that's the safe default.
- Output ONE JSON object, no prose, matching:
{"label":string,"brief":string,"tier":1|2|3,"capabilities":string[],"supportsEditing":boolean,"maxReferenceImages":number,"costPerImageUsd":[number,number],"aspectRatios":string[],"strengths":{"photorealism":0-5,...},"confidence":"low"|"medium"|"high","source":string}
Valid capabilities: text_in_image, editing, multi_reference, photorealism, vector, high_resolution, fast, cheap.`;

function extractText(msg: Anthropic.Message): string {
  return (msg.content ?? [])
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Tolerantly parse the research JSON; null on anything unusable. */
export function parseResearch(text: string): ResearchedModel | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof o.label !== 'string' || typeof o.brief !== 'string') return null;
    const conf = o.confidence === 'high' || o.confidence === 'medium' ? o.confidence : 'low';
    return { ...(o as unknown as ResearchedModel), confidence: conf };
  } catch {
    return null;
  }
}

/** Research one discovery with Claude. Best-effort — null on any failure (the pass skips it). */
export async function researchWithClaude(d: Discovery, client?: Anthropic): Promise<ResearchedModel | null> {
  const provider = getProvider(d.provider);
  const c = client ?? new Anthropic();
  try {
    const params = {
      model: MODEL,
      max_tokens: 800,
      thinking: { type: 'adaptive' },
      system: RESEARCH_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `PROVIDER: ${provider?.label ?? d.provider}\n` +
            `DOCS: ${provider?.docsUrl ?? '(none)'}\n` +
            `MODEL ID: ${d.liveId}\n` +
            `LABEL: ${d.label ?? '(none)'}`,
        },
      ],
    };
    const msg = await c.messages.create(params as any);
    return parseResearch(extractText(msg));
  } catch {
    return null;
  }
}

/** Default deps for a real maintenance pass (Claude research, real clock). */
export function liveMaintenanceDeps(now: number): MaintenanceDeps {
  return { now, research: (d) => researchWithClaude(d) };
}
