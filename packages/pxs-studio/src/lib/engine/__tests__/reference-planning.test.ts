/**
 * Reference planning tests — the graceful-specialist contract: never dead-end, honor REAL slots and
 * provider exclusivity, and report every compromise BEFORE spending. Pure; no network.
 * Run: `tsx --test src/lib/engine/__tests__/reference-planning.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReferences, referenceCapacity, acceptsRole, describeSlots } from '../reference-planning';
import { getModel } from '../model-registry';
import type { ImageModel, InputSlot } from '../model-registry';

const model = (over: Partial<ImageModel> = {}): ImageModel =>
  ({
    id: 'm', label: 'M', provider: 'gemini', envKey: 'K', tier: 2,
    strengths: { photorealism: 3, prompt_adherence: 3, editing: 3, style_versatility: 3, text_rendering: 3, speed: 3, resolution: 3, consistency: 3, multimodal: 3 },
    capabilities: [], bestFor: [], supportsEditing: true, maxReferenceImages: 0,
    aspectRatios: ['1:1'], costPerImageUsd: [0.01, 0.02], maxBatchN: 1, batchStrategy: 'parallel',
    brief: '', sourceRefreshedAt: '2026-08-24', ...over,
  }) as ImageModel;

const refs = (...roles: (string | undefined)[]) =>
  roles.map((role, i) => ({ url: `ref-${i}`, role: role as never }));

test('typed slots: each role lands in ITS channel, not a generic pool', () => {
  const pro = getModel('gemini-3-pro-image')!;
  const plan = planReferences(pro, refs('character', 'style', 'object'));
  assert.equal(plan.dropped.length, 0);
  const bySlot = Object.fromEntries(plan.planned.map((p) => [p.requestedRole, p.slotRole]));
  assert.deepEqual(bySlot, { character: 'character', style: 'style', object: 'object' });
});

test('per-slot caps are real: the 4th style ref is refused with a reason, others still fly', () => {
  const ideogram = getModel('ideogram-v3')!;
  const plan = planReferences(ideogram, refs('style', 'style', 'style', 'style', 'character'));
  assert.equal(plan.planned.filter((p) => p.slotRole === 'style').length, 3); // documented cap
  assert.equal(plan.planned.filter((p) => p.slotRole === 'character').length, 1);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.dropped[0].reason, /style references — that slot is full/i);
  assert.ok(plan.notices.some((n) => /not sent/.test(n))); // surfaced before spend
});

test('provider exclusivity is honored (Ideogram style refs disable style codes)', () => {
  const ideogram = getModel('ideogram-v3')!;
  const slot = ideogram.inputSlots!.find((s) => s.param === 'style_reference_images')!;
  assert.deepEqual(slot.conflictsWith, ['style_codes', 'style_type']);
  const plan = planReferences(ideogram, refs('style'));
  assert.equal(plan.planned[0].param, 'style_reference_images');
});

test('graceful fallback: a model with no character channel still USES the image, and says so', () => {
  const flux = getModel('flux-2-pro')!; // one general, index-addressable pool
  const plan = planReferences(flux, refs('character', 'style'));
  assert.equal(plan.planned.length, 2); // never benched
  assert.ok(plan.planned.every((p) => p.slotRole === 'general'));
  assert.ok(plan.notices.some((n) => /no dedicated character channel/i.test(n)));
  // The usage fact that makes FLUX refs actually work is surfaced.
  assert.ok(plan.notices.some((n) => /index-addressable/i.test(n)));
});

test('total cap beats the sum of slots (Gemini: 10+5+3 slots, 14 total)', () => {
  const pro = getModel('gemini-3-pro-image')!;
  assert.equal(referenceCapacity(pro), 14); // not 18
  const plan = planReferences(pro, Array.from({ length: 16 }, (_, i) => ({ url: `r${i}`, role: 'object' as const })));
  assert.equal(plan.planned.length, 10); // object slot caps first
  assert.equal(plan.dropped.length, 6);
});

test('masks are control data, never counted as reference capacity', () => {
  const gpt = getModel('gpt-image-1.5')!;
  assert.equal(referenceCapacity(gpt), 16); // the 1 mask slot is not added
  assert.equal(acceptsRole(gpt, 'mask'), true);
  const plan = planReferences(gpt, refs('style', 'character', 'object'));
  assert.ok(plan.planned.every((p) => p.param === 'image')); // flat pool, honestly
});

test('zero-reference model: never crashes, says what it needs instead', () => {
  const m = model({ label: 'NoRefs', maxReferenceImages: 0 });
  const plan = planReferences(m, refs('style'));
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.notices[0], /doesn't accept reference images/i);
});

test('unresearched model falls back to the flat pool and clamps honestly', () => {
  const m = model({ label: 'Flat', maxReferenceImages: 2 });
  const plan = planReferences(m, refs('style', 'character', 'object'));
  assert.equal(plan.planned.length, 2);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.notices[0], /takes 2 references; sending the first 2 of 3/i);
});

test('unpublished slot counts read as 1, never as unlimited', () => {
  const slots: InputSlot[] = [{ param: 'style', role: 'style', label: 'Style set', max: undefined }];
  const m = model({ inputSlots: slots, maxReferenceImages: 0 });
  assert.equal(referenceCapacity(m), 1);
  assert.match(describeSlots(m), /Style set: \?/);
});

test('every seeded model has real, non-empty input channels', () => {
  for (const id of ['gpt-image-1.5', 'flux-2-pro', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'ideogram-v3', 'recraft-v4.1', 'grok-imagine-image-2.0']) {
    const m = getModel(id)!;
    assert.ok((m.inputSlots ?? []).length > 0, `${id} has slots`);
    assert.ok(referenceCapacity(m) > 0, `${id} has capacity`);
  }
});

// ── ROLE ROUTING (end-to-end contract) ───────────────────────────────────────────────────────────
// The gap these close: roles were researched, surfaced in the Guide, and planned against — then the
// coordinator did `plan.planned.map(p => p.url)` and threw the assignment away, so a face reference
// reached Ideogram's STYLE channel and conditioned the palette instead of the person.

test('a tagged CHARACTER ref reaches the character channel, not the style channel', () => {
  const ideogram = getModel('ideogram-v3')!;
  const plan = planReferences(ideogram, [
    { url: 'face.png', role: 'character' },
    { url: 'mood.png', role: 'style' },
  ]);
  const face = plan.planned.find((p) => p.url === 'face.png')!;
  const mood = plan.planned.find((p) => p.url === 'mood.png')!;
  assert.equal(face.param, 'character_reference_images');
  assert.equal(mood.param, 'style_reference_images');
});

test('the plan carries the PROVIDER PARAM per image — the fact the adapter needs', () => {
  const pro = getModel('gemini-3-pro-image')!;
  const plan = planReferences(pro, [
    { url: 'a.png', role: 'character' },
    { url: 'b.png', role: 'object' },
    { url: 'c.png', role: 'style' },
  ]);
  // Every planned reference is addressable: url + param + the role it actually landed in.
  for (const p of plan.planned) {
    assert.ok(p.param.length > 0, 'has a provider param');
    assert.ok(['character', 'object', 'style', 'general', 'subject'].includes(p.slotRole));
  }
  assert.deepEqual(plan.planned.map((p) => p.slotRole).sort(), ['character', 'object', 'style']);
});

test('roles survive a model with only a general pool — reported, never silently reinterpreted', () => {
  const flux = getModel('flux-2-pro')!;
  const plan = planReferences(flux, [{ url: 'face.png', role: 'character' }]);
  assert.equal(plan.planned[0].requestedRole, 'character'); // what the user MEANT is preserved
  assert.equal(plan.planned[0].slotRole, 'general'); // where it actually went
  assert.ok(plan.notices.some((n) => /no dedicated character channel/i.test(n)));
});
