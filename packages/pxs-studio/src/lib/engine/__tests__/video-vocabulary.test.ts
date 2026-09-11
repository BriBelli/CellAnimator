/**
 * Video vocabulary tests — the same guardrails as the image side: WE own the nouns, provider naming
 * is TRANSLATED onto them, and anything unmapped is dropped rather than coined. Pure; no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoTask, isVideoTask, VIDEO_TASKS, VIDEO_TASK_DEFS, videoVocabularyPrompt } from '../video-vocabulary';
import { normalizeTask } from '../task-vocabulary';

test('provider phrasing translates onto our video nouns', () => {
  assert.equal(normalizeVideoTask('storyboard'), 'multi-shot-sequence');
  assert.equal(normalizeVideoTask('scene extension'), 'clip-extension');
  assert.equal(normalizeVideoTask('first and last frame'), 'keyframe-interpolation');
  assert.equal(normalizeVideoTask('lip sync'), 'lipsync-dialogue');
  assert.equal(normalizeVideoTask('I2V'), 'image-to-video');
  assert.equal(normalizeVideoTask('Tracking Shot'), 'camera-move');
});

test('unmapped provider features are DROPPED, never coined', () => {
  assert.equal(normalizeVideoTask('Cinematic Magic Mode'), null);
  assert.equal(normalizeVideoTask('something invented'), null);
  assert.equal(normalizeVideoTask(''), null);
});

test('video and image vocabularies stay SEPARATE — a shot is not a picture', () => {
  for (const t of ['clip-extension', 'lipsync-dialogue', 'multi-shot-sequence', 'camera-move']) {
    assert.equal(normalizeTask(t), null, `${t} is not an image task`);
  }
  assert.equal(normalizeVideoTask('vector-illustration'), null);
  assert.equal(normalizeVideoTask('logo-mark'), null);
});

test('every task is well-formed and the prompt block lists them all', () => {
  assert.ok(
    VIDEO_TASKS.every(
      (t) => isVideoTask(t) && VIDEO_TASK_DEFS[t].label.length > 0 && VIDEO_TASK_DEFS[t].description.length > 0,
    ),
  );
  const block = videoVocabularyPrompt();
  for (const t of VIDEO_TASKS) assert.match(block, new RegExp(`- ${t}:`));
});
