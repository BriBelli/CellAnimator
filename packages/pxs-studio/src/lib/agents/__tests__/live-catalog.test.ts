/**
 * Live-catalog compose tests — the seed + freshness + cards merge, pure. No repo/network.
 * Run: `tsx --test src/lib/agents/__tests__/live-catalog.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeCatalog } from '../live-catalog';
import { IMAGE_MODELS, type ImageModel } from '../../engine/model-registry';
import type { ModelCard, ModelRefreshRecord } from '../../db/models';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const emptyState = new Map<string, ModelRefreshRecord>();

function discoveredCard(model: ImageModel): ModelCard {
  return {
    id: `model_card:${model.id}`,
    user_id: 'system',
    category: 'model_card',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    model_id: model.id,
    provider: 'google',
    card: model,
    origin: 'discovered',
    confidence: 'high',
    researched_at: NOW,
  };
}

function retiredCard(modelId: string): ModelCard {
  return {
    id: `model_card:${modelId}`,
    user_id: 'system',
    category: 'model_card',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    model_id: modelId,
    provider: 'openai',
    card: null,
    origin: 'seed_override',
    confidence: 'medium',
    retired: true,
    miss_count: 3,
    researched_at: NOW,
  };
}

test('composeCatalog: seed passes through untouched with no cards', () => {
  const out = composeCatalog(IMAGE_MODELS, emptyState, new Map());
  assert.equal(out.length, IMAGE_MODELS.length);
});

test('composeCatalog: a discovered card is appended and routable', () => {
  const fake = { ...IMAGE_MODELS[0], id: 'gemini-9-new', label: 'Gemini 9' } as ImageModel;
  const cards = new Map([[fake.id, discoveredCard(fake)]]);
  const out = composeCatalog(IMAGE_MODELS, emptyState, cards);
  assert.ok(out.some((m) => m.id === 'gemini-9-new'));
  assert.equal(out.length, IMAGE_MODELS.length + 1);
});

test('composeCatalog: a retired seed model is filtered out (reversibly)', () => {
  const cards = new Map([['gemini-3-pro-image', retiredCard('gemini-3-pro-image')]]);
  const out = composeCatalog(IMAGE_MODELS, emptyState, cards);
  assert.equal(out.some((m) => m.id === 'gemini-3-pro-image'), false);
  assert.equal(out.length, IMAGE_MODELS.length - 1);
});

test('composeCatalog: a discovered card never duplicates an existing id', () => {
  const dup = { ...IMAGE_MODELS[0] } as ImageModel; // same id as a seed model
  const cards = new Map([[dup.id, discoveredCard(dup)]]);
  const out = composeCatalog(IMAGE_MODELS, emptyState, cards);
  assert.equal(out.filter((m) => m.id === dup.id).length, 1);
});
