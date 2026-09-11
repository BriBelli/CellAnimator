/**
 * Prompt scoring tests — the honesty contract. Structure measures SUBSTANCE and is capped;
 * craft reconciliation refuses to report a high score alongside real findings.
 * Run: `tsx --test src/lib/__tests__/prompt-score.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreBuilder, scorePart, bandOf, bandLabel, STRUCTURE_CAP } from '../prompt-score';
import { reconcile } from '../agents/model-agent/craft-critique';

test('THE OLD LIE: ten filler words no longer scores 100', () => {
  // Previously `min(1, words/10)` → "the the the …" scored a part at 100%.
  const filler = scorePart('the the the the the the the the the the', []);
  assert.equal(filler.raw, 0);
  assert.equal(filler.band, 'thin');
  assert.match(filler.reason!, /filler/i);

  // Praise-words are filler too — they direct nothing.
  const praise = scorePart('very beautiful amazing stunning high quality detailed realistic', []);
  assert.ok(praise.raw < 0.4, `praise-soup should read thin, got ${praise.raw}`);
});

test('substance beats length: six concrete words outscore twenty vague ones', () => {
  const concrete = scorePart('brushed copper kettle, condensation beading, worn oak counter', []);
  const vague = scorePart('a really very nice and good image of a thing that is quite great and cool to see', []);
  assert.equal(concrete.band, 'strong');
  assert.ok(concrete.raw > vague.raw);
});

test('repetition is deduped — padding cannot inflate a part', () => {
  const once = scorePart('copper kettle steam', []);
  const padded = scorePart('copper kettle steam copper kettle steam copper kettle steam', []);
  assert.equal(once.raw, padded.raw);
});

test('structure is CAPPED — completeness alone can never read as excellent', () => {
  const perfect = scoreBuilder([
    { id: 'subject', weight: 3, value: 'brushed copper kettle, condensation, worn oak counter', anchors: [] },
    { id: 'style', weight: 2, value: 'kodak portra, golden hour, shallow depth, warm grade', anchors: [] },
  ]);
  assert.equal(perfect.overall, STRUCTURE_CAP);
  assert.ok(perfect.overall <= 70, 'structure must never approach 100');
  assert.equal(bandLabel(perfect.overallBand), 'Complete'); // "complete", not "excellent"
});

test('empty parts are explained, not just banded', () => {
  const s = scoreBuilder([{ id: 'action', weight: 1, value: '', anchors: [] }]);
  assert.equal(s.overall, 0);
  assert.match(s.parts[0].reason!, /not reaching the model/i);
});

test('weighting still favors the parts this model cares about', () => {
  const heavy = scoreBuilder([
    { id: 'subject', weight: 3, value: 'brushed copper kettle, condensation, oak', anchors: [] },
    { id: 'action', weight: 1, value: '', anchors: [] },
  ]);
  const light = scoreBuilder([
    { id: 'subject', weight: 3, value: '', anchors: [] },
    { id: 'action', weight: 1, value: 'brushed copper kettle, condensation, oak', anchors: [] },
  ]);
  assert.ok(heavy.overall > light.overall);
});

test('bandOf boundaries hold', () => {
  assert.equal(bandOf(0.39), 'thin');
  assert.equal(bandOf(0.4), 'good');
  assert.equal(bandOf(0.78), 'strong');
});

test('craft reconcile: a high score cannot stand beside blocking findings', () => {
  const blocking = (n: number) =>
    Array.from({ length: n }, () => ({ partId: '', severity: 'blocking' as const, issue: 'i', fix: 'f', groundedIn: 'g' }));
  assert.equal(reconcile(94, blocking(1)), 74); // one blocking → not "solid"
  assert.equal(reconcile(94, blocking(2)), 59); // two → not even workable
  assert.equal(reconcile(94, []), 94); // clean prompt keeps its score
  // Three weak findings cap below "hard to improve".
  const weak = Array.from({ length: 3 }, () => ({ partId: '', severity: 'weak' as const, issue: 'i', fix: 'f', groundedIn: 'g' }));
  assert.equal(reconcile(95, weak), 79);
  assert.equal(reconcile(150, []), 100); // clamped
  assert.equal(reconcile(-5, []), 0);
});
