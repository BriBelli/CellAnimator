/**
 * The coordinator — orchestrates a full image generation: route → dispatch → stream.
 *
 * This is the thin conductor that ties the brain (routing.ts) to the executors
 * (adapters). It does NOT generate; it decides the fan-out, dispatches each routed
 * model through its provider adapter, and emits a single unified event stream the
 * chat layer renders as an A2UI gallery. Cost is accumulated and hard-capped.
 *
 * Importing this module also registers all provider adapters (via ./adapters).
 */

import './adapters';
import { getModel } from './model-registry';
import { getExecutor } from './executor';
import { selectModels } from '../agents/model-agent';
import { type RoutingRequest, type RoutingDecision } from './routing';
import { fitReferencesToAspect } from './reference-fit';
import type { GenImage } from './executor';

/** A tile in the coordinated gallery — one image + which model made it. */
export interface GalleryTile {
  modelId: string;
  modelLabel: string;
  image: GenImage;
}

/** Events the coordinator streams while curating + running the workflow. */
export type CoordEvent =
  | { type: 'routed'; decision: RoutingDecision; models: { modelId: string; label: string; n: number; why?: string }[]; dropped: { modelId: string; label: string; reason: string }[] }
  | { type: 'model_start'; modelId: string; modelLabel: string; n: number }
  | { type: 'tile'; tile: GalleryTile; totalSoFar: number }
  /** One model's adapter stream settled cleanly — its per-model lifecycle record (delivered + wall ms). */
  | { type: 'model_done'; modelId: string; delivered: number; ms: number }
  | { type: 'model_error'; modelId: string; reason: string }
  /** A gentle, non-blocking heads-up (best-effort specialist): we delivered less than the ask
   *  (a model capped the batch, one failed, budget trimmed). Never an error — the run still succeeds. */
  | { type: 'notice'; message: string }
  | { type: 'done'; tiles: GalleryTile[]; costUsd: number }
  | { type: 'error'; message: string };

/** A hard ceiling so a runaway fan-out can never overspend on one request. */
const DEFAULT_MAX_COST_USD = 2.0;

export interface CoordinateOptions {
  maxCostUsd?: number;
}

/**
 * Run a full image generation for a routing request, yielding events as the
 * workflow unfolds. Never throws — failures surface as `model_error` / `error`.
 */

/** Turn a Gate-1 drop into a user-facing "skipped: <why>" — ONLY for reasons that explain why a model
 *  the user might expect isn't in the fan (references too many, no key, no edit path, over budget).
 *  Preview / aspect / bare capability drops are noise and are omitted. */
function dropDetail(d: { modelId: string; reason: string }, refCount: number): { modelId: string; label: string; reason: string } | null {
  const m = getModel(d.modelId);
  const label = m?.label ?? d.modelId;
  const cap = m?.maxReferenceImages ?? 1;
  switch (d.reason) {
    case 'ref_capacity': return { modelId: d.modelId, label, reason: `holds ${cap} reference${cap === 1 ? '' : 's'}, you attached ${refCount}` };
    case 'no_key': return { modelId: d.modelId, label, reason: 'no API key configured' };
    case 'no_edit': return { modelId: d.modelId, label, reason: 'no edit / reference path' };
    case 'over_budget': return { modelId: d.modelId, label, reason: 'over the render budget' };
    default: return null;
  }
}

export async function* coordinateImage(
  req: RoutingRequest,
  opts: CoordinateOptions = {}
): AsyncIterable<CoordEvent> {
  const maxCost = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD;

  // Ask the MODEL AGENT for the model(s) + fan-out (it restricts to configured providers + ranks).
  let decision: RoutingDecision | null;
  try {
    decision = await selectModels(req);
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : 'Model selection failed' };
    return;
  }
  if (!decision) {
    yield { type: 'error', message: 'No configured image provider can satisfy this request.' };
    return;
  }
  const refCount = req.references?.length ?? 0;
  yield {
    type: 'routed',
    decision,
    // Carry each pick's "why" (the selection rationale) so the UI can teach trust in the ranking.
    models: decision.fanout.map((r) => ({
      modelId: r.modelId,
      label: getModel(r.modelId)?.label ?? r.modelId,
      n: r.n,
      why: r.rationale || undefined,
    })),
    // Account for the benched models too — the user picked N, this explains any shortfall (e.g. Flux
    // holds 1 reference but you sent 3). Sorted best-first, capped so it never floods the panel.
    dropped: decision.dropped
      .map((d) => dropDetail(d, refCount))
      .filter((x): x is { modelId: string; label: string; reason: string } => x != null)
      .sort((a, b) => (getModel(b.modelId)?.tier ?? 0) - (getModel(a.modelId)?.tier ?? 0))
      .slice(0, 4),
  };

  // Guard the whole fan-out against the ceiling up front — on the WORST-CASE (high) estimate,
  // so a fan-out whose max could blow the cap never starts.
  if (decision.estCostUsd[1] > maxCost) {
    yield { type: 'error', message: `Estimated cost up to $${decision.estCostUsd[1]} exceeds the $${maxCost.toFixed(2)} remaining budget.` };
    return;
  }

  const tiles: GalleryTile[] = [];
  let costUsd = 0;

  // ASPECT-FIT the references ONCE (the GenAI trick): letterbox each reference onto the render's aspect
  // so a portrait ref conditions a 16:9 render instead of being warped/cloned. Shared by every fan-out
  // model. No aspect / no refs → unchanged. Failure returns the originals (never blocks a render).
  const fittedRefs = await fitReferencesToAspect(req.references, req.aspectRatio);

  // Dispatch ALL routed models in PARALLEL — the fan-out is the whole point (you see every model's take
  // at once, the "multi-grid loading" surface), so a model must never wait behind another. Each model's
  // adapter still streams its own tiles; we MERGE those streams into one event queue, interleaving tiles
  // as they land regardless of which model finished first. The up-front worst-case guard above already
  // blocks an over-budget fan from starting, so cost here just accumulates for the final `done`.
  const queue: CoordEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (ev: CoordEvent) => {
    queue.push(ev);
    if (wake) { wake(); wake = null; }
  };

  const runModel = async (routed: RoutingDecision['fanout'][number]): Promise<void> => {
    const model = getModel(routed.modelId);
    if (!model) return;
    const executor = getExecutor(model.provider);
    if (!executor || !executor.isConfigured()) {
      push({ type: 'model_error', modelId: routed.modelId, reason: 'no_key' });
      return;
    }
    push({ type: 'model_start', modelId: model.id, modelLabel: model.label, n: routed.n });
    // Per-model lifecycle record: wall time + delivered count → a terminal model_done / model_error,
    // so the UI can show each model's true state (still cooking vs settled vs failed) — never inferred.
    const t0 = Date.now();
    let delivered = 0;
    let failed = false;
    try {
      for await (const ev of executor.generate({ modelId: model.id, prompt: req.intent, n: routed.n, aspectRatio: req.aspectRatio, references: fittedRefs })) {
        if (ev.type === 'tile') {
          const tile: GalleryTile = { modelId: model.id, modelLabel: model.label, image: ev.image };
          tiles.push(tile);
          delivered += 1;
          push({ type: 'tile', tile, totalSoFar: tiles.length });
        } else if (ev.type === 'done') {
          costUsd = Number((costUsd + ev.costUsd).toFixed(3));
        } else if (ev.type === 'error') {
          failed = true;
          push({ type: 'model_error', modelId: model.id, reason: ev.reason });
        }
      }
    } catch (err) {
      failed = true;
      push({ type: 'model_error', modelId: model.id, reason: err instanceof Error ? err.message : 'adapter crashed' });
    }
    // A model that delivered tiles before erroring still ends 'failed' — partial output is honest,
    // but the terminal state names the failure (the tiles it did land remain in the gallery).
    if (!failed) push({ type: 'model_done', modelId: model.id, delivered, ms: Date.now() - t0 });
  };

  let running = decision.fanout.length;
  for (const routed of decision.fanout) {
    void runModel(routed).finally(() => {
      running -= 1;
      if (wake) { wake(); wake = null; }
    });
  }

  // Drain the merged queue, yielding events as they arrive until every model has settled.
  while (running > 0 || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => { wake = resolve; });
      continue;
    }
    yield queue.shift()!;
  }

  if (tiles.length === 0) {
    yield { type: 'error', message: 'No images were produced.' };
    return;
  }
  // Graceful specialist: if we delivered fewer than the ask (a model capped its batch, one failed,
  // or the cost ceiling trimmed the run), surface ONE gentle notice — never an error, the run stands.
  const want = decision.fanout.reduce((s, r) => s + r.n, 0) || Math.max(1, req.count);
  if (tiles.length < want) {
    yield { type: 'notice', message: `Rendered ${tiles.length} of ${want} — best effort (a model capped this batch or came up short).` };
  }
  yield { type: 'done', tiles, costUsd };
}
