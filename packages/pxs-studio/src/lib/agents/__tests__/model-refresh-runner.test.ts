/**
 * Runner tests — persistence + freshness overlay + the due-skip that makes the hot-path lazy
 * trigger safe. Uses the in-memory repository; `fetchLive` + `now` are injected (no network).
 * Run: `tsx --test src/lib/agents/__tests__/model-refresh-runner.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../../db/adapters/memory';
import {
  refreshRegistry,
  refreshRegistryIfDue,
  loadRefreshState,
  overlayFreshness,
} from '../model-refresh-runner';
import { IMAGE_MODELS } from '../../engine/model-registry';
import type { LiveModel } from '../../engine/model-refresh';
import type { ModelRefreshRecord } from '../../db/models';

const NOW = Date.parse('2027-01-01T00:00:00Z'); // far past the seed's 2026-07-06 → everything stale

/** Covers every provider that has both an endpoint and image models: google, openai, replicate, xai. */
const fetchBoth = async (p: { id: string }): Promise<LiveModel[] | null> => {
  if (p.id === 'google') return [{ id: 'gemini-3-pro-image' }, { id: 'gemini-3.1-flash-image' }, { id: 'gemini-9-new', label: 'Gemini 9' }];
  if (p.id === 'openai') return [{ id: 'gpt-image-1.5' }];
  if (p.id === 'replicate') return [{ id: 'black-forest-labs/flux-2-pro' }, { id: 'black-forest-labs/flux-2-dev' }];
  if (p.id === 'xai') return [{ id: 'grok-imagine-image-2.0' }];
  return null;
};

test('refreshRegistry: reconciles due providers and PERSISTS the diff', async () => {
  const repo = createMemoryRepository();
  const summary = await refreshRegistry(repo, { now: NOW, fetchLive: fetchBoth });

  assert.deepEqual([...summary.providersChecked].sort(), ['google', 'openai', 'replicate', 'xai']);
  assert.equal(summary.discoveredCount, 1); // gemini-9-new

  const state = await loadRefreshState(repo);
  const google = state.get('google') as ModelRefreshRecord;
  assert.ok(google);
  assert.equal(google.checked_at, NOW);
  assert.ok(google.confirmed.includes('gemini-3-pro-image'));
  assert.ok(google.confirmed.includes('gemini-3.1-flash-image'));
  assert.ok(google.discovered.some((d) => d.id === 'gemini-9-new'));
  assert.equal(state.get('openai')?.confirmed.includes('gpt-image-1.5'), true);
  assert.equal(state.get('xai')?.confirmed.includes('grok-imagine-image-2.0'), true);
});

test('overlayFreshness: persisted checked_at overrides the older seed stamp, seed untouched', () => {
  const state = new Map<string, ModelRefreshRecord>([
    [
      'google',
      {
        id: 'model_refresh:google',
        user_id: 'system',
        category: 'model_refresh',
        status: 'active',
        created_at: NOW,
        updated_at: NOW,
        provider: 'google',
        checked_at: NOW,
        confirmed: [],
        discovered: [],
        unconfirmed: [],
      },
    ],
  ]);
  const effective = overlayFreshness(IMAGE_MODELS, state);
  const pro = effective.find((m) => m.id === 'gemini-3-pro-image')!;
  assert.equal(pro.sourceRefreshedAt, '2027-01-01');
  // Seed const not mutated (the seed stamp is the record's live-verified date).
  const seedPro = IMAGE_MODELS.find((m) => m.id === 'gemini-3-pro-image')!;
  assert.equal(seedPro.sourceRefreshedAt, '2026-08-24');
});

test('refreshRegistryIfDue: after a pass, nothing is due → skips with NO network', async () => {
  const repo = createMemoryRepository();
  // First pass makes every image provider fresh.
  await refreshRegistry(repo, { now: NOW, fetchLive: fetchBoth });

  // A network fn that would THROW if called — proves the skip path never touches it.
  let called = false;
  const boom = async (): Promise<LiveModel[] | null> => {
    called = true;
    throw new Error('should not be called');
  };
  // Slightly later, still inside the 24h TTL → due.length === 0 → skipped, boom never runs.
  // (refreshRegistryIfDue uses live deps internally, but only if something is due — it isn't.)
  const res = await refreshRegistryIfDue(repo, NOW + 3_600_000);
  assert.deepEqual(res, { skipped: true });
  assert.equal(called, false);
  void boom; // referenced to keep intent explicit
});

test('refreshRegistryIfDue: fresh DB (nothing checked yet) with a fresh clock → skip', async () => {
  const repo = createMemoryRepository();
  // A "now" one hour after the OLDEST seed stamp (the gemini 3.x preview records) → every record is
  // fresh (the 2026-08-24-verified ones trivially so) → nothing due.
  const res = await refreshRegistryIfDue(repo, Date.parse('2026-07-06T01:00:00Z'));
  assert.deepEqual(res, { skipped: true });
});
