/**
 * Unit tests for the routing brain's PURE logic — Gate 1 filter, cost estimation,
 * the deterministic fallback, and the tolerant fan-out parser. No network, no keys:
 * `hasKey` is injected. Run: `tsx --test src/lib/engine/__tests__/routing.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gate1Filter,
  estimateCost,
  deterministicRoute,
  parseFanout,
  type RoutingRequest,
} from '../routing';
import { IMAGE_MODELS, getModel } from '../model-registry';

/** All keys present — isolates capability/budget logic from env. */
const allKeys = () => true;
/** Only OpenAI present. */
const onlyOpenAI = (k: string) => k === 'OPENAI_API_KEY';

function req(partial: Partial<RoutingRequest> = {}): RoutingRequest {
  return { intent: 'a red sports car', needs: [], count: 1, ...partial };
}

test('gate1: no needs + all keys → every non-preview model survives', () => {
  const { survivors, dropped } = gate1Filter(req(), allKeys);
  const nonPreview = IMAGE_MODELS.filter((m) => !m.preview);
  assert.equal(survivors.length, nonPreview.length);
  // The only drops are preview (registry-knowledge) models — never routed to.
  assert.ok(dropped.every((d) => d.reason === 'preview'));
});

test('gate1: a required capability drops models that lack it', () => {
  const { survivors, dropped } = gate1Filter(req({ needs: ['vector'] }), allKeys);
  // Only recraft-v3 advertises 'vector' in the starter catalog.
  assert.deepEqual(survivors.map((m) => m.id), ['recraft-v4.1']);
  assert.ok(dropped.every((d) => d.reason === 'missing_capability' || d.reason === 'preview'));
});

test('gate1: editing keeps only models with an edit path', () => {
  const { survivors } = gate1Filter(req({ editing: true }), allKeys);
  // Every current non-preview model has an edit path (FLUX.2 included) — the invariant that matters
  // is that nothing WITHOUT one survives.
  assert.ok(survivors.length > 0);
  assert.ok(survivors.every((m) => m.supportsEditing));
});

test('gate1: aspect ratio is a hint, NEVER a drop', () => {
  // Deliberate design (see routing.ts): hand-typed aspect lists are data hints — models snap/clamp
  // downstream. Benching on them is the collapse-the-fan bug. 21:9 must not bench anyone.
  const { survivors, dropped } = gate1Filter(req({ aspectRatio: '21:9' }), allKeys);
  assert.equal(survivors.length, IMAGE_MODELS.filter((m) => !m.preview).length);
  assert.ok(dropped.every((d) => d.reason === 'preview'));
});

test('gate1: missing key drops the model with reason no_key', () => {
  const { survivors, dropped } = gate1Filter(req(), onlyOpenAI);
  assert.deepEqual(survivors.map((m) => m.id), ['gpt-image-1.5']);
  assert.ok(dropped.some((d) => d.reason === 'no_key'));
});

test('gate1: budget drops models whose min spend exceeds it', () => {
  // count 5, budget $0.10 → drops models with low-cost*5 > 0.10 (e.g. gpt-image-1.5 @ $0.02*5=$0.10 is exactly ok; ideogram @ $0.06*5=$0.30 dropped).
  const { survivors, dropped } = gate1Filter(req({ count: 5, budgetUsd: 0.1 }), allKeys);
  assert.ok(survivors.find((m) => m.id === 'flux-2-dev')); // cheap survives
  assert.ok(dropped.some((d) => d.reason === 'over_budget'));
  assert.ok(!survivors.find((m) => m.id === 'ideogram-v3'));
});

test('estimateCost: sums the (low, high) band across the fan-out', () => {
  const flux = getModel('flux-2-pro')!;
  const [lo, hi] = estimateCost([{ modelId: 'flux-2-pro', n: 4, rationale: '' }]);
  assert.equal(lo, Number((flux.costPerImageUsd[0] * 4).toFixed(3)));
  assert.equal(hi, Number((flux.costPerImageUsd[1] * 4).toFixed(3)));
});

test('deterministicRoute: highest-tier survivor takes the whole count', () => {
  const { survivors, dropped } = gate1Filter(req({ count: 4 }), allKeys);
  const decision = deterministicRoute(req({ count: 4 }), survivors, dropped)!;
  assert.equal(decision.fanout.length, 1);
  assert.equal(decision.primary.n, 4);
  assert.equal(getModel(decision.primary.modelId)!.tier, 3);
});

test('deterministicRoute: no survivors → null', () => {
  assert.equal(deterministicRoute(req(), [], []), null);
});

test('parseFanout: valid JSON, sums preserved', () => {
  const survivors = IMAGE_MODELS;
  const text = '{"fanout":[{"modelId":"flux-2-pro","n":2,"rationale":"a"},{"modelId":"gpt-image-1.5","n":2,"rationale":"b"}]}';
  const fanout = parseFanout(text, survivors, 4);
  assert.equal(fanout.reduce((s, r) => s + r.n, 0), 4);
  assert.deepEqual(fanout.map((r) => r.modelId).sort(), ['flux-2-pro', 'gpt-image-1.5']);
});

test('parseFanout: drops unknown ids and rebalances to count', () => {
  const survivors = IMAGE_MODELS;
  const text = '{"fanout":[{"modelId":"not-a-real-model","n":3},{"modelId":"flux-2-dev","n":1}]}';
  const fanout = parseFanout(text, survivors, 4);
  assert.deepEqual(fanout.map((r) => r.modelId), ['flux-2-dev']);
  assert.equal(fanout[0].n, 4); // padded up to the requested count
});

test('parseFanout: junk / non-JSON → empty (caller falls back)', () => {
  assert.deepEqual(parseFanout('sorry, I cannot help', IMAGE_MODELS, 3), []);
  assert.deepEqual(parseFanout('{"nope":1}', IMAGE_MODELS, 3), []);
});

test('parseFanout: overflow is trimmed down to count', () => {
  const text = '{"fanout":[{"modelId":"flux-2-dev","n":5},{"modelId":"gpt-image-1.5","n":5}]}';
  const fanout = parseFanout(text, IMAGE_MODELS, 4);
  assert.equal(fanout.reduce((s, r) => s + r.n, 0), 4);
});
