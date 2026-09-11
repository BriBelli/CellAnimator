/**
 * Video model agent tests — the layer that finally READS the video doctrine, and the routing that
 * decides which model serves a shot. Pure; no network, no spend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  videoFactsForModel,
  routeVideo,
  allVideoModels,
  DEFAULT_VIDEO_FORMULA,
} from '../video-model-agent';
import type { ModelDoctrine } from '../model-agent/doctrine';
import type { MediaModel } from '../../engine/media-registry';

const seedance = allVideoModels().find((m) => m.id === 'seedance-2')!;
const kling = allVideoModels().find((m) => m.id === 'kling-3')!;

/** Kling's REAL distilled formula — dialogue-shaped, from its own published guide. */
const klingDoctrine: ModelDoctrine = {
  modelId: 'kling-3',
  modality: 'video',
  formula: {
    parts: [
      { id: 'scene-setting', label: 'Scene & Setting', guidance: 'where', weight: 3 },
      { id: 'ambience', label: 'Ambience & Sound Effects', guidance: 'sound', weight: 2 },
      { id: 'character-action', label: 'Character Action', guidance: 'what they do', weight: 2 },
      { id: 'speaker', label: 'Speaker', guidance: 'who talks', weight: 2 },
      { id: 'dialogue', label: 'Dialogue Line', guidance: 'the line', weight: 2 },
    ],
    assembly: 'Scene first, then sound, then the line.',
  },
  principles: ['name the speaker before the line'],
  antiPatterns: ['do not describe cuts'],
  taskPatterns: [
    { task: 'lipsync-dialogue', support: 'native', pattern: 'name the speaker, then the line' },
    { task: 'multi-shot-sequence', support: 'native', pattern: 'one prompt per shot' },
  ],
  guide: '',
  confidence: 'high',
  sources: [{ url: 'https://kling.ai/guide', kind: 'prompting_guide' }],
};

test('THE POINT OF STAGE 2: a doctrine formula reaches the facts, replacing the generic five', () => {
  const without = videoFactsForModel(kling);
  assert.equal(without.formulaSource, 'registry'); // the registry's shared VIDEO_FORMULA
  assert.deepEqual(without.formula.parts.map((p) => p.id), ['scene', 'subject', 'camera', 'motion', 'style']);

  const withDoctrine = videoFactsForModel(kling, klingDoctrine);
  assert.equal(withDoctrine.formulaSource, 'doctrine');
  // Kling's OWN shape — dialogue-led, which no generic formula would ever produce.
  assert.deepEqual(withDoctrine.formula.parts.map((p) => p.label), [
    'Scene & Setting',
    'Ambience & Sound Effects',
    'Character Action',
    'Speaker',
    'Dialogue Line',
  ]);
  assert.equal(withDoctrine.doctrine?.confidence, 'high');
  assert.deepEqual(withDoctrine.features, ['lipsync-dialogue', 'multi-shot-sequence']);
});

test('facts report the real limits and the provider id, not guesses', () => {
  const f = videoFactsForModel(seedance);
  assert.equal(f.maxDurationSec, 15);
  assert.equal(f.nativeAudio, true);
  assert.equal(f.maxReferenceImages, 9);
  assert.equal(f.providerModelId, 'bytedance/seedance-2.0/text-to-video');
  assert.ok(f.resolutions.includes('4K') || f.resolutions.includes('4k'));
});

test('no doctrine and no registry formula → the generic default, labelled as such', () => {
  const bare = { ...seedance, video: { ...seedance.video!, promptFormula: undefined } } as MediaModel;
  const f = videoFactsForModel(bare);
  assert.equal(f.formulaSource, 'default');
  assert.deepEqual(f.formula, DEFAULT_VIDEO_FORMULA);
});

test('routing GATES on capability — a silent audio model cannot serve a dialogue shot', () => {
  const silent = { ...seedance, id: 'silent', label: 'Silent', preview: false, needsResearch: false, video: { ...seedance.video!, nativeAudio: false } } as MediaModel;
  const { candidates, dropped } = routeVideo({ intent: 'two people talking', needsAudio: true }, [silent], undefined, () => true);
  assert.equal(candidates.length, 0);
  assert.match(dropped[0].reason, /synced audio/);
});

test('every exclusion is REPORTED — no model vanishes without a reason', () => {
  const runnable = { ...seedance, preview: false, needsResearch: false } as MediaModel;
  const { dropped } = routeVideo({ intent: 'a 30 second shot', durationSec: 30 }, [runnable], undefined, () => true);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /up to 15s; you asked for 30s/);
});

test('budget is a gate, and the reason names the actual numbers', () => {
  const runnable = { ...seedance, preview: false, needsResearch: false } as MediaModel;
  const { candidates, dropped } = routeVideo(
    { intent: 'a shot', durationSec: 10, resolution: '1080p', budgetUsd: 1 },
    [runnable],
    undefined,
    () => true,
  );
  assert.equal(candidates.length, 0);
  assert.match(dropped[0].reason, /\$3\.40 — over the \$1\.00 left/);
});

test('knowledge-only models are never routed to', () => {
  // Every seeded video model is still needsResearch — so nothing is spendable until vetted.
  const { candidates, dropped } = routeVideo({ intent: 'a shot' }, allVideoModels());
  assert.equal(candidates.length, 0);
  assert.ok(dropped.every((d) => /not yet researched|adapter or API key/.test(d.reason)));
});

test('an explicit user pick is honoured over ranking', () => {
  const a = { ...seedance, id: 'a', label: 'A', preview: false, needsResearch: false } as MediaModel;
  const b = { ...kling, id: 'b', label: 'B', preview: false, needsResearch: false } as MediaModel;
  const { candidates } = routeVideo({ intent: 'shot', models: ['b'], fanModels: 2 }, [a, b], undefined, () => true);
  assert.deepEqual(candidates.map((c) => c.model.id), ['b']);
});

test('fit rewards documented capability, not tier', () => {
  const runnable = { ...kling, preview: false, needsResearch: false } as MediaModel;
  const doctrines = new Map([['kling-3', klingDoctrine]]);
  const withTask = routeVideo({ intent: 'x', task: 'lipsync-dialogue', needsAudio: true }, [runnable], doctrines, () => true);
  const withoutTask = routeVideo({ intent: 'x' }, [runnable], doctrines, () => true);
  assert.ok(withTask.candidates[0].fit > withoutTask.candidates[0].fit);
  assert.match(withTask.candidates[0].why, /documented for lipsync-dialogue/);
});
