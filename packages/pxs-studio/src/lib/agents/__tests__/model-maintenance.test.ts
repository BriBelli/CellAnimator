/**
 * Maintenance-agent tests — discovery research + evidence-based ghost retirement + reset. Injected
 * `research` (no network), in-memory repo. Run: `tsx --test src/lib/agents/__tests__/model-maintenance.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../../db/adapters/memory';
import type { Repository } from '../../db/repository';
import type { ModelRefreshRecord } from '../../db/models';
import {
  runMaintenance,
  toImageModel,
  slugId,
  parseResearch,
  obviouslyNotAnImageModel,
  type Discovery,
  type ResearchedModel,
} from '../model-maintenance';
import { getLiveCatalog } from '../live-catalog';

const NOW = Date.parse('2027-01-01T00:00:00Z');

async function seedRefresh(repo: Repository, provider: string, over: Partial<ModelRefreshRecord>): Promise<void> {
  await repo.put({
    id: `model_refresh:${provider}`,
    user_id: 'system',
    category: 'model_refresh',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    provider,
    checked_at: NOW,
    confirmed: [],
    discovered: [],
    unconfirmed: [],
    ...over,
  } as ModelRefreshRecord);
}

const research = async (d: Discovery): Promise<ResearchedModel | null> =>
  d.liveId === 'gemini-9-new'
    ? { label: 'Gemini 9', brief: 'A discovered flagship.', confidence: 'high', capabilities: ['photorealism'], costPerImageUsd: [0.05, 0.1] }
    : null;

test('slugId + toImageModel: builds a conservative record; low confidence stays out of routing', () => {
  assert.equal(slugId('black-forest-labs/FLUX.2-Pro'), 'black-forest-labs-flux.2-pro');
  const m = toImageModel({ label: 'X', brief: 'b', confidence: 'low' }, { provider: 'google', liveId: 'gemini-x' }, NOW)!;
  assert.equal(m.provider, 'gemini'); // roster google → registry tag
  assert.equal(m.providerModelId, 'gemini-x');
  assert.equal(m.preview, true);
  assert.equal(m.needsResearch, true);
  // Unknown provider → no card.
  assert.equal(toImageModel({ label: 'X', brief: 'b', confidence: 'high' }, { provider: 'nope', liveId: 'z' }, NOW), null);
});

test('discovery → researched card persisted and appears in the live catalog', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'google', { discovered: [{ id: 'gemini-9-new', label: 'Gemini 9' }] });
  const summary = await runMaintenance(repo, { now: NOW, research });
  assert.deepEqual(summary.researched, ['gemini-9-new']);

  const catalog = await getLiveCatalog(repo);
  const found = catalog.find((m) => m.id === 'gemini-9-new');
  assert.ok(found, 'discovered model should be routable in the live catalog');
  assert.ok(!found!.preview); // high confidence → not gated out of routing
  assert.equal(found!.needsResearch, false);
});

test('a research miss (null) persists no card', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'google', { discovered: [{ id: 'mystery-model' }] });
  const summary = await runMaintenance(repo, { now: NOW, research });
  assert.equal(summary.researched.length, 0);
  const catalog = await getLiveCatalog(repo);
  assert.equal(catalog.some((m) => m.id === 'mystery-model'), false);
});

test('ghost: retires only after repeated-miss evidence, then drops from the catalog', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'google', { unconfirmed: ['gemini-3-pro-image'] });

  const p1 = await runMaintenance(repo, { now: NOW, research });
  assert.deepEqual(p1.incremented, ['gemini-3-pro-image']);
  assert.equal(p1.retired.length, 0);
  const p2 = await runMaintenance(repo, { now: NOW + 1, research });
  assert.equal(p2.retired.length, 0);
  const p3 = await runMaintenance(repo, { now: NOW + 2, research });
  assert.deepEqual(p3.retired, ['gemini-3-pro-image']); // threshold 3 reached

  // A retired seed model is filtered from the live catalog (reversibly).
  const catalog = await getLiveCatalog(repo);
  assert.equal(catalog.some((m) => m.id === 'gemini-3-pro-image'), false);
});

test('ghost RESET: a retired model that reappears live is un-retired and returns to the catalog', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'google', { unconfirmed: ['gemini-3-pro-image'] });
  // Age it to retirement.
  await runMaintenance(repo, { now: NOW, research });
  await runMaintenance(repo, { now: NOW + 1, research });
  await runMaintenance(repo, { now: NOW + 2, research });
  assert.equal((await getLiveCatalog(repo)).some((m) => m.id === 'gemini-3-pro-image'), false);

  // Now the refresh confirms it again.
  await seedRefresh(repo, 'google', { confirmed: ['gemini-3-pro-image'], unconfirmed: [] });
  const reset = await runMaintenance(repo, { now: NOW + 3, research });
  assert.deepEqual(reset.reset, ['gemini-3-pro-image']);
  assert.ok((await getLiveCatalog(repo)).some((m) => m.id === 'gemini-3-pro-image'), 'model is back after reappearing');
});

test('parseResearch: tolerant JSON, defaults bad confidence to low, rejects junk', () => {
  const ok = parseResearch('here you go {"label":"A","brief":"b","confidence":"medium"} done');
  assert.equal(ok?.label, 'A');
  assert.equal(ok?.confidence, 'medium');
  const bad = parseResearch('{"label":"A","brief":"b","confidence":"wat"}');
  assert.equal(bad?.confidence, 'low');
  assert.equal(parseResearch('no json here'), null);
  assert.equal(parseResearch('{"brief":"missing label"}'), null);
});

// ── DISCOVERY GUARDRAILS ─────────────────────────────────────────────────────────────────────────
// Regressions here are expensive and silent. Observed live (2026-08-25) with these absent: a
// provider listing dumped 99 non-image models into the catalog — object detectors, text embeddings,
// moderation models — and an OpenAI realtime SPEECH model was carded as a tier-3 IMAGE model whose
// own researched brief said it wasn't one. Both then got re-researched on every pass, burning an
// hour of API calls on "how many reference images does YOLO accept".

test('a discovery the research says is NOT an image model is refused, not carded as one', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'openai', { discovered: [{ id: 'gpt-realtime-2025-08-28' }] });

  const summary = await runMaintenance(repo, {
    now: NOW,
    research: async () => ({
      isImageModel: false,
      label: 'GPT Realtime',
      brief: "OpenAI's realtime speech-to-speech model. Not an image or video generation model.",
      confidence: 'high',
    }),
  });

  assert.deepEqual(summary.researched, []);
  assert.deepEqual(summary.rejected, ['gpt-realtime-2025-08-28']);
  // And it must never appear in the catalog the router selects from.
  const catalog = await getLiveCatalog(repo);
  assert.equal(catalog.some((m) => m.id === 'gpt-realtime-2025-08-28'), false);
});

test('a deliberately PRUNED model found live again is not resurrected', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'google', { discovered: [{ id: 'gemini-2.5-flash-image' }] });

  let researchCalls = 0;
  const summary = await runMaintenance(repo, {
    now: NOW,
    research: async () => {
      researchCalls++;
      return { isImageModel: true, label: 'Gemini 2.5 Flash Image', brief: 'legacy', confidence: 'high' };
    },
  });

  assert.deepEqual(summary.rejected, ['gemini-2.5-flash-image']);
  assert.equal(researchCalls, 0, 'a pruned id is refused BEFORE paying to research it');
  const catalog = await getLiveCatalog(repo);
  assert.equal(catalog.some((m) => m.id === 'gemini-2.5-flash-image'), false);
});

test('discovery research is BOUNDED per pass — a 90-model listing cannot become 90 LLM calls', async () => {
  const repo = createMemoryRepository();
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `discovered-model-${i}` }));
  await seedRefresh(repo, 'openai', { discovered: many });

  let researchCalls = 0;
  const summary = await runMaintenance(repo, {
    now: NOW,
    maxResearchPerPass: 5,
    research: async () => {
      researchCalls++;
      return { isImageModel: true, label: 'X', brief: 'x', confidence: 'high' };
    },
  });

  assert.equal(researchCalls, 5);
  assert.equal(summary.researched.length, 5);
  assert.equal(summary.discoveriesSeen, 40); // the rest are SEEN and roll into the next pass
});

test('rejections are recorded so the same non-image model is never researched twice', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'openai', { discovered: [{ id: 'sonic-2-turbo' }] }); // ambiguous → costs research once
  let calls = 0;
  const deps = {
    now: NOW,
    research: async () => {
      calls++;
      return { isImageModel: false, label: 'Sonic 2', brief: 'A speech synthesis model.', confidence: 'high' as const };
    },
  };
  await runMaintenance(repo, deps);
  await runMaintenance(repo, { ...deps, now: NOW + 86_400_000 });
  assert.equal(calls, 1, 'the verdict is remembered, not re-purchased every pass');
});

test('obviouslyNotAnImageModel: rejects the junk for FREE, never a real image model', () => {
  // The exact ids that polluted the catalog on 2026-08-25.
  for (const id of [
    'text-embedding-3-large', 'text-embedding-ada-002', 'omni-moderation-latest',
    'ultralytics-yolo11n', 'ultralytics-yolo26-seg', 'gpt-realtime-2025-08-28',
    'whisper-large-v3', 'gpt-4o-mini-tts',
  ]) {
    assert.equal(obviouslyNotAnImageModel(id), true, `${id} should be rejected free`);
  }
  // And it must NEVER veto a real image model — the cost of a false positive is a missing model.
  for (const id of [
    'gpt-image-1.5', 'black-forest-labs/flux-2-pro', 'gemini-3-pro-image',
    'gemini-2.5-flash-image', 'grok-imagine-image-2.0', 'recraftv3', 'ideogram-v3',
    'stability-ai/sdxl', 'google/imagen-4', 'prunaai-z-image-turbo',
  ]) {
    assert.equal(obviouslyNotAnImageModel(id), false, `${id} must reach research`);
  }
});

test('the pre-filter spends NO research call on obvious junk', async () => {
  const repo = createMemoryRepository();
  await seedRefresh(repo, 'openai', {
    discovered: [{ id: 'text-embedding-3-large' }, { id: 'ultralytics-yolo26' }, { id: 'some-new-image-model' }],
  });
  let calls = 0;
  const summary = await runMaintenance(repo, {
    now: NOW,
    research: async () => {
      calls++;
      return { isImageModel: true, label: 'New', brief: 'a real one', confidence: 'high' as const };
    },
  });
  assert.equal(calls, 1, 'only the ambiguous id costs a research call');
  assert.equal(summary.rejected.length, 2);
  assert.deepEqual(summary.researched, ['some-new-image-model']);
});
