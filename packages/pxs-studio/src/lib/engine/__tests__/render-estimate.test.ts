/**
 * Pre-commit estimate tests — the number a user sees BEFORE spending. Pure; no network, no spend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRender, checkRenderBudget } from '../render-estimate';

test('IMAGE: a fan multiplies across models and count', () => {
  const e = estimateRender({ medium: 'image', modelIds: ['gpt-image-1.5', 'flux-2-pro'], perModel: 2 });
  assert.equal(e.lines.length, 2);
  assert.equal(e.lines[0].units, 2);
  assert.ok(e.highUsd > e.lowUsd, 'image models publish a band, so the estimate is a range');
  assert.match(e.summary, /4 images/);
});

test('VIDEO: priced on seconds x resolution, and the axes actually move the number', () => {
  const short = estimateRender({ medium: 'video', modelIds: ['seedance-2'], perModel: 1, durationSec: 4, resolution: '480p' });
  const long = estimateRender({ medium: 'video', modelIds: ['seedance-2'], perModel: 1, durationSec: 10, resolution: '1080p' });
  assert.equal(short.highUsd, 0.28);
  assert.equal(long.highUsd, 3.4);
  assert.match(long.summary, /10s · 1080p/);
});

test('the video/image gulf is visible — the reason one estimator must speak both', () => {
  const img = estimateRender({ medium: 'image', modelIds: ['gemini-3-pro-image'], perModel: 1 });
  const vid = estimateRender({ medium: 'video', modelIds: ['seedance-2'], perModel: 1, durationSec: 10, resolution: '1080p' });
  assert.ok(vid.highUsd > img.highUsd * 10, 'video is an order of magnitude dearer per render');
});

test('unknown model ids are skipped, never priced as zero', () => {
  const e = estimateRender({ medium: 'image', modelIds: ['nope', 'flux-2-pro'], perModel: 1 });
  assert.equal(e.lines.length, 1);
  assert.equal(e.lines[0].modelId, 'flux-2-pro');
});

test('an empty selection says so instead of showing $0.00', () => {
  const e = estimateRender({ medium: 'image', modelIds: [], perModel: 1 });
  assert.equal(e.summary, 'No models selected');
  assert.equal(e.highUsd, 0);
});

test('budget verdicts warn while there is still time to change something', () => {
  const plan = { medium: 'video' as const, modelIds: ['seedance-2'], perModel: 1, durationSec: 10, resolution: '1080p' };
  assert.equal(checkRenderBudget(plan, 50).verdict, 'ok'); // $3.40 of $50
  assert.equal(checkRenderBudget(plan, 5).verdict, 'tight'); // $3.40 of $5 — most of it
  assert.equal(checkRenderBudget(plan, 1).verdict, 'over');
});

test('over budget states the shortfall and what to change — it never picks for you', () => {
  const v = checkRenderBudget(
    { medium: 'video', modelIds: ['seedance-2'], perModel: 1, durationSec: 10, resolution: '1080p' },
    1,
  );
  assert.equal(v.verdict, 'over');
  assert.equal(v.shortfallUsd, 2.4);
  assert.match(v.message, /length or resolution/);
  assert.match(v.message, /raise your budget/i);
  // The estimate still describes what was ASKED for — never rewritten to something cheaper.
  assert.equal(v.estimate.lines[0].units, 1);
});

test('the image message offers image knobs, not video ones', () => {
  const v = checkRenderBudget({ medium: 'image', modelIds: ['gpt-image-1.5'], perModel: 8 }, 0.05);
  assert.equal(v.verdict, 'over');
  assert.doesNotMatch(v.message, /resolution/);
  assert.match(v.message, /models, count/);
});
