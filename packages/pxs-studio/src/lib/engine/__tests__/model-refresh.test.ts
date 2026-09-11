/**
 * Unit tests for the refresh worker's PURE reconcile + due-selection. No network: `fetchLive` is
 * injected, `now` is passed in. Run: `tsx --test src/lib/engine/__tests__/model-refresh.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcile,
  providersDue,
  runRegistryRefresh,
  curatedMatchesLive,
  normalizeModelList,
  type LiveModel,
} from '../model-refresh';
import { IMAGE_MODELS, type ImageModel } from '../model-registry';
import { PROVIDERS, registryTag } from '../provider-roster';

const NOW = Date.parse('2026-07-17T00:00:00Z');

/** Two curated google (registry tag 'gemini') models with provider-side ids. */
const geminiModel = (over: Partial<ImageModel>): ImageModel =>
  ({
    id: 'nano-banana',
    label: 'Nano Banana',
    provider: 'gemini',
    envKey: 'GEMINI_API_KEY',
    providerModelId: 'gemini-2.5-flash-image',
    tier: 2,
    strengths: { photorealism: 4, prompt_adherence: 5, editing: 5, style_versatility: 4, text_rendering: 4, speed: 4, resolution: 4, consistency: 5, multimodal: 5 },
    capabilities: [],
    bestFor: [],
    supportsEditing: true,
    maxReferenceImages: 3,
    aspectRatios: ['1:1'],
    costPerImageUsd: [0.039, 0.039],
    maxBatchN: 1,
    batchStrategy: 'parallel',
    brief: '',
    sourceRefreshedAt: '2026-07-16',
    ...over,
  }) as ImageModel;

test('curatedMatchesLive: tolerant of preview/version suffixes, guards short slugs', () => {
  assert.ok(curatedMatchesLive('gemini-2.5-flash-image', { id: 'models/gemini-2.5-flash-image-preview' }));
  assert.ok(curatedMatchesLive('gpt-image-1', { id: 'gpt-image-1' }));
  assert.equal(curatedMatchesLive('ab', { id: 'ab-xl-turbo' }), false); // too short to match safely
  assert.equal(curatedMatchesLive('nano-banana', { id: 'gpt-image-1' }), false);
});

test('reconcile: confirms a curated model present in the live listing', () => {
  const current = [geminiModel({})];
  const live: LiveModel[] = [{ id: 'models/gemini-2.5-flash-image-preview', label: 'Nano Banana' }];
  const r = reconcile(current, live, 'google', 'gemini', NOW);
  assert.deepEqual(r.confirmed, ['nano-banana']);
  assert.equal(r.unconfirmed.length, 0);
  assert.equal(r.discovered.length, 0);
  assert.equal(r.checkedAt, '2026-07-17');
});

test('reconcile: surfaces a genuinely new model as a discovery candidate', () => {
  const current = [geminiModel({})];
  const live: LiveModel[] = [
    { id: 'gemini-2.5-flash-image' },
    { id: 'gemini-4-ultra-image', label: 'Gemini 4 Ultra Image' }, // new
  ];
  const r = reconcile(current, live, 'google', 'gemini', NOW);
  assert.deepEqual(r.confirmed, ['nano-banana']);
  assert.equal(r.discovered.length, 1);
  assert.equal(r.discovered[0].id, 'gemini-4-ultra-image');
});

test('reconcile: FLAGS a curated model missing from live — never silently retires it', () => {
  const current = [geminiModel({ id: 'ghost-model', providerModelId: 'gemini-ghost-9' })];
  const live: LiveModel[] = [{ id: 'gemini-2.5-flash-image' }];
  const r = reconcile(current, live, 'google', 'gemini', NOW);
  assert.deepEqual(r.unconfirmed, ['ghost-model']);
  assert.equal(r.confirmed.length, 0);
  // The ghost is NOT in discovered (it's ours, flagged), and the model object is untouched.
  assert.equal(current[0].id, 'ghost-model');
});

test('reconcile: only touches models under the given registry tag', () => {
  const current = [geminiModel({}), geminiModel({ id: 'gpt-image-1', provider: 'openai', providerModelId: 'gpt-image-1' })];
  const live: LiveModel[] = [{ id: 'gemini-2.5-flash-image' }];
  const r = reconcile(current, live, 'google', 'gemini', NOW);
  // openai model is out of scope — not confirmed, not unconfirmed.
  assert.deepEqual(r.confirmed, ['nano-banana']);
  assert.equal(r.unconfirmed.length, 0);
});

test('providersDue: only active providers WITH an endpoint AND a stale model', () => {
  const farFuture = Date.parse('2027-01-01T00:00:00Z'); // everything stale
  const due = providersDue(PROVIDERS, IMAGE_MODELS, farFuture);
  const ids = due.map((p) => p.id).sort();
  // google/openai/replicate/xai have endpoints + stale image models in the catalog.
  assert.ok(ids.includes('google'));
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('replicate'));
  // ideogram/recraft/fal have models but NO modelsEndpoint → never structurally due.
  assert.ok(!ids.includes('ideogram'));
  assert.ok(!ids.includes('recraft'));
  // anthropic has an endpoint but no image models in the catalog → not due.
  assert.ok(!ids.includes('anthropic'));
});

test('providersDue: nothing due when records are fresh', () => {
  // A "now" one hour after the catalog's refresh date → all fresh.
  const justAfter = Date.parse('2026-07-06T01:00:00Z');
  const due = providersDue(PROVIDERS, IMAGE_MODELS, justAfter);
  assert.equal(due.length, 0);
});

test('runRegistryRefresh: reconciles due providers via injected fetch, skips unreachable ones', async () => {
  const farFuture = Date.parse('2027-01-01T00:00:00Z');
  const fetchLive = async (p: { id: string }): Promise<LiveModel[] | null> => {
    if (p.id === 'google') return [{ id: 'gemini-3-pro-image' }, { id: 'gemini-9-new' }];
    return null; // openai unreachable this pass
  };
  const results = await runRegistryRefresh(IMAGE_MODELS, { now: farFuture, fetchLive });
  // Only google produced a diff (openai returned null → skipped, stays due next pass).
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'google');
  assert.ok(results[0].confirmed.includes('gemini-3-pro-image'));
  assert.ok(results[0].discovered.some((d) => d.id === 'gemini-9-new'));
});

test('runRegistryRefresh: a throwing fetch is swallowed (never breaks the pass)', async () => {
  const farFuture = Date.parse('2027-01-01T00:00:00Z');
  const fetchLive = async (): Promise<LiveModel[] | null> => {
    throw new Error('network down');
  };
  const results = await runRegistryRefresh(IMAGE_MODELS, { now: farFuture, fetchLive });
  assert.equal(results.length, 0);
});

test('normalizeModelList: parses each provider shape, ignores junk', () => {
  const google = normalizeModelList('google', { models: [{ name: 'models/gemini-x', displayName: 'Gemini X' }, { foo: 1 }] });
  assert.deepEqual(google, [{ id: 'gemini-x', label: 'Gemini X' }]);
  const openai = normalizeModelList('openai', { data: [{ id: 'gpt-image-1' }] });
  assert.deepEqual(openai, [{ id: 'gpt-image-1', label: undefined }]);
  const replicate = normalizeModelList('replicate', { results: [{ owner: 'black-forest-labs', name: 'flux-dev' }] });
  assert.deepEqual(replicate, [{ id: 'black-forest-labs/flux-dev', label: 'flux-dev' }]);
  assert.deepEqual(normalizeModelList('google', { nope: true }), []);
});

// Sanity: the roster↔registry bridge resolves Google's tag.
test('registryTag bridges google → gemini', () => {
  const google = PROVIDERS.find((p) => p.id === 'google')!;
  assert.equal(registryTag(google), 'gemini');
});
