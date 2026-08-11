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
  | { type: 'routed'; decision: RoutingDecision }
  | { type: 'model_start'; modelId: string; modelLabel: string; n: number }
  | { type: 'tile'; tile: GalleryTile; totalSoFar: number }
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
  yield { type: 'routed', decision };

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
    try {
      for await (const ev of executor.generate({ modelId: model.id, prompt: req.intent, n: routed.n, aspectRatio: req.aspectRatio, references: fittedRefs })) {
        if (ev.type === 'tile') {
          const tile: GalleryTile = { modelId: model.id, modelLabel: model.label, image: ev.image };
          tiles.push(tile);
          push({ type: 'tile', tile, totalSoFar: tiles.length });
        } else if (ev.type === 'done') {
          costUsd = Number((costUsd + ev.costUsd).toFixed(3));
        } else if (ev.type === 'error') {
          push({ type: 'model_error', modelId: model.id, reason: ev.reason });
        }
      }
    } catch (err) {
      push({ type: 'model_error', modelId: model.id, reason: err instanceof Error ? err.message : 'adapter crashed' });
    }
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
