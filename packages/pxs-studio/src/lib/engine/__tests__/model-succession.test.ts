/**
 * Successor-detection tests, written against the FOUR real misses this is meant to prevent:
 * FLUX two generations stale · Recraft V3 while V4.1 was the API default · Happy Horse 1.0 while 1.1
 * was live · Seedance 2.0 while 2.5 shipped. Every one was caught by a human reading a docs site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelId, isNewerVersion, findSuccessors } from '../model-succession';

test('parses the id shapes providers actually use', () => {
  const cases: [string, string, number[]][] = [
    ['bytedance/seedance-2.5/text-to-video', 'bytedance-seedance-text-to-video', [2, 5]],
    ['gemini-3.1-flash-image', 'gemini-flash-image', [3, 1]],
    ['recraftv4_1', 'recraft', [4, 1]],
    ['flux-2-pro', 'flux-pro', [2]],
  ];
  for (const [id, family, version] of cases) {
    const p = parseModelId(id);
    assert.equal(p.family, family, `${id} family`);
    assert.deepEqual(p.version, version, `${id} version`);
  }
});

test('version comparison handles uneven component counts', () => {
  assert.equal(isNewerVersion([2, 5], [2, 0]), true);
  assert.equal(isNewerVersion([3], [2, 9]), true);
  assert.equal(isNewerVersion([2, 0], [2]), false); // 2.0 === 2
  assert.equal(isNewerVersion([4, 1], [4, 1]), false);
  assert.equal(isNewerVersion([1, 9], [2, 0]), false);
});

test('THE MISS: Seedance 2.0 → 2.5 is detected across endpoint variants', () => {
  const found = findSuccessors(
    ['bytedance/seedance-2.0/text-to-video'],
    [
      'bytedance/seedance-2.0/text-to-video',
      'bytedance/seedance-2.5/text-to-video',
      'bytedance/seedance-2.5/reference-to-video',
    ],
  );
  assert.equal(found.length, 1, 'several endpoints of one model collapse to ONE finding');
  assert.equal(found[0].currentVersion, '2.0');
  assert.equal(found[0].successorVersion, '2.5');
});

test('the other three real misses are caught too', () => {
  const found = findSuccessors(
    ['recraftv3', 'flux-1.1-pro', 'alibaba/happy-horse/v1.0/text-to-video'],
    ['recraftv3', 'recraftv4_1', 'flux-2-pro', 'alibaba/happy-horse/v1.1/text-to-video'],
  );
  const by = Object.fromEntries(found.map((f) => [f.currentId, f.successorId]));
  assert.equal(by['recraftv3'], 'recraftv4_1');
  assert.equal(by['flux-1.1-pro'], 'flux-2-pro');
  assert.equal(by['alibaba/happy-horse/v1.0/text-to-video'], 'alibaba/happy-horse/v1.1/text-to-video');
});

test('it reports the NEWEST successor, not merely a newer one', () => {
  const found = findSuccessors(['seedance-2.0'], ['seedance-2.1', 'seedance-2.5', 'seedance-2.3']);
  assert.equal(found[0].successorVersion, '2.5');
});

test('CONSERVATIVE: different families never match, however similar', () => {
  // A real listing is mostly other models; a false successor would send us researching nonsense.
  assert.deepEqual(findSuccessors(['flux-2-pro'], ['flux-2-dev', 'gemini-3-pro-image', 'sdxl-1.0']), []);
  // Same family, older or equal → nothing.
  assert.deepEqual(findSuccessors(['seedance-2.5'], ['seedance-2.0', 'seedance-2.5']), []);
  // Unversioned ids are skipped rather than guessed at.
  assert.deepEqual(findSuccessors(['recraft'], ['recraftv4_1']), []);
});

test('an empty or unrelated listing is simply no news', () => {
  assert.deepEqual(findSuccessors(['flux-2-pro'], []), []);
  assert.deepEqual(findSuccessors([], ['flux-9-pro']), []);
});

// ── THE SWEEP ────────────────────────────────────────────────────────────────────────────────────
import { familyKeyword, sweepForSuccessors } from '../model-succession';

test('familyKeyword extracts the model NAME a search index would match', () => {
  assert.equal(familyKeyword('bytedance/seedance-2.0/text-to-video'), 'seedance');
  assert.equal(familyKeyword('fal-ai/kling-video/v3/pro'), 'kling');
  assert.equal(familyKeyword('alibaba/happy-horse/v1.1/text-to-video'), 'happy');
  assert.equal(familyKeyword('recraftv4_1'), 'recraft');
});

test('the sweep asks per family and reports successors against OUR registry ids', async () => {
  const asked: string[] = [];
  const reports = await sweepForSuccessors(
    [{ id: 'seedance-2', provider: 'fal', providerModelId: 'bytedance/seedance-2.0/text-to-video' }],
    {
      search: async (_p, keyword) => {
        asked.push(keyword);
        return ['bytedance/seedance-2.0/text-to-video', 'bytedance/seedance-2.5/text-to-video'];
      },
    },
  );
  assert.deepEqual(asked, ['seedance']);
  const s = reports[0].successions[0];
  // Named by the REGISTRY id, because that is the record a human has to go and update.
  assert.equal(s.currentId, 'seedance-2');
  assert.equal(s.successorVersion, '2.5');
});

test('one query per family, however many endpoint variants we curate', async () => {
  let calls = 0;
  await sweepForSuccessors(
    [
      { id: 'a', provider: 'fal', providerModelId: 'bytedance/seedance-2.0/text-to-video' },
      { id: 'b', provider: 'fal', providerModelId: 'bytedance/seedance-2.0/image-to-video' },
    ],
    { search: async () => { calls++; return []; } },
  );
  assert.equal(calls, 1);
});

test('a provider that will not answer is not a finding — the next pass retries', async () => {
  const reports = await sweepForSuccessors(
    [{ id: 'a', provider: 'fal', providerModelId: 'seedance-2.0' }],
    { search: async () => { throw new Error('rate limited'); } },
  );
  assert.deepEqual(reports[0].successions, []);
  // "Checked and found nothing" must stay distinguishable from "never looked".
  assert.deepEqual(reports[0].checkedFamilies, ['seedance']);
});
