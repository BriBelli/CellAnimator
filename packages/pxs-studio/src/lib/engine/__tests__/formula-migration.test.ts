/**
 * Formula migration tests — the "never a cage" contract: a change of model (or a doctrine refresh
 * that re-shapes a formula) must never eat what the user wrote. Pure; no network.
 * Run: `tsx --test src/lib/engine/__tests__/formula-migration.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateFormulaValues, sameShape } from '../formula-migration';
import { getModel, DEFAULT_IMAGE_FORMULA } from '../model-registry';
import type { PromptFormula } from '../model-registry';

const gemini = getModel('gemini-3-pro-image')!.promptFormula!;
const xai = getModel('grok-imagine-image-2.0')!.promptFormula!;

test('the seeded formulas are genuinely DIFFERENT shapes (not five clones)', () => {
  assert.deepEqual(gemini.parts.map((p) => p.id), ['subject', 'action', 'location', 'composition', 'style']);
  assert.deepEqual(xai.parts.map((p) => p.id), ['subject', 'action', 'setting', 'camera', 'lighting', 'mood']);
  assert.equal(sameShape(gemini, xai), false);
  assert.equal(sameShape(gemini, gemini), true);
  // And neither is the generic default any more.
  assert.equal(sameShape(gemini, DEFAULT_IMAGE_FORMULA), false);
});

test('same meaning, different vocabulary: context → location → setting', () => {
  const fromGeneric = migrateFormulaValues(
    [{ id: 'context', label: 'Context', value: 'a rain-slick Tokyo alley' }],
    gemini,
  );
  assert.equal(fromGeneric.values.location, 'a rain-slick Tokyo alley');
  assert.equal(fromGeneric.unmapped.length, 0);

  const geminiToXai = migrateFormulaValues(
    [{ id: 'location', label: 'Location', value: 'a rain-slick Tokyo alley' }],
    xai,
  );
  assert.equal(geminiToXai.values.setting, 'a rain-slick Tokyo alley');
});

test('narrowing: xAI 6 parts → Gemini 5 folds lighting/mood into Style, nothing lost', () => {
  const r = migrateFormulaValues(
    [
      { id: 'subject', label: 'Subject', value: 'a lone astronaut' },
      { id: 'camera', label: 'Camera', value: '85mm portrait lens' },
      { id: 'lighting', label: 'Lighting', value: 'harsh rim light' },
      { id: 'mood', label: 'Mood', value: 'lonely, reverent' },
    ],
    gemini,
  );
  assert.equal(r.values.subject, 'a lone astronaut');
  assert.equal(r.values.composition, '85mm portrait lens'); // camera → composition
  // Both lighting and mood fold into style, MERGED (not overwritten).
  assert.match(r.values.style, /harsh rim light/);
  assert.match(r.values.style, /lonely, reverent/);
  assert.equal(r.unmapped.length, 0);
  assert.ok(r.notes.some((n) => /folds Lighting into Style/i.test(n)));
});

test('widening: Gemini 5 → xAI 6 keeps every value addressable', () => {
  const r = migrateFormulaValues(
    [
      { id: 'subject', label: 'Subject', value: 'a red coupe' },
      { id: 'composition', label: 'Composition', value: 'low three-quarter angle' },
      { id: 'style', label: 'Style', value: 'kodak portra, golden hour' },
    ],
    xai,
  );
  assert.equal(r.values.subject, 'a red coupe');
  assert.equal(r.values.camera, 'low three-quarter angle');
  // xAI has no Style part (it teaches Lighting + Mood) — the look description still REACHES the
  // render by merging, with a note, rather than being excluded until the user notices.
  assert.equal(r.values.mood, 'kodak portra, golden hour');
  assert.equal(r.unmapped.length, 0);
  assert.ok(r.notes.some((n) => /folds Style into Mood/i.test(n)));
});

test('a value with nowhere to go is REPORTED, never silently dropped', () => {
  const narrow: PromptFormula = { parts: [{ id: 'subject', label: 'Subject', guidance: '', weight: 3 }] };
  const r = migrateFormulaValues(
    [
      { id: 'subject', label: 'Subject', value: 'a cat' },
      { id: 'action', label: 'Action', value: 'leaping' },
    ],
    narrow,
  );
  assert.equal(r.values.subject, 'a cat');
  assert.equal(r.unmapped.length, 1);
  assert.equal(r.unmapped[0].value, 'leaping'); // the text survives for the user to re-place
  assert.ok(r.notes.some((n) => /no equivalent for: Action/.test(n)));
});

test('empty values are ignored; nothing is invented', () => {
  const r = migrateFormulaValues([{ id: 'subject', label: 'Subject', value: '   ' }], gemini);
  assert.deepEqual(r.values, {});
  assert.deepEqual(r.unmapped, []);
  assert.deepEqual(r.notes, []);
});
