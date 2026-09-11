import '../../../../lib/engine/adapters'; // registers provider adapters so readyProviders() is accurate
import { readyProviders } from '../../../../lib/engine/executor';
import { getDb } from '../../../../lib/db';
import { getLiveCatalog } from '../../../../lib/agents/live-catalog';
import { loadDoctrines } from '../../../../lib/agents/doctrine-refresh';
import { documentedTasks, modelsForTask } from '../../../../lib/engine/model-features';
import { normalizeTask } from '../../../../lib/engine/task-vocabulary';
import { describeSlots } from '../../../../lib/engine/reference-planning';
import type { ModelDoctrine } from '../../../../lib/agents/model-agent/doctrine';

export const runtime = 'nodejs';

/**
 * GET /api/models/list — the image models the fan-out picker offers, read from the LIVE catalog
 * (seed + researched corrections), never the raw seed.
 *
 * Each model carries what the picker needs to show + choose: label, provider, tier, capabilities,
 * cost band, ref limits, READY state — plus the answer to "what is this model actually FOR":
 * `features`, the tasks its own documentation evidences, in Pixcel's professional vocabulary. And
 * `verified`/`doctrine` make the provenance visible, so "are we on the latest model?" is answerable
 * on the surface instead of being a matter of trust.
 *
 * `?task=<slug>` filters+ranks to the models that can genuinely serve that task (unsupported models
 * are excluded, documented-native first) — the routable form of "which model does X?".
 */
export async function GET(req: Request) {
  const ready = new Set(readyProviders());
  const db = await getDb();
  const [catalog, doctrineRecs] = await Promise.all([getLiveCatalog(db), loadDoctrines(db).catch(() => new Map())]);

  const doctrines = new Map<string, ModelDoctrine>();
  for (const [modelId, rec] of doctrineRecs) {
    if (rec.doctrine) doctrines.set(modelId, rec.doctrine as ModelDoctrine);
  }

  const callable = catalog.filter((m) => !m.preview && !m.needsResearch);
  const task = normalizeTask(new URL(req.url).searchParams.get('task') ?? '');
  const selected = task ? modelsForTask(callable, task, doctrines).map((c) => c.model) : callable;

  const models = selected.map((m) => {
    const doctrine = doctrines.get(m.id);
    return {
      id: m.id,
      label: m.label,
      provider: m.provider,
      tier: m.tier,
      capabilities: m.capabilities,
      brief: m.brief,
      maxReferenceImages: m.maxReferenceImages,
      referenceLimits: m.referenceLimits,
      inputSlots: m.inputSlots,
      inputSummary: describeSlots(m),
      costPerImageUsd: m.costPerImageUsd,
      ready: ready.has(m.provider),
      /** Provenance, surfaced: when this record was last verified + whether its doctrine is real. */
      verified: m.sourceRefreshedAt,
      doctrine: doctrine ? { confidence: doctrine.confidence, sources: doctrine.sources } : null,
      /** What the model's OWN docs show it doing, in our vocabulary. */
      features: documentedTasks(m, doctrine).map((f) => ({ task: f.task, support: f.support })),
    };
  });
  return Response.json({ models, task: task ?? null });
}
