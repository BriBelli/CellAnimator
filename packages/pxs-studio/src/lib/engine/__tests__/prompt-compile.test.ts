/**
 * Compile + rollup tests — the "one brief, N lenses" contract: a lens is a VIEW of one document,
 * divergence is opt-in and per-part, and N critiques separate universal problems from model-specific
 * ones. Pure; no network. Run: `tsx --test src/lib/engine/__tests__/prompt-compile.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFor, compileFan, formulaFor } from '../prompt-compile';
import { getModel } from '../model-registry';
import { rollupCritiques } from '../../agents/model-agent/craft-rollup';
import type { CraftResult } from '../../agents/model-agent/craft-critique';

const gemini = getModel('gemini-3-pro-image')!;
const xai = getModel('grok-imagine-image-2.0')!;
const flux = getModel('flux-2-pro')!;

const BRIEF = {
  subject: 'brushed copper kettle, condensation beading',
  action: 'steaming gently',
  location: 'worn oak counter',
  composition: 'low three-quarter, 85mm',
  style: 'golden hour, warm grade',
};

test('a lens is a VIEW: the same brief compiles into each model\'s real formula', () => {
  const lenses = compileFan([gemini, xai], gemini.id, BRIEF);
  assert.equal(lenses.length, 2);
  // Lead is untouched — it IS the brief.
  assert.equal(lenses[0].modelId, gemini.id);
  assert.equal(lenses[0].identical, true);
  assert.deepEqual(lenses[0].parts.map((p) => p.id), ['subject', 'action', 'location', 'composition', 'style']);
  // xAI gets ITS six parts, populated by meaning — nothing retyped by the user.
  const x = lenses[1];
  assert.equal(x.identical, false);
  assert.deepEqual(x.parts.map((p) => p.id), ['subject', 'action', 'setting', 'camera', 'lighting', 'mood']);
  assert.equal(x.parts.find((p) => p.id === 'setting')!.value, 'worn oak counter'); // location → setting
  assert.equal(x.parts.find((p) => p.id === 'camera')!.value, 'low three-quarter, 85mm');
  assert.match(x.parts.find((p) => p.id === 'mood')!.value, /golden hour/); // style folds in, not lost
  assert.ok(x.notes.length > 0); // and the fold is explained
});

test('every lens produces a real assembled prompt (nothing silently empty)', () => {
  for (const lens of compileFan([gemini, xai, flux], gemini.id, BRIEF)) {
    assert.ok(lens.assembled.length > 20, `${lens.modelId} assembled`);
    assert.match(lens.assembled, /copper kettle/);
  }
});

test('divergence is per-PART: overriding one field keeps the rest in sync with the brief', () => {
  const lens = compileFor(xai, formulaFor(gemini), BRIEF, { override: { mood: 'stark, clinical' } });
  assert.equal(lens.diverged, true);
  assert.equal(lens.parts.find((p) => p.id === 'mood')!.value, 'stark, clinical'); // overridden
  assert.equal(lens.parts.find((p) => p.id === 'subject')!.value, BRIEF.subject); // still the brief
  // Reverting = dropping the override; nothing else to undo.
  const reverted = compileFor(xai, formulaFor(gemini), BRIEF, {});
  assert.equal(reverted.diverged, false);
  assert.match(reverted.parts.find((p) => p.id === 'mood')!.value, /golden hour/);
});

test('editing the brief flows to every non-diverged lens', () => {
  const edited = { ...BRIEF, location: 'a rain-slick Tokyo alley' };
  const lenses = compileFan([gemini, xai], gemini.id, edited);
  assert.equal(lenses[1].parts.find((p) => p.id === 'setting')!.value, 'a rain-slick Tokyo alley');
});

test('a single-model fan needs no lens machinery', () => {
  const lenses = compileFan([gemini], gemini.id, BRIEF);
  assert.equal(lenses.length, 1);
  assert.equal(lenses[0].identical, true);
});

const critique = (id: string, label: string, score: number, findings: { partId: string; issue: string; fix: string; severity?: 'blocking' | 'weak' | 'polish' }[]): CraftResult => ({
  available: true, modelId: id, modelLabel: label, score, verdict: '', strengths: [],
  sources: [], doctrineConfidence: 'high',
  findings: findings.map((f) => ({ partId: f.partId, severity: f.severity ?? 'weak', issue: f.issue, fix: f.fix, groundedIn: 'g' })),
});

test('rollup separates UNIVERSAL problems from one model\'s compile detail', () => {
  const results: CraftResult[] = [
    critique('a', 'Model A', 70, [
      { partId: 'location', issue: 'the location is vague', fix: 'name the surface and light source' },
      { partId: '', issue: 'over the word budget', fix: 'cut to 160 words' },
    ]),
    critique('b', 'Model B', 65, [{ partId: 'location', issue: 'the location lacks specifics', fix: 'name the surface' }]),
    critique('c', 'Model C', 80, [{ partId: 'location', issue: 'the location is vague here', fix: 'add the surface' }]),
  ];
  const r = rollupCritiques(results);
  assert.equal(r.judged.length, 3);
  assert.equal(r.averageScore, 72);
  // All three flagged Location → universal, fix once.
  assert.equal(r.universal.length, 1);
  assert.equal(r.universal[0].partId, 'location');
  assert.equal(r.universal[0].modelIds.length, 3);
  assert.equal(r.universal[0].fix, 'name the surface and light source'); // most actionable phrasing kept
  // The word budget is one model's concern only.
  assert.equal(r.specific.length, 1);
  assert.deepEqual(r.specific[0].modelIds, ['a']);
});

test('rollup names models it could NOT judge instead of hiding them', () => {
  const r = rollupCritiques([
    critique('a', 'Model A', 70, []),
    { available: false, reason: 'no_doctrine', modelId: 'b', modelLabel: 'Model B' },
  ]);
  assert.equal(r.judged.length, 1);
  assert.deepEqual(r.unavailable, [{ modelId: 'b', modelLabel: 'Model B', reason: 'no_doctrine' }]);
});

test('rollup groups a model\'s OWN part vocabulary back onto the brief\'s', () => {
  const results: CraftResult[] = [
    critique('a', 'Model A', 70, [{ partId: 'location', issue: 'the location is vague', fix: 'name it' }]),
    critique('b', 'Model B', 70, [{ partId: 'setting', issue: 'the location is vague', fix: 'name it' }]),
  ];
  // Without the alias map these read as two separate problems; with it, one universal finding.
  const r = rollupCritiques(results, { setting: 'location' });
  assert.equal(r.universal.length, 1);
  assert.equal(r.universal[0].modelIds.length, 2);
});

test('severity: the most severe reading across models wins', () => {
  const r = rollupCritiques([
    critique('a', 'A', 70, [{ partId: 'style', issue: 'negative phrasing used', fix: 'say what IS there', severity: 'weak' }]),
    critique('b', 'B', 40, [{ partId: 'style', issue: 'negative phrasing used', fix: 'say what IS there', severity: 'blocking' }]),
  ]);
  assert.equal(r.universal[0].severity, 'blocking');
});
