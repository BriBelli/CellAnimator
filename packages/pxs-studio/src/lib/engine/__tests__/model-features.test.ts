/**
 * Feature map tests — the translation guardrails (enum-locked vocabulary), the evidence hierarchy
 * (doctrine beats capability tags), and the honesty rule (unevidenced = unsupported, never routed).
 * Pure; no network. Run: `tsx --test src/lib/engine/__tests__/model-features.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatureMap, modelsForTask, documentedTasks, supportFor } from '../model-features';
import { normalizeTask, isImageTask, IMAGE_TASKS, TASK_DEFS } from '../task-vocabulary';
import type { ImageModel } from '../model-registry';
import type { ModelDoctrine } from '../../agents/model-agent/doctrine';

const model = (over: Partial<ImageModel> = {}): ImageModel =>
  ({
    id: 'm', label: 'M', provider: 'gemini', envKey: 'K', tier: 2,
    strengths: { photorealism: 3, prompt_adherence: 3, editing: 3, style_versatility: 3, text_rendering: 3, speed: 3, resolution: 3, consistency: 3, multimodal: 3 },
    capabilities: [], bestFor: [], supportsEditing: false, maxReferenceImages: 0,
    aspectRatios: ['1:1'], costPerImageUsd: [0.01, 0.02], maxBatchN: 1, batchStrategy: 'parallel',
    brief: '', sourceRefreshedAt: '2026-08-24', ...over,
  }) as ImageModel;

const doctrine = (patterns: ModelDoctrine['taskPatterns']): ModelDoctrine => ({
  modelId: 'm', principles: [], antiPatterns: [], taskPatterns: patterns,
  guide: '', confidence: 'high', sources: [],
});

test('vocabulary: provider marketing names translate onto our nouns, junk is rejected', () => {
  // The exact case that started this: a toy-register provider feature name.
  assert.equal(normalizeTask('Story-to-Comic Strip'), null); // not ours → dropped, never coined
  assert.equal(normalizeTask('storyboard'), 'storyboard-panels'); // alias → our noun
  assert.equal(normalizeTask('Character Reference Sheet'), 'character-sheet');
  assert.equal(normalizeTask('model_sheet'), 'character-sheet');
  assert.equal(normalizeTask('TEXT-TO-IMAGE'), 'text-to-image');
  assert.equal(normalizeTask('semantic masking'), 'inpaint-masked-edit');
  assert.equal(normalizeTask('something invented'), null);
  assert.ok(IMAGE_TASKS.every((t) => isImageTask(t) && TASK_DEFS[t].label.length > 0));
});

test('doctrine evidence wins over capability tags', () => {
  const m = model({ capabilities: ['multi_reference'] });
  // Capability tag alone → technique-grade.
  assert.equal(supportFor(m, 'character-consistency').support, 'technique');
  assert.equal(supportFor(m, 'character-consistency').evidence, 'capability');
  // Documented in its own guide → native, with the how.
  const d = doctrine([{ task: 'character-consistency', support: 'native', pattern: 'pass up to 5 character refs' }]);
  const e = supportFor(m, 'character-consistency', d);
  assert.equal(e.support, 'native');
  assert.equal(e.evidence, 'doctrine');
  assert.match(e.how, /5 character refs/);
});

test('unevidenced tasks are honestly unsupported (never silently routed)', () => {
  const m = model({ capabilities: ['photorealism'] });
  const map = buildFeatureMap(m);
  assert.equal(map['vector-illustration'].support, 'unsupported');
  assert.equal(map['storyboard-panels'].support, 'unsupported');
  assert.equal(map['text-in-image'].support, 'unsupported');
  // Every image model does text-to-image by definition.
  assert.equal(map['text-to-image'].support, 'native');
});

test('modelsForTask: excludes unsupported, ranks documented-native first', () => {
  const vectorPro = model({ id: 'vec', capabilities: ['vector'], tier: 3 });
  const generalist = model({ id: 'gen', capabilities: ['photorealism'], tier: 3 });
  const documented = model({ id: 'doc', capabilities: ['vector'], tier: 1 });
  const doctrines = new Map([
    ['doc', { ...doctrine([{ task: 'vector-illustration', support: 'native', pattern: 'ask for SVG output' }]), modelId: 'doc' }],
  ]);

  const candidates = modelsForTask([vectorPro, generalist, documented], 'vector-illustration', doctrines);
  // The generalist can't do vectors at all → excluded, even at tier 3.
  assert.deepEqual(candidates.map((c) => c.model.id), ['doc', 'vec']);
  // Documented-native (tier 1) outranks capability-implied (tier 3) — evidence beats prestige.
  assert.equal(candidates[0].entry.evidence, 'doctrine');
  assert.equal(candidates[1].entry.support, 'technique');
});

test('technique support is kept distinct from native (native-capability-FIRST)', () => {
  const m = model({ capabilities: ['editing'] });
  const d = doctrine([
    { task: 'storyboard-panels', support: 'technique', pattern: 'generate panels one at a time, feeding the prior panel back as a reference' },
    { task: 'inpaint-masked-edit', support: 'native', pattern: 'supply a mask with the edit call' },
  ]);
  const tasks = documentedTasks(m, d);
  assert.deepEqual(tasks.map((t) => t.task), ['inpaint-masked-edit', 'storyboard-panels']); // native first
  assert.equal(tasks[1].support, 'technique');
  assert.match(tasks[1].how, /prior panel back as a reference/); // the recipe is preserved for the agent
});

test('a task documented by NO model is answerable as such (no fake coverage)', () => {
  const roster = [model({ id: 'a' }), model({ id: 'b' })];
  assert.deepEqual(modelsForTask(roster, 'image-to-video'), []);
});

// ── REFERENCE LEGEND ─────────────────────────────────────────────────────────────────────────────
// Models with one flat pool (Gemini, FLUX, OpenAI, xAI) have no typed parameters — the only way to
// say what an image is FOR is in the prompt. FLUX documents index-addressing explicitly.
import { referenceLegend } from '../adapters/_util';

test('referenceLegend: names each image\'s job for flat-pool models', () => {
  const legend = referenceLegend(
    [
      { url: 'a', role: 'character' },
      { url: 'b', role: 'style' },
    ],
    undefined,
  );
  assert.match(legend, /Image 1: the character to keep consistent/);
  assert.match(legend, /Image 2: the style\/aesthetic to apply \(not the subject\)/);
});

test('referenceLegend: stays SILENT when it would add nothing', () => {
  // No references at all.
  assert.equal(referenceLegend(undefined, undefined), '');
  assert.equal(referenceLegend([], []), '');
  // Untagged references — the user said nothing, so we invent nothing and the prompt is untouched.
  assert.equal(referenceLegend(undefined, ['a.png', 'b.png']), '');
  assert.equal(referenceLegend([{ url: 'a', role: 'general' }], undefined), '');
});
