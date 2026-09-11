/**
 * fal video routing tests — the decisions that are wrong SILENTLY. Sending references to the
 * text-to-video endpoint doesn't error; it just ignores them, so the render comes back with no sign
 * your reference did anything. Pure; no network, no spend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFalRequest } from '../adapters/fal-video';

const FAMILY = 'bytedance/seedance-2.0';
const base = { modelId: 'seedance-2', prompt: 'a red car on a coast road' };

test('the INPUTS choose the endpoint — text, image, or reference', () => {
  assert.equal(planFalRequest(base, FAMILY).path, `${FAMILY}/text-to-video`);
  assert.equal(planFalRequest({ ...base, startFrame: 'a.png' }, FAMILY).path, `${FAMILY}/image-to-video`);
  assert.equal(planFalRequest({ ...base, references: ['a.png'] }, FAMILY).path, `${FAMILY}/reference-to-video`);
});

test('a start AND end frame is keyframe interpolation, not two separate ideas', () => {
  const { path, input } = planFalRequest({ ...base, startFrame: 'a.png', endFrame: 'b.png' }, FAMILY);
  assert.equal(path, `${FAMILY}/image-to-video`);
  assert.equal(input.image_url, 'a.png');
  assert.equal(input.end_image_url, 'b.png');
});

test('references go to image_urls and are capped at the schema maximum of 9', () => {
  const refs = Array.from({ length: 14 }, (_, i) => `r${i}.png`);
  const { input } = planFalRequest({ ...base, references: refs }, FAMILY);
  assert.equal((input.image_urls as string[]).length, 9);
  assert.equal((input.image_urls as string[])[0], 'r0.png');
});

test('a start frame WINS over references — a frame is a position, not a hint', () => {
  const { path, input } = planFalRequest({ ...base, startFrame: 'first.png', references: ['r.png'] }, FAMILY);
  assert.equal(path, `${FAMILY}/image-to-video`);
  assert.equal(input.image_url, 'first.png');
  assert.equal(input.image_urls, undefined);
});

test('duration snaps to the accepted enum instead of being rejected', () => {
  assert.equal(planFalRequest({ ...base, durationSec: 4 }, FAMILY).input.duration, '4');
  assert.equal(planFalRequest({ ...base, durationSec: 7 }, FAMILY).input.duration, '7');
  assert.equal(planFalRequest({ ...base, durationSec: 2 }, FAMILY).input.duration, '4'); // below the floor
  assert.equal(planFalRequest({ ...base, durationSec: 30 }, FAMILY).input.duration, '15'); // above the ceiling
  assert.equal(planFalRequest(base, FAMILY).input.duration, 'auto'); // unspecified → the model decides
});

test('unsupported aspect/resolution are OMITTED, never passed through to be rejected', () => {
  const good = planFalRequest({ ...base, aspectRatio: '21:9', resolution: '4k' }, FAMILY).input;
  assert.equal(good.aspect_ratio, '21:9');
  assert.equal(good.resolution, '4k');
  const bad = planFalRequest({ ...base, aspectRatio: '5:7', resolution: '8k' }, FAMILY).input;
  assert.equal(bad.aspect_ratio, undefined);
  assert.equal(bad.resolution, undefined);
});

test('audio is only sent when explicitly decided — never guessed', () => {
  assert.equal(planFalRequest(base, FAMILY).input.generate_audio, undefined);
  assert.equal(planFalRequest({ ...base, audio: true }, FAMILY).input.generate_audio, true);
  assert.equal(planFalRequest({ ...base, audio: false }, FAMILY).input.generate_audio, false);
});

// ── KLING: a different input dialect on the same queue ───────────────────────────────────────────
const KLING = 'fal-ai/kling-video/v3/pro';

test('Kling: a SEQUENCE reaches multi_prompt, not a flattened single prompt', () => {
  const shots = ['wide establishing shot of the coast', 'the car rounds the bend', 'close on the driver'];
  const { path, input } = planFalRequest({ ...base, shots }, KLING, 'kling');
  assert.equal(path, `${KLING}/text-to-video`);
  // Each shot is an OBJECT with its own duration — bare strings are rejected by fal.
  assert.deepEqual(input.multi_prompt, shots.map((p) => ({ prompt: p, duration: '5' })));
  assert.equal(input.shot_type, 'customize'); // the caller wrote the shots; don't re-cut them
  assert.equal(input.prompt, undefined);
});

test('Kling: a single shot uses the plain prompt (multi_prompt is for sequences only)', () => {
  const { input } = planFalRequest({ ...base, shots: ['just the one shot'] }, KLING, 'kling');
  assert.equal(input.prompt, 'just the one shot');
  assert.equal(input.multi_prompt, undefined);
});

test('Kling: its OWN aspect + duration ranges are enforced, not Seedance\'s', () => {
  // Kling accepts 3s (Seedance's floor is 4) and does NOT offer 21:9.
  assert.equal(planFalRequest({ ...base, durationSec: 3 }, KLING, 'kling').input.duration, '3');
  assert.equal(planFalRequest({ ...base, aspectRatio: '21:9' }, KLING, 'kling').input.aspect_ratio, undefined);
  assert.equal(planFalRequest({ ...base, aspectRatio: '9:16' }, KLING, 'kling').input.aspect_ratio, '9:16');
  // Seedance DOES take 21:9 — proving the dialects are genuinely separate.
  assert.equal(planFalRequest({ ...base, aspectRatio: '21:9' }, FAMILY, 'seedance').input.aspect_ratio, '21:9');
});

test('Kling: negative prompt is passed; Seedance has no such parameter', () => {
  assert.equal(planFalRequest({ ...base, negativePrompt: 'text, watermark' }, KLING, 'kling').input.negative_prompt, 'text, watermark');
  assert.equal(planFalRequest({ ...base, negativePrompt: 'text' }, FAMILY, 'seedance').input.negative_prompt, undefined);
});

test('Kling: a start frame routes to image-to-video; it has no reference pool', () => {
  const { path, input } = planFalRequest({ ...base, startFrame: 'a.png', references: ['r.png'] }, KLING, 'kling');
  assert.equal(path, `${KLING}/image-to-video`);
  assert.equal(input.image_url, 'a.png');
  assert.equal(input.image_urls, undefined);
});

// ── HAPPY HORSE: a third dialect on the same queue ───────────────────────────────────────────────
const HH = 'alibaba/happy-horse/v1.1';

test('Happy Horse: duration is an INTEGER — the same value as a string is a 422', () => {
  const { input } = planFalRequest({ ...base, durationSec: 8 }, HH, 'happyhorse');
  assert.equal(input.duration, 8);
  assert.equal(typeof input.duration, 'number');
  // Its siblings send strings — proof the dialects genuinely cannot be merged.
  assert.equal(typeof planFalRequest({ ...base, durationSec: 8 }, FAMILY, 'seedance').input.duration, 'string');
  assert.equal(typeof planFalRequest({ ...base, durationSec: 8 }, KLING, 'kling').input.duration, 'string');
});

test('Happy Horse: clamps to its 3-15s range', () => {
  assert.equal(planFalRequest({ ...base, durationSec: 1 }, HH, 'happyhorse').input.duration, 3);
  assert.equal(planFalRequest({ ...base, durationSec: 60 }, HH, 'happyhorse').input.duration, 15);
});

test('Happy Horse: the widest aspect range in the roster is honoured', () => {
  // 9:21 and 5:4 exist here and nowhere else.
  assert.equal(planFalRequest({ ...base, aspectRatio: '9:21' }, HH, 'happyhorse').input.aspect_ratio, '9:21');
  assert.equal(planFalRequest({ ...base, aspectRatio: '5:4' }, HH, 'happyhorse').input.aspect_ratio, '5:4');
  assert.equal(planFalRequest({ ...base, aspectRatio: '9:21' }, KLING, 'kling').input.aspect_ratio, undefined);
});

test('Happy Horse: references route to reference-to-video, capped at 4', () => {
  const refs = Array.from({ length: 9 }, (_, i) => `r${i}.png`);
  const { path, input } = planFalRequest({ ...base, references: refs }, HH, 'happyhorse');
  assert.equal(path, `${HH}/reference-to-video`);
  assert.equal((input.image_urls as string[]).length, 4);
});

test('Happy Horse: only its two resolution tiers pass through', () => {
  assert.equal(planFalRequest({ ...base, resolution: '1080p' }, HH, 'happyhorse').input.resolution, '1080p');
  assert.equal(planFalRequest({ ...base, resolution: '4k' }, HH, 'happyhorse').input.resolution, undefined);
});

// ── SEEDANCE'S FULL INPUT SURFACE ────────────────────────────────────────────────────────────────
// Verified from fal's live schema: 9 images + 3 clips + 3 audio in ONE generation, each addressed
// from the prompt. The adapter previously wired images only — the other two thirds of the model's
// capability existed, were billed for, and were unreachable.
import { seedanceLegend } from '../adapters/fal-video';

test('Seedance takes CLIPS and AUDIO, not just images', () => {
  const { path, input } = planFalRequest(
    { ...base, references: ['i1.png'], videoRefs: ['v1.mp4', 'v2.mp4'], audioRefs: ['a1.wav'] },
    FAMILY,
    'seedance',
  );
  assert.equal(path, `${FAMILY}/reference-to-video`);
  assert.deepEqual(input.image_urls, ['i1.png']);
  assert.deepEqual(input.video_urls, ['v1.mp4', 'v2.mp4']);
  assert.deepEqual(input.audio_urls, ['a1.wav']);
});

test('each media type is capped at its OWN documented limit', () => {
  const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const { input } = planFalRequest(
    { ...base, references: many(14, 'i'), videoRefs: many(9, 'v'), audioRefs: many(9, 'a') },
    FAMILY,
    'seedance',
  );
  assert.equal((input.image_urls as string[]).length, 9);
  assert.equal((input.video_urls as string[]).length, 3);
  assert.equal((input.audio_urls as string[]).length, 3);
});

test('attached media is NAMED in the prompt — Seedance addresses it positionally', () => {
  const { input } = planFalRequest(
    { ...base, references: ['i1.png', 'i2.png'], videoRefs: ['v1.mp4'], audioRefs: ['a1.wav'] },
    FAMILY,
    'seedance',
  );
  // Without the legend the model receives the media but is never told what to do with it — the
  // request succeeds and the reference is silently ignored.
  assert.match(input.prompt as string, /@Image1, @Image2, @Video1, @Audio1/);
});

test('audio/clip refs alone still route to reference-to-video', () => {
  const { path, input } = planFalRequest({ ...base, audioRefs: ['a1.wav'] }, FAMILY, 'seedance');
  assert.equal(path, `${FAMILY}/reference-to-video`);
  assert.equal(input.image_urls, undefined);
  assert.deepEqual(input.audio_urls, ['a1.wav']);
});

test('seedanceLegend stays silent when nothing is attached', () => {
  assert.equal(seedanceLegend(0, 0, 0), '');
  assert.match(seedanceLegend(1, 0, 0), /@Image1/);
});

test('duration ranges are PER MODEL — 2.5 reaches 30s where 2.0 stops at 15', () => {
  const V25 = 'bytedance/seedance-2.5';
  assert.equal(planFalRequest({ ...base, durationSec: 30 }, V25, 'seedance').input.duration, '30');
  assert.equal(planFalRequest({ ...base, durationSec: 22 }, V25, 'seedance').input.duration, '22');
  // 2.0 clamps to its own ceiling — sharing one range would silently halve a 2.5 request.
  assert.equal(planFalRequest({ ...base, durationSec: 30 }, FAMILY, 'seedance').input.duration, '15');
});
