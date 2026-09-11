/**
 * Doctrine refresh tests — the change gate (hash), due-selection, persistence, and the honesty
 * rules (no docs → no doctrine; weak doctrine → retried). Injected fetch + distill, no network.
 * Run: `tsx --test src/lib/agents/__tests__/doctrine-refresh.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../../db/adapters/memory';
import { refreshDoctrineIfDue, refreshDoctrine, loadDoctrines, getDoctrine } from '../doctrine-refresh';
import type { ModelDoctrine, FetchedDoc } from '../model-agent/doctrine';
import type { ImageModel, ModelDoc } from '../../engine/model-registry';

const NOW = Date.parse('2026-08-24T12:00:00Z');
const DAY = 24 * 3_600_000;

const DOCS: ModelDoc[] = [
  { kind: 'prompting_guide', url: 'https://docs.example/prompting', verifiedAt: '2026-08-24' },
];

const model = (over: Partial<ImageModel> = {}): ImageModel =>
  ({
    id: 'test-model',
    label: 'Test Model',
    provider: 'gemini',
    envKey: 'GEMINI_API_KEY',
    tier: 3,
    strengths: { photorealism: 4, prompt_adherence: 4, editing: 4, style_versatility: 4, text_rendering: 4, speed: 4, resolution: 4, consistency: 4, multimodal: 4 },
    capabilities: ['photorealism'],
    bestFor: ['testing'],
    supportsEditing: true,
    maxReferenceImages: 3,
    aspectRatios: ['1:1'],
    costPerImageUsd: [0.01, 0.02],
    maxBatchN: 1,
    batchStrategy: 'parallel',
    brief: 'test',
    sourceRefreshedAt: '2026-08-24',
    docs: DOCS,
    ...over,
  }) as ImageModel;

const fetched = (content: string): FetchedDoc[] => [{ doc: DOCS[0], content }];

const doctrine = (over: Partial<ModelDoctrine> = {}): ModelDoctrine => ({
  modelId: 'test-model',
  principles: ['be specific'],
  antiPatterns: ['no negatives'],
  taskPatterns: [{ task: 'character-sheet', support: 'native', pattern: 'grid of poses' }],
  guide: '# Guide',
  confidence: 'high',
  sources: [{ url: DOCS[0].url, kind: 'prompting_guide' }],
  ...over,
});

test('first run: distills and persists; getDoctrine round-trips', async () => {
  const repo = createMemoryRepository();
  let distillCalls = 0;
  const res = await refreshDoctrineIfDue([model()], repo, {
    now: NOW,
    fetchDocs: async () => fetched('guide text v1 with plenty of real content'),
    distill: async () => (distillCalls++, doctrine()),
  });
  assert.deepEqual(res, [{ modelId: 'test-model', outcome: 'distilled', confidence: 'high' }]);
  assert.equal(distillCalls, 1);
  const d = await getDoctrine(repo, 'test-model');
  assert.equal(d?.taskPatterns[0].task, 'character-sheet');
});

test('unchanged docs: restamps freshness with ZERO distillation (the hash gate)', async () => {
  const repo = createMemoryRepository();
  let distillCalls = 0;
  const deps = {
    fetchDocs: async () => fetched('same guide text, never edited'),
    distill: async () => (distillCalls++, doctrine()),
  };
  await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW });
  // A day later — due again, but the corpus hash matches → restamp only.
  const res = await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW + DAY + 1 });
  assert.deepEqual(res, [{ modelId: 'test-model', outcome: 'unchanged', confidence: 'high' }]);
  assert.equal(distillCalls, 1); // still just the first pass
  const recs = await loadDoctrines(repo);
  assert.equal(recs.get('test-model')?.distilled_at, NOW + DAY + 1); // freshness restamped
});

test('changed docs: re-distills', async () => {
  const repo = createMemoryRepository();
  let content = 'guide v1';
  let distillCalls = 0;
  const deps = {
    fetchDocs: async () => fetched(content + ' — long enough to pass the stub filter, definitely real content here'),
    distill: async () => (distillCalls++, doctrine()),
  };
  await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW });
  content = 'guide v2 — the provider edited their docs';
  const res = await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW + DAY + 1 });
  assert.equal(res[0].outcome, 'distilled');
  assert.equal(distillCalls, 2);
});

test('inside the TTL: not due, nothing runs', async () => {
  const repo = createMemoryRepository();
  let fetchCalls = 0;
  const deps = {
    fetchDocs: async () => (fetchCalls++, fetched('content long enough to be a real document for sure')),
    distill: async () => doctrine(),
  };
  await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW });
  const res = await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW + DAY / 2 });
  assert.deepEqual(res, []);
  assert.equal(fetchCalls, 1); // second pass never even fetched
});

test('low-confidence doctrine is retried on the next due pass (never trusted as done)', async () => {
  const repo = createMemoryRepository();
  let confidence: 'low' | 'high' = 'low';
  let distillCalls = 0;
  const deps = {
    fetchDocs: async () => fetched('thin doc content but long enough to pass the minimum stub filter'),
    distill: async () => (distillCalls++, doctrine({ confidence })),
  };
  await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW });
  confidence = 'high';
  // Immediately due again (low confidence bypasses the TTL) even though docs are unchanged.
  const res = await refreshDoctrineIfDue([model()], repo, { ...deps, now: NOW + 1 });
  assert.equal(res[0].outcome, 'distilled');
  assert.equal(res[0].confidence, 'high');
  assert.equal(distillCalls, 2);
});

test('no pinned docs / no fetchable content → honest outcomes, nothing persisted', async () => {
  const repo = createMemoryRepository();
  const noDocs = model({ id: 'no-docs', docs: [] });
  const resA = await refreshDoctrineIfDue([noDocs], repo, {
    now: NOW,
    fetchDocs: async () => [],
    distill: async () => doctrine(),
  });
  assert.deepEqual(resA, []); // filtered before fetch — no docs pinned
  const resB = await refreshDoctrineIfDue([model()], repo, {
    now: NOW,
    fetchDocs: async () => [], // pinned but unfetchable
    distill: async () => doctrine(),
  });
  assert.deepEqual(resB, [{ modelId: 'test-model', outcome: 'no_docs' }]);
  assert.equal((await loadDoctrines(repo)).size, 0);
});

test('maxPerPass staggers; full refreshDoctrine covers everything', async () => {
  const repo = createMemoryRepository();
  const models = ['a', 'b', 'c'].map((id) => model({ id }));
  const deps = {
    fetchDocs: async () => fetched('shared guide content long enough to pass the stub filter easily'),
    distill: async (m: ImageModel) => doctrine({ modelId: m.id }),
  };
  const gated = await refreshDoctrineIfDue(models, repo, { ...deps, now: NOW, maxPerPass: 2 });
  assert.equal(gated.length, 2);
  const full = await refreshDoctrine(models, repo, { ...deps, now: NOW + 1 });
  assert.equal(full.length, 3); // ungated: the 2 restamp/redo + the straggler
  assert.equal((await loadDoctrines(repo)).size, 3);
});

// ── Truncation salvage: the richest guides overflow any token budget, and losing a whole
//    distillation to a cut-off array is expensive. Verified against the real failure shape.
import { __testing } from '../model-agent/doctrine';

test('parseLoose: a TRUNCATED response is salvaged, not thrown away', () => {
  // Exactly what killed the first live run: valid JSON cut mid-array by the token limit.
  const truncated = '{"principles":["be specific","use positive framing"],"taskPatterns":[{"task":"style-transfer","support":"native","pattern":"pass a style ref"},{"task":"scene-comp';
  const parsed = __testing.parseLoose(truncated);
  assert.ok(parsed, 'salvaged');
  assert.deepEqual(parsed!.principles, ['be specific', 'use positive framing']);
  assert.equal((parsed!.taskPatterns as unknown[]).length, 1); // the complete element survives
});

test('parseLoose: intact JSON parses normally, junk returns null', () => {
  assert.deepEqual(__testing.parseLoose('prose {"a":1} more'), { a: 1 });
  assert.equal(__testing.parseLoose('no json here'), null);
  assert.equal(__testing.parseLoose(''), null);
});

test('parseLoose: braces inside strings never confuse the repair', () => {
  const s = '{"guide":"use {curly} braces \\"quoted\\" here","principles":["a"],"x":[1,';
  const parsed = __testing.parseLoose(s);
  assert.ok(parsed);
  assert.match(parsed!.guide as string, /curly/);
  assert.deepEqual(parsed!.principles, ['a']);
});
