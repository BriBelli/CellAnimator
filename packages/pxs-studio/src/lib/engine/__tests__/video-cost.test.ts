/**
 * Video cost tests — the money gate. Video is ~50× an image per render and one 10s 1080p clip is
 * most of the default $5 cap, so "generate and find out" is not an acceptable interaction here.
 * Pure; no network, no spend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateVideoCost, checkAffordable, perSecondFor, costRanked } from '../video-cost';
import { MEDIA_MODELS } from '../media-registry';

const seedance = MEDIA_MODELS.find((m) => m.id === 'seedance-2')!;
const veo = MEDIA_MODELS.find((m) => m.id === 'veo-3.1')!;

test('a published per-resolution price is used EXACTLY, not interpolated', () => {
  const cheap = perSecondFor(seedance, '480p');
  assert.equal(cheap.usd, 0.07);
  assert.equal(cheap.exact, true);
  const dear = perSecondFor(seedance, '4k');
  assert.equal(dear.usd, 1.37);
  assert.equal(dear.exact, true);
});

test('the 20x spread inside ONE model is priced honestly', () => {
  const lo = estimateVideoCost(seedance, { durationSec: 10, resolution: '480p' });
  const hi = estimateVideoCost(seedance, { durationSec: 10, resolution: '4k' });
  assert.equal(lo.totalUsd, 0.7);
  assert.equal(hi.totalUsd, 13.7); // the render a single band would have hidden
  // And the real-world number that motivated all of this:
  assert.equal(estimateVideoCost(seedance, { durationSec: 10, resolution: '1080p' }).totalUsd, 3.4);
});

test('a model with only a band is estimated but LABELLED as such', () => {
  const e = estimateVideoCost(veo, { durationSec: 5, resolution: '1080p' });
  assert.equal(e.exact, false, 'never quoted as a fact');
  assert.ok(e.totalUsd > 0);
});

test('count multiplies — a fan of clips is priced as a fan', () => {
  const one = estimateVideoCost(seedance, { durationSec: 5, resolution: '720p', count: 1 });
  const four = estimateVideoCost(seedance, { durationSec: 5, resolution: '720p', count: 4 });
  assert.equal(four.totalUsd, one.totalUsd * 4);
});

test('affordable request passes with the price stated up front', () => {
  const v = checkAffordable(seedance, { durationSec: 4, resolution: '480p' }, 5);
  assert.equal(v.affordable, true);
  assert.match(v.message, /\$0\.28/);
});

test('over budget → REFUSES the request; it never substitutes something cheaper', () => {
  // $1 left, a 10s 1080p ask ($3.40).
  const v = checkAffordable(seedance, { durationSec: 10, resolution: '1080p' }, 1);
  assert.equal(v.affordable, false);
  // The estimate still describes what the USER asked for — never quietly rewritten to a cheaper spec.
  assert.equal(v.estimate.resolution, '1080p');
  assert.equal(v.estimate.durationSec, 10);
  assert.equal(v.shortfallUsd, 2.4); // exactly how much more is needed
  assert.match(v.message, /raise your cap/i);
});

test('what the budget WOULD cover is advisory — same quality, shorter', () => {
  const v = checkAffordable(seedance, { durationSec: 10, resolution: '1080p' }, 1);
  // Keeping the requested resolution and reporting the length that fits respects the ask: dropping
  // quality the user chose is a bigger override than telling them how much they can afford.
  assert.equal(v.wouldFit?.resolution, '1080p');
  assert.ok(v.wouldFit!.durationSec < 10);
  assert.ok(v.wouldFit!.totalUsd <= 1);
});

test('a budget that buys nothing says so plainly, and says what to do', () => {
  const v = checkAffordable(seedance, { durationSec: 10, resolution: '1080p' }, 0.02);
  assert.equal(v.affordable, false);
  assert.equal(v.wouldFit, undefined);
  assert.match(v.message, /Raise your cap/i);
  assert.ok(v.shortfallUsd > 3);
});

test('costRanked orders models by what THIS request costs on each', () => {
  const ranked = costRanked(MEDIA_MODELS, { durationSec: 5, resolution: '720p' });
  assert.ok(ranked.length >= 4);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i].totalUsd >= ranked[i - 1].totalUsd, 'cheapest first');
  }
});
