/**
 * Doctrine refresh — keeps every model's PROMPT DOCTRINE current on the same daily cycle as the
 * numbers, WITHOUT paying LLM spend for unchanged docs:
 *
 *   due (missing or past TTL) → fetch pinned docs in FULL → hash the corpus →
 *     hash unchanged + doctrine healthy → restamp only (free; providers rarely edit docs daily)
 *     hash changed / first run / weak doctrine → re-distill with the research brain → persist
 *
 * Persisted as `model_doctrine` records the live catalog surfaces to the Guide, the builder's
 * formula, and (next) the honest craft score. Same honesty rules as capability research: a doctrine
 * is only as good as the docs it read; low-confidence is stored but flagged, never dressed up.
 */

import type { Repository } from '../db/repository';
import type { ModelDoctrineRecord } from '../db/models';
import type { ImageModel } from '../engine/model-registry';
import { DEFAULT_TTL_HOURS } from '../engine/staleness';
import {
  fetchPinnedDocs,
  distillDoctrine,
  corpusHash,
  type ModelDoctrine,
  type FetchedDoc,
} from './model-agent/doctrine';

export const SYSTEM_USER_ID = 'system';
const recordId = (modelId: string) => `model_doctrine:${modelId}`;

export interface DoctrineRefreshDeps {
  now: number;
  /** Which craft lens to distill under. Video is a different subject — camera, motion, duration,
   *  synced audio — so asking the image questions of a video guide yields image answers. */
  modality?: 'image' | 'video';
  /** Injected for tests; default = real Tavily fetch + Fable distillation. */
  fetchDocs?: (m: ImageModel) => Promise<FetchedDoc[]>;
  distill?: (m: ImageModel, fetched: FetchedDoc[]) => Promise<ModelDoctrine | null>;
  ttlHours?: number;
  /** Cap per pass so one trigger never spikes; the TTL staggers the rest across turns. */
  maxPerPass?: number;
}

export interface DoctrineRefreshResult {
  modelId: string;
  outcome: 'distilled' | 'unchanged' | 'no_docs' | 'failed';
  confidence?: 'low' | 'medium' | 'high';
}

/** Load all doctrine records, keyed by model_id. */
export async function loadDoctrines(repo: Repository): Promise<Map<string, ModelDoctrineRecord>> {
  const res = await repo.query({ category: 'model_doctrine', user_id: SYSTEM_USER_ID, filter: { status: 'active' } });
  const map = new Map<string, ModelDoctrineRecord>();
  for (const r of res.items as ModelDoctrineRecord[]) map.set(r.model_id, r);
  return map;
}

/** One model's stored doctrine (typed), or null. Guarded — a bad record can never dead-end a caller. */
export async function getDoctrine(repo: Repository, modelId: string): Promise<ModelDoctrine | null> {
  try {
    const res = await repo.query({ category: 'model_doctrine', user_id: SYSTEM_USER_ID, filter: { status: 'active' } });
    const rec = (res.items as ModelDoctrineRecord[]).find((r) => r.model_id === modelId);
    return (rec?.doctrine as ModelDoctrine | undefined) ?? null;
  } catch {
    return null;
  }
}

async function refreshOne(
  m: ImageModel,
  existing: ModelDoctrineRecord | undefined,
  repo: Repository,
  deps: DoctrineRefreshDeps,
): Promise<DoctrineRefreshResult> {
  const fetchDocs = deps.fetchDocs ?? fetchPinnedDocs;
  const distill = deps.distill ?? ((mm: ImageModel, ff: FetchedDoc[]) => distillDoctrine(mm, ff, { modality: deps.modality ?? 'image' }));

  const fetched = await fetchDocs(m);
  if (fetched.length === 0) return { modelId: m.id, outcome: 'no_docs' };

  const hash = corpusHash(fetched.map((f) => `${f.doc.url}\n${f.content}`).join('\n---\n'));
  const prevHash = existing?.sources?.[0]?.content_hash;
  const healthy = !!existing?.doctrine && existing.confidence !== 'low';

  // Unchanged docs + a healthy doctrine → restamp freshness only. Zero LLM spend.
  if (healthy && prevHash === hash) {
    await repo.put({ ...existing!, distilled_at: deps.now, updated_at: deps.now });
    return { modelId: m.id, outcome: 'unchanged', confidence: existing!.confidence };
  }

  const doctrine = await distill(m, fetched);
  if (!doctrine) return { modelId: m.id, outcome: 'failed' };

  const rec: ModelDoctrineRecord = {
    id: recordId(m.id),
    user_id: SYSTEM_USER_ID,
    category: 'model_doctrine',
    status: 'active',
    created_at: existing?.created_at ?? deps.now,
    updated_at: deps.now,
    model_id: m.id,
    provider: m.provider,
    doctrine,
    confidence: doctrine.confidence,
    distilled_at: deps.now,
    // The corpus hash rides on the source list (first entry) — the change gate for the next pass.
    sources: fetched.map((f, i) => ({ url: f.doc.url, kind: f.doc.kind, ...(i === 0 ? { content_hash: hash } : {}) })),
  };
  await repo.put(rec);
  return { modelId: m.id, outcome: 'distilled', confidence: doctrine.confidence };
}

/**
 * TTL-gated doctrine pass over the catalog: refresh models whose doctrine is MISSING or stale.
 * Daily due-check is ~free (one DB read + doc fetches only for due models); distillation runs only
 * on changed/first-time corpora. Safe to fire-and-forget from the intelligence workflow.
 */
export async function refreshDoctrineIfDue(
  models: ImageModel[],
  repo: Repository,
  deps: DoctrineRefreshDeps,
): Promise<DoctrineRefreshResult[]> {
  const ttl = deps.ttlHours ?? DEFAULT_TTL_HOURS;
  const maxPerPass = deps.maxPerPass ?? 2;

  let existing = new Map<string, ModelDoctrineRecord>();
  try {
    existing = await loadDoctrines(repo);
  } catch {
    /* no records yet — everything is due */
  }

  const due = models
    .filter((m) => (m.docs ?? []).length > 0)
    .filter((m) => {
      const rec = existing.get(m.id);
      if (!rec) return true; // never distilled → due
      if (!rec.doctrine || rec.confidence === 'low') return true; // weak → retry
      return (deps.now - rec.distilled_at) / 3_600_000 >= ttl;
    })
    .slice(0, maxPerPass);

  const results: DoctrineRefreshResult[] = [];
  for (const m of due) {
    try {
      results.push(await refreshOne(m, existing.get(m.id), repo, deps));
    } catch (err) {
      console.warn(`[doctrine-refresh] ${m.id} failed:`, err);
      results.push({ modelId: m.id, outcome: 'failed' });
    }
  }
  return results;
}

/** The full (non-gated) pass — every model with pinned docs. The manual/cron trigger's variant. */
export async function refreshDoctrine(
  models: ImageModel[],
  repo: Repository,
  deps: DoctrineRefreshDeps,
): Promise<DoctrineRefreshResult[]> {
  return refreshDoctrineIfDue(models, repo, { ...deps, ttlHours: 0, maxPerPass: models.length });
}
