/**
 * THE VIDEO COORDINATOR — route → dispatch → stream, for motion.
 *
 * The video twin of `coordinator.ts`, and a port rather than a copy for the same reason the seam
 * was: a video run is a set of JOBS, not a burst of calls. Each model queues, runs for 75–120
 * seconds, then delivers. So this conducts differently in three ways that matter:
 *
 *   · It streams PER-MODEL LIFECYCLE (queued → progress → clip), because with minute-long renders a
 *     silent gap is indistinguishable from a hang. The image fan can get away with tiles appearing;
 *     video cannot.
 *   · It runs the fan CONCURRENTLY and interleaves events as they arrive. Sequential would mean
 *     four models × 100s = nearly seven minutes before the last clip.
 *   · It gates on money BEFORE dispatching, not after, and it refuses rather than downgrades. One
 *     10-second 1080p clip is $3.40; discovering the cost afterwards is not acceptable here.
 *
 * A failing model never fails the run — the rest keep going, and what happened is reported.
 * Importing this registers the video adapters.
 */

import './adapters/fal-video';
import { getVideoExecutor, type VideoClip, type VideoEvent } from './video-executor';
import {
  routeVideo,
  allVideoModels,
  loadVideoDoctrines,
  type VideoRoutingRequest,
  type VideoCandidate,
} from '../agents/video-model-agent';

/** One delivered clip + which model made it. */
export interface ClipTile {
  modelId: string;
  modelLabel: string;
  clip: VideoClip;
}

export type VideoCoordEvent =
  | {
      type: 'routed';
      models: { modelId: string; label: string; why: string; estUsd: number }[];
      dropped: { modelId: string; label: string; reason: string }[];
      estimatedUsd: number;
    }
  | { type: 'model_queued'; modelId: string; modelLabel: string; jobId: string }
  | { type: 'model_progress'; modelId: string; stage: string }
  | { type: 'clip'; tile: ClipTile; totalSoFar: number }
  | { type: 'model_done'; modelId: string; delivered: number; ms: number; costUsd: number }
  | { type: 'model_error'; modelId: string; reason: string; detail?: string }
  /** Non-blocking heads-up — the run still succeeds. */
  | { type: 'notice'; message: string }
  | { type: 'done'; tiles: ClipTile[]; costUsd: number }
  | { type: 'error'; message: string };

export interface VideoCoordinateOptions {
  /** Spend still available, USD. The run is refused if the fan's estimate exceeds it. */
  budgetUsd?: number;
  /** Clips per model. */
  perModel?: number;
  /** Injected for tests — defaults to the live doctrine store. */
  doctrines?: Awaited<ReturnType<typeof loadVideoDoctrines>>;
  /** Injected for tests — defaults to the live registry. */
  catalog?: ReturnType<typeof allVideoModels>;
}

/** Merge several async iterables, yielding whatever arrives first. */
async function* interleave<T>(streams: AsyncIterable<T>[]): AsyncGenerator<T> {
  const its = streams.map((s) => s[Symbol.asyncIterator]());
  const pending = new Map(its.map((it, i) => [i, it.next().then((r) => ({ i, r }))]));
  while (pending.size > 0) {
    const { i, r } = await Promise.race(pending.values());
    if (r.done) {
      pending.delete(i);
      continue;
    }
    yield r.value;
    pending.set(i, its[i].next().then((res) => ({ i, r: res })));
  }
}

/**
 * Run a video generation for a request, streaming events as the fan unfolds.
 * Never throws — every failure surfaces as `model_error` or a terminal `error`.
 */
export async function* coordinateVideo(
  req: VideoRoutingRequest,
  opts: VideoCoordinateOptions = {},
): AsyncGenerator<VideoCoordEvent> {
  const perModel = Math.max(1, opts.perModel ?? 1);
  const catalog = opts.catalog ?? allVideoModels();
  const doctrines = opts.doctrines ?? (await loadVideoDoctrines());

  const { candidates, dropped } = routeVideo({ ...req, budgetUsd: undefined }, catalog, doctrines);
  if (candidates.length === 0) {
    // Say WHY nothing ran. "No models available" with no reason is the failure mode this project
    // has fixed twice already.
    const why = dropped.length > 0 ? dropped.map((d) => `${d.label}: ${d.reason}`).join(' · ') : 'no video models are configured';
    yield { type: 'error', message: `No video model can serve this request — ${why}` };
    return;
  }

  // MONEY BEFORE DISPATCH. Priced from the CANDIDATES THEMSELVES — each carries the estimate routing
  // already computed against its own price table. Re-looking the ids up in the global registry (as an
  // earlier version did) prices anything not found at $0, which turns the gate into a rubber stamp
  // for exactly the models we know least about. A money gate must never fail open.
  const estimatedUsd = Number(candidates.reduce((n, c) => n + c.estimate.totalUsd * perModel, 0).toFixed(3));
  const totalClips = candidates.length * perModel;
  const spec = `${totalClips} clip${totalClips === 1 ? '' : 's'} · ${req.durationSec ?? 5}s${req.resolution ? ` · ${req.resolution}` : ''}`;

  if (opts.budgetUsd != null && estimatedUsd > opts.budgetUsd) {
    yield {
      type: 'error',
      message: `${spec} ≈ $${estimatedUsd.toFixed(2)}, over the $${opts.budgetUsd.toFixed(2)} left. Reduce the models, count, length or resolution, or raise your budget.`,
    };
    return;
  }

  yield {
    type: 'routed',
    models: candidates.map((c) => ({ modelId: c.model.id, label: c.model.label, why: c.why, estUsd: c.estimate.totalUsd * perModel })),
    dropped,
    estimatedUsd,
  };

  const tiles: ClipTile[] = [];
  let costUsd = 0;

  /** One model's run, tagged so the interleaved stream knows who spoke. */
  async function* runModel(c: VideoCandidate): AsyncGenerator<VideoCoordEvent> {
    const exec = getVideoExecutor(c.model.provider);
    if (!exec) {
      yield { type: 'model_error', modelId: c.model.id, reason: 'no_adapter' };
      return;
    }
    const started = Date.now();
    let delivered = 0;
    let modelCost = 0;

    for (let take = 0; take < perModel; take++) {
      let events: AsyncIterable<VideoEvent>;
      try {
        events = exec.generate({
          modelId: c.model.id,
          prompt: req.intent,
          durationSec: req.durationSec,
          resolution: req.resolution,
          aspectRatio: req.aspectRatio,
          audio: req.needsAudio,
          task: req.task,
        });
      } catch {
        yield { type: 'model_error', modelId: c.model.id, reason: 'transport' };
        return;
      }
      for await (const ev of events) {
        if (ev.type === 'queued') yield { type: 'model_queued', modelId: c.model.id, modelLabel: c.model.label, jobId: ev.jobId };
        else if (ev.type === 'progress') yield { type: 'model_progress', modelId: c.model.id, stage: ev.stage ?? 'Working…' };
        else if (ev.type === 'clip') {
          const tile: ClipTile = { modelId: c.model.id, modelLabel: c.model.label, clip: ev.clip };
          tiles.push(tile);
          delivered++;
          yield { type: 'clip', tile, totalSoFar: tiles.length };
        } else if (ev.type === 'done') {
          modelCost += ev.costUsd ?? 0;
        } else if (ev.type === 'error') {
          yield { type: 'model_error', modelId: c.model.id, reason: ev.reason, detail: ev.detail };
        }
      }
    }
    costUsd = Number((costUsd + modelCost).toFixed(3));
    yield { type: 'model_done', modelId: c.model.id, delivered, ms: Date.now() - started, costUsd: Number(modelCost.toFixed(3)) };
  }

  // Concurrent: sequential would make a four-model fan take the sum of four multi-minute renders.
  yield* interleave(candidates.map((c) => runModel(c)));

  if (tiles.length === 0) {
    yield { type: 'error', message: 'Every model failed to deliver a clip. Nothing was charged for the failed jobs.' };
    return;
  }
  const asked = candidates.length * perModel;
  if (tiles.length < asked) {
    yield { type: 'notice', message: `Delivered ${tiles.length} of ${asked} clips — the rest failed or came up short.` };
  }
  yield { type: 'done', tiles, costUsd };
}
