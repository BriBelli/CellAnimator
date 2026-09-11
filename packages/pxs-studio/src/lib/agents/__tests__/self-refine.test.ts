/**
 * Self-refinement tests — the guardrails that keep an auto-editor from being worse than none.
 * Injected client; no network. Run: `tsx --test src/lib/agents/__tests__/self-refine.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfRefine, type SelfRefineInput } from '../model-agent/self-refine';
import type { ModelDoctrine } from '../model-agent/doctrine';

const FORMULA = {
  parts: [
    { id: 'subject', label: 'Subject', guidance: 'the focal point', weight: 3 },
    { id: 'location', label: 'Location', guidance: 'where', weight: 2 },
    { id: 'style', label: 'Style', guidance: 'the look', weight: 2 },
  ],
};

const DOCTRINE: ModelDoctrine = {
  modelId: 'm',
  principles: ['Lead with materials and texture', 'Use positive framing'],
  antiPatterns: ['Never say what should be absent'],
  taskPatterns: [],
  guide: '',
  confidence: 'high',
  sources: [{ url: 'https://docs.example/guide', kind: 'prompting_guide' }],
};

const input = (over: Partial<SelfRefineInput> = {}): SelfRefineInput => ({
  modelId: 'm',
  modelLabel: 'Test Model',
  formula: FORMULA,
  parts: [
    { id: 'subject', label: 'Subject', guidance: 'the focal point', value: 'a kettle' },
    { id: 'location', label: 'Location', guidance: 'where', value: 'no clutter around it' },
    { id: 'style', label: 'Style', guidance: 'the look', value: 'nice' },
  ],
  doctrine: DOCTRINE,
  ...over,
});

/** A fake client returning a scripted sequence (critique first, then the refinement). */
function fakeClient(responses: unknown[]) {
  let i = 0;
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify(responses[Math.min(i++, responses.length - 1)]) }],
        stop_reason: 'end_turn',
      }),
    },
  } as never;
}

const CRITIQUE = {
  score: 48,
  verdict: 'thin',
  strengths: [],
  findings: [
    { partId: 'location', severity: 'blocking', issue: 'says what should be absent', fix: 'name the surface that IS there', groundedIn: 'Never say what should be absent' },
    { partId: 'style', severity: 'weak', issue: '"nice" directs nothing', fix: 'name light, palette, medium', groundedIn: 'Lead with materials and texture' },
  ],
};

test('applies the critique to the parts it flagged, and only those', async () => {
  const r = await selfRefine(input(), {
    client: fakeClient([
      CRITIQUE,
      { edits: [
        { id: 'location', value: 'a worn oak counter', because: 'positive framing' },
        { id: 'style', value: 'warm window light, muted palette, 35mm film', because: 'materials and texture' },
      ], summary: 'Tightened Location and Style to what this model rewards.' },
    ]),
  });
  assert.equal(r.scoreBefore, 48);
  assert.deepEqual(r.edits.map((e) => e.id).sort(), ['location', 'style']);
  assert.equal(r.edits.find((e) => e.id === 'location')!.value, 'a worn oak counter');
  assert.equal(r.edits.some((e) => e.id === 'subject'), false); // never flagged → never touched
  assert.match(r.summary!, /Tightened/);
});

test('NEVER overwrites a part the user wrote', async () => {
  const r = await selfRefine(input({ userOwnedPartIds: ['location', 'style'] }), {
    client: fakeClient([CRITIQUE, { edits: [{ id: 'location', value: 'agent rewrite', because: 'x' }] }]),
  });
  assert.deepEqual(r.edits, []);
});

test('a user-owned part is dropped even if the model returns an edit for it anyway', async () => {
  const r = await selfRefine(input({ userOwnedPartIds: ['style'] }), {
    client: fakeClient([
      CRITIQUE,
      { edits: [
        { id: 'location', value: 'a worn oak counter', because: 'ok' },
        { id: 'style', value: 'SHOULD NOT APPLY', because: 'x' },
      ] },
    ]),
  });
  assert.deepEqual(r.edits.map((e) => e.id), ['location']); // enforced in code, not just the prompt
});

test('no doctrine → no refinement (never generic advice dressed as expertise)', async () => {
  const r = await selfRefine(input({ doctrine: null }), { client: fakeClient([CRITIQUE]) });
  assert.deepEqual(r.edits, []);
  assert.equal(r.scoreBefore, undefined);
});

test('polish-only findings are left for the human', async () => {
  const r = await selfRefine(input(), {
    client: fakeClient([
      { score: 88, verdict: 'solid', strengths: [], findings: [{ partId: 'style', severity: 'polish', issue: 'could be richer', fix: 'add a lens', groundedIn: 'x' }] },
      { edits: [{ id: 'style', value: 'SHOULD NOT APPLY', because: 'x' }] },
    ]),
  });
  assert.deepEqual(r.edits, []);
  assert.equal(r.scoreBefore, 88);
});

test('unknown ids, empty values, and no-op rewrites are all rejected', async () => {
  const r = await selfRefine(input(), {
    client: fakeClient([
      CRITIQUE,
      { edits: [
        { id: 'not-a-part', value: 'x', because: '' },
        { id: 'location', value: '   ', because: '' },
        { id: 'style', value: 'nice', because: 'identical to the draft' },
      ] },
    ]),
  });
  assert.deepEqual(r.edits, []);
});

test('a failing refine is a silent no-op — the draft always survives', async () => {
  const r = await selfRefine(input(), {
    client: { messages: { create: async () => { throw new Error('provider down'); } } } as never,
  });
  assert.deepEqual(r.edits, []);
});
