/**
 * Video coordinator tests — routing, the money gate, concurrency and partial failure. The adapters
 * are never called: a fake executor stands in, so these run with no network and no spend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordinateVideo, type VideoCoordEvent } from '../video-coordinator';
import { registerVideoExecutor, type VideoEvent, type VideoRequest } from '../video-executor';
import { allVideoModels } from '../../agents/video-model-agent';
import type { MediaModel } from '../media-registry';

/** A stand-in provider whose behaviour each test scripts. */
const script = new Map<string, (req: VideoRequest) => AsyncGenerator<VideoEvent>>();
registerVideoExecutor({
  provider: 'test-provider',
  isConfigured: () => true,
  generate: (req) => script.get(req.modelId)!(req),
});

async function* ok(url: string, costUsd = 0.28): AsyncGenerator<VideoEvent> {
  yield { type: 'queued', jobId: 'job-1' };
  yield { type: 'progress', stage: 'Generating…' };
  yield { type: 'clip', clip: { url }, index: 0 };
  yield { type: 'done', clips: [{ url }], costUsd };
}
async function* fails(): AsyncGenerator<VideoEvent> {
  yield { type: 'queued', jobId: 'job-x' };
  yield { type: 'error', reason: 'moderated', detail: 'blocked by policy' };
}

const seedance = allVideoModels().find((m) => m.id === 'seedance-2')!;
const runnable = (id: string, label: string): MediaModel =>
  ({ ...seedance, id, label, provider: 'test-provider', preview: false, needsResearch: false }) as MediaModel;

const collect = async (gen: AsyncGenerator<VideoCoordEvent>) => {
  const out: VideoCoordEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

test('a clean run streams the full job lifecycle, then done', async () => {
  script.set('a', () => ok('https://cdn/a.mp4'));
  const events = await collect(
    coordinateVideo({ intent: 'a red car' }, { catalog: [runnable('a', 'A')], doctrines: new Map() }),
  );
  const types = events.map((e) => e.type);
  // Queued and progress matter: a 100-second render with no signal looks like a hang.
  assert.deepEqual(types, ['routed', 'model_queued', 'model_progress', 'clip', 'model_done', 'done']);
  const done = events.at(-1) as Extract<VideoCoordEvent, { type: 'done' }>;
  assert.equal(done.tiles.length, 1);
  assert.equal(done.costUsd, 0.28);
});

test('MONEY GATE: an unaffordable fan is refused whole, before anything is dispatched', async () => {
  let dispatched = false;
  script.set('a', () => {
    dispatched = true;
    return ok('https://cdn/a.mp4');
  });
  const events = await collect(
    coordinateVideo(
      { intent: 'a shot', durationSec: 10, resolution: '1080p' },
      { catalog: [runnable('a', 'A')], doctrines: new Map(), budgetUsd: 1 },
    ),
  );
  assert.equal(dispatched, false, 'nothing may run before the money question is settled');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match((events[0] as { message: string }).message, /over the \$1\.00 left/);
  // It names the knobs and never quietly renders something cheaper.
  assert.match((events[0] as { message: string }).message, /length or resolution/);
});

test('one model failing never fails the run — the rest still deliver', async () => {
  script.set('a', () => fails());
  script.set('b', () => ok('https://cdn/b.mp4'));
  const events = await collect(
    coordinateVideo({ intent: 'x', fanModels: 2 }, { catalog: [runnable('a', 'A'), runnable('b', 'B')], doctrines: new Map() }),
  );
  const err = events.find((e) => e.type === 'model_error') as Extract<VideoCoordEvent, { type: 'model_error' }>;
  assert.equal(err.reason, 'moderated');
  assert.equal(err.detail, 'blocked by policy');
  const done = events.at(-1) as Extract<VideoCoordEvent, { type: 'done' }>;
  assert.equal(done.tiles.length, 1);
  // The shortfall is stated rather than left for the user to notice.
  assert.ok(events.some((e) => e.type === 'notice' && /1 of 2 clips/.test(e.message)));
});

test('when EVERY model fails, it says so instead of reporting an empty success', async () => {
  script.set('a', () => fails());
  const events = await collect(
    coordinateVideo({ intent: 'x' }, { catalog: [runnable('a', 'A')], doctrines: new Map() }),
  );
  const last = events.at(-1)!;
  assert.equal(last.type, 'error');
  assert.match((last as { message: string }).message, /Every model failed/);
});

test('no candidates → the reason each model was excluded, not just "unavailable"', async () => {
  // A 30s ask against a 15s model.
  const events = await collect(
    coordinateVideo({ intent: 'x', durationSec: 30 }, { catalog: [runnable('a', 'A')], doctrines: new Map() }),
  );
  assert.equal(events.length, 1);
  assert.match((events[0] as { message: string }).message, /up to 15s; you asked for 30s/);
});

test('the fan runs CONCURRENTLY — not the sum of each render', async () => {
  const slow = (url: string, ms: number) =>
    async function* (): AsyncGenerator<VideoEvent> {
      yield { type: 'queued', jobId: 'j' };
      await new Promise((r) => setTimeout(r, ms));
      yield { type: 'clip', clip: { url }, index: 0 };
      yield { type: 'done', clips: [{ url }], costUsd: 0.1 };
    };
  script.set('a', slow('https://cdn/a.mp4', 120));
  script.set('b', slow('https://cdn/b.mp4', 120));
  const t0 = Date.now();
  const events = await collect(
    coordinateVideo({ intent: 'x', fanModels: 2 }, { catalog: [runnable('a', 'A'), runnable('b', 'B')], doctrines: new Map() }),
  );
  const elapsed = Date.now() - t0;
  // Both models must actually have run, or "fast" would just mean "did less".
  assert.equal(events.filter((e) => e.type === 'clip').length, 2);
  assert.ok(elapsed < 220, `two 120ms renders should overlap, took ${elapsed}ms`);
});

test('routed reports what will run, why, and the estimated spend up front', async () => {
  script.set('a', () => ok('https://cdn/a.mp4'));
  const events = await collect(
    coordinateVideo({ intent: 'x', durationSec: 4, resolution: '480p' }, { catalog: [runnable('a', 'A')], doctrines: new Map() }),
  );
  const routed = events[0] as Extract<VideoCoordEvent, { type: 'routed' }>;
  assert.equal(routed.models[0].label, 'A');
  assert.ok(routed.models[0].why.length > 0);
  assert.equal(routed.estimatedUsd, 0.28); // 4s x $0.07 at 480p
});
