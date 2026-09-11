/**
 * Usage metering + the hard-cap gate.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryRepository } from '../adapters/memory';
import type { UserRecord } from '../models';
import { checkCap, costUsd, DEFAULT_HARD_CAP_USD, recordUsage } from '../usage';

test('costUsd uses Opus 4.8 pricing ($5/1M in, $25/1M out)', () => {
  assert.equal(costUsd(1_000_000, 0), 5);
  assert.equal(costUsd(0, 1_000_000), 25);
  assert.equal(costUsd(1_000_000, 1_000_000), 30);
});

test('recordUsage writes a Usage row and increments the user running totals', async () => {
  const repo = createMemoryRepository();
  const usage = await recordUsage(repo, {
    user_id: 'dev-user',
    interaction_id: 'i1',
    input_tokens: 1000,
    output_tokens: 2000,
  });
  assert.equal(usage.category, 'usage');
  assert.equal(usage.interaction_id, 'i1');
  assert.equal(usage.cost_usd, costUsd(1000, 2000));

  const user = (await repo.get('user', 'dev-user')) as UserRecord;
  assert.equal(user.running_input_tokens, 1000);
  assert.equal(user.running_output_tokens, 2000);
  assert.equal(user.running_cost_usd, costUsd(1000, 2000));
  assert.equal(user.hard_cap_usd, DEFAULT_HARD_CAP_USD);
});

test('recordUsage meters gen_cost_usd (image spend) into the running total + cap', async () => {
  const repo = createMemoryRepository();
  // No tokens, but $4 of image generation.
  const usage = await recordUsage(repo, {
    user_id: 'u',
    interaction_id: 'g1',
    input_tokens: 0,
    output_tokens: 0,
    gen_cost_usd: 4,
  });
  assert.equal(usage.gen_cost_usd, 4);
  assert.equal(usage.cost_usd, 4, 'total cost includes the image spend');
  const user = (await repo.get('user', 'u')) as UserRecord;
  assert.equal(user.running_cost_usd, 4, 'image spend hits running_cost_usd (not just tokens)');

  // $2 more of image spend crosses the $5 cap → blocked.
  await recordUsage(repo, { user_id: 'u', interaction_id: 'g2', input_tokens: 0, output_tokens: 0, gen_cost_usd: 2 });
  const capped = await checkCap(repo, 'u');
  assert.equal(capped.spent_usd, 6);
  assert.equal(capped.allowed, false, 'image spend alone can trip the hard cap');
});

test('recordUsage accumulates across calls', async () => {
  const repo = createMemoryRepository();
  await recordUsage(repo, { user_id: 'u', interaction_id: 'a', input_tokens: 100, output_tokens: 100 });
  await recordUsage(repo, { user_id: 'u', interaction_id: 'b', input_tokens: 100, output_tokens: 100 });
  const user = (await repo.get('user', 'u')) as UserRecord;
  assert.equal(user.running_input_tokens, 200);
  assert.equal(user.running_output_tokens, 200);
});

test('checkCap flips allowed=false once running spend reaches the cap', async () => {
  const repo = createMemoryRepository();
  // Unknown user → allowed, spent 0.
  const fresh = await checkCap(repo, 'u');
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.spent_usd, 0);
  assert.equal(fresh.cap_usd, DEFAULT_HARD_CAP_USD);

  // Burn tokens to hit exactly the $5 cap: output at $25/1M → 200_000 tokens = $5.
  await recordUsage(repo, { user_id: 'u', interaction_id: 'i', input_tokens: 0, output_tokens: 200_000 });
  const capped = await checkCap(repo, 'u');
  assert.equal(capped.spent_usd, 5);
  assert.equal(capped.allowed, false, 'spent >= cap → blocked');
  assert.equal(capped.remaining_usd, 0);
});

// ── USER-CONTROLLED BUDGET ───────────────────────────────────────────────────────────────────────
// The cap used to be a $5 constant nobody could change — a wall, not a rail, on a medium where one
// 10s 1080p clip is $3.40. It is the user's money, so it is the user's number.
import { setSpendCap, getBudget, MAX_SELF_SERVE_CAP_USD } from '../usage';

test('a user can raise their own cap, and it takes effect immediately', async () => {
  const repo = createMemoryRepository();
  const before = await getBudget(repo, 'u1');
  assert.equal(before.cap_usd, 5); // the starting default

  const res = await setSpendCap(repo, 'u1', 100);
  assert.equal(res.ok, true);
  assert.equal((res as { ok: true; budget: { cap_usd: number } }).budget.cap_usd, 100);
  assert.equal((await getBudget(repo, 'u1')).remaining_usd, 100);
});

test('spend is metered against the cap the USER set, not the default', async () => {
  const repo = createMemoryRepository();
  await setSpendCap(repo, 'u1', 50);
  await recordUsage(repo, { user_id: 'u1', interaction_id: 'i1', input_tokens: 0, output_tokens: 0, gen_cost_usd: 12 });
  const b = await getBudget(repo, 'u1');
  assert.equal(b.spent_usd, 12);
  assert.equal(b.remaining_usd, 38);
  assert.equal(b.allowed, true);
  assert.ok(Math.abs(b.used_fraction - 0.24) < 1e-6); // what a meter renders
});

test('lowering the cap below what is already spent STOPS work — it is not an error', async () => {
  const repo = createMemoryRepository();
  await setSpendCap(repo, 'u1', 50);
  await recordUsage(repo, { user_id: 'u1', interaction_id: 'i1', input_tokens: 0, output_tokens: 0, gen_cost_usd: 20 });
  const res = await setSpendCap(repo, 'u1', 10); // "stop me here"
  assert.equal(res.ok, true);
  const b = await getBudget(repo, 'u1');
  assert.equal(b.allowed, false);
  assert.equal(b.remaining_usd, 0); // never negative
});

test('only values that cannot be meant are refused', async () => {
  const repo = createMemoryRepository();
  assert.equal((await setSpendCap(repo, 'u1', -5)).ok, false);
  assert.equal((await setSpendCap(repo, 'u1', Number.NaN)).ok, false);
  const tooBig = await setSpendCap(repo, 'u1', MAX_SELF_SERVE_CAP_USD + 1);
  assert.equal(tooBig.ok, false);
  assert.match((tooBig as { ok: false; error: string }).error, /highest self-serve cap/i);
  // Zero is legitimate: "spend nothing more".
  assert.equal((await setSpendCap(repo, 'u1', 0)).ok, true);
  assert.equal((await getBudget(repo, 'u1')).allowed, false);
});
