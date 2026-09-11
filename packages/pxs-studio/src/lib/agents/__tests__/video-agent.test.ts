/**
 * Video agent tests — the planning turn. The Anthropic client is injected, so these run with no
 * network and no spend. What they protect: the model's OWN formula reaching the builder, and the
 * agent never promising something the model cannot do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVideoAgent, buildVideoParts, type VideoAgentEvent, type VideoBuilderBlock } from '../video-agent';
import { videoFactsForModel, allVideoModels } from '../video-model-agent';
import type { ModelDoctrine } from '../model-agent/doctrine';

const kling = allVideoModels().find((m) => m.id === 'kling-3')!;

/** Kling's REAL distilled formula — dialogue-shaped, from its own guide. */
const klingDoctrine: ModelDoctrine = {
  modelId: 'kling-3',
  modality: 'video',
  formula: {
    parts: [
      { id: 'scene-setting', label: 'Scene & Setting', guidance: 'where it happens', weight: 3 },
      { id: 'speaker', label: 'Speaker', guidance: 'who talks', weight: 2 },
      { id: 'dialogue', label: 'Dialogue Line', guidance: 'the line', weight: 2 },
    ],
    assembly: 'Scene first, then the speaker, then the line.',
  },
  principles: ['name the speaker before the line'],
  antiPatterns: ['do not describe cuts'],
  taskPatterns: [{ task: 'lipsync-dialogue', support: 'native', pattern: 'name the speaker' }],
  guide: '',
  confidence: 'high',
  sources: [],
};

/** A client that returns one scripted JSON plan. */
const fakeClient = (plan: unknown) =>
  ({
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(plan) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }),
    },
  }) as never;

test('buildVideoParts: STRUCTURE is the model\'s, CONTENT is the agent\'s', () => {
  const facts = videoFactsForModel(kling, klingDoctrine);
  const parts = buildVideoParts(
    facts,
    [{ id: 'speaker', label: 'ignored', value: 'the detective', recommend: 'a weary detective', chips: ['close-up'] }],
    'a rainy interrogation',
  );
  // All three of Kling's parts are present, in ITS order — even the ones the agent skipped.
  assert.deepEqual(parts.map((p) => p.label), ['Scene & Setting', 'Speaker', 'Dialogue Line']);
  assert.equal(parts[1].value, 'the detective');
  assert.equal(parts[1].recommend, 'a weary detective');
  // The lead part is seeded from the brief when the agent left it empty.
  assert.equal(parts[0].value, 'a rainy interrogation');
  // A part the agent ignored is shown empty, not dropped: the formula is the model's, not the agent's.
  assert.equal(parts[2].value, '');
});

test('the agent labels the reel with the MODEL\'S part count, not a fixed number', () => {
  const facts = videoFactsForModel(kling, klingDoctrine);
  assert.equal(facts.formula.parts.length, 3); // Kling's shape, not a generic five
});

test('a consultation leg emits a builder block built on the model\'s real formula', async () => {
  const events: VideoAgentEvent[] = [];
  for await (const e of runVideoAgent(
    { goal: 'a detective delivers a line in the rain', subject: 'detective' },
    {
      client: fakeClient({
        opener: 'Let us shape the shot.',
        prompt: 'a detective in the rain',
        task: 'lipsync-dialogue',
        durationSec: 8,
        resolution: '1080p',
        audio: true,
        parts: [{ id: 'speaker', label: 'Speaker', guidance: 'who', value: 'the detective', chips: [] }],
      }),
    },
  )) {
    events.push(e);
  }

  const block = (events.find((e) => e.type === 'agent_a2ui') as { block: VideoBuilderBlock } | undefined)?.block;
  assert.ok(block, 'a builder block is emitted');
  assert.equal(block!.media, 'video');
  assert.ok(events.some((e) => e.type === 'agent_text' && /shape the shot/i.test(e.delta)));
  // The shot specs the agent owns are carried on the block for the controls to bind to.
  assert.equal(block!.shot?.task, 'lipsync-dialogue');
  assert.equal(block!.shot?.durationSec, 8);
});

test('the agent can never promise what the model cannot do', async () => {
  const events: VideoAgentEvent[] = [];
  for await (const e of runVideoAgent(
    { goal: 'a long silent shot' },
    {
      client: fakeClient({
        opener: 'ok',
        prompt: 'x',
        durationSec: 600, // absurd
        resolution: '16k', // not offered
        audio: true,
        parts: [],
      }),
    },
  )) {
    events.push(e);
  }
  const block = (events.find((e) => e.type === 'agent_a2ui') as { block: VideoBuilderBlock } | undefined)?.block;
  assert.ok(block);
  // Clamped to THE CHOSEN MODEL'S real ceiling rather than sent as a guaranteed failure. Asserted
  // against the registry rather than a literal, so adding a longer model (Seedance 2.5 at 30s) does
  // not make this test lie about what "clamped" means.
  const chosen = allVideoModels().find((m) => m.id === block!.modelId)!;
  assert.ok(
    block!.shot!.durationSec <= chosen.video!.maxDurationSec,
    `clamped to ${chosen.label}'s ${chosen.video!.maxDurationSec}s, got ${block!.shot!.durationSec}`,
  );
  // An unoffered resolution is dropped, not passed through to be rejected.
  assert.equal(block!.shot!.resolution, undefined);
});

test('a malformed plan degrades to a usable guide instead of an empty panel', async () => {
  const events: VideoAgentEvent[] = [];
  for await (const e of runVideoAgent({ goal: 'a car chase' }, { client: fakeClient('not json at all') })) {
    events.push(e);
  }
  const block = (events.find((e) => e.type === 'agent_a2ui') as { block: VideoBuilderBlock } | undefined)?.block;
  assert.ok(block, 'the guide still renders');
  assert.ok(block!.parts.length > 0, 'with the model\'s real parts');
  assert.equal(block!.parts[0].value, 'a car chase'); // seeded from the brief
});
