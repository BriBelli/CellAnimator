/**
 * USAGE — metering + the hard-cap gate (Decision 3).
 *
 * `recordUsage` writes a per-interaction Usage row AND increments the running totals on the
 * user record (creating it lazily). `checkCap` is the spend gate: allowed while spent < cap.
 * Cost math uses the Opus 4.8 pricing constants from models.ts.
 *
 * Pure TS — no React/Next/DOM — so it runs under `node:test`.
 */

import {
  INPUT_USD_PER_TOKEN,
  OUTPUT_USD_PER_TOKEN,
  type Usage,
  type UserRecord,
} from './models';
import type { Repository } from './repository';

/**
 * The cap a NEW account starts at, USD. Deliberately small — an unfunded account should not be able
 * to spend meaningfully before its owner has chosen a number.
 */
export const DEFAULT_HARD_CAP_USD = 5;

/**
 * The ceiling on a self-service cap, USD. Not a judgement about how much someone should spend —
 * it is a blast radius. A typo (100 → 10000) on a medium where one render can be $14 should not be
 * silently accepted, and a raise past this asks for a deliberate step instead.
 */
export const MAX_SELF_SERVE_CAP_USD = 500;

/** A user's budget as the product surfaces it. */
export interface BudgetState {
  /** The cap they set (or the default). */
  cap_usd: number;
  /** Everything charged so far — tokens AND generation spend. */
  spent_usd: number;
  /** What is left to spend. Never negative. */
  remaining_usd: number;
  /** Below the cap → work is allowed. */
  allowed: boolean;
  /** How much of the cap is used, 0–1 — what a meter renders. */
  used_fraction: number;
}

/** Opus 4.8 cost for a given token split, USD. */
export function costUsd(input_tokens: number, output_tokens: number): number {
  return input_tokens * INPUT_USD_PER_TOKEN + output_tokens * OUTPUT_USD_PER_TOKEN;
}

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Fetch the user record, creating it (with the default cap) if missing. */
async function ensureUserRecord(repo: Repository, user_id: string): Promise<UserRecord> {
  const existing = (await repo.get('user', user_id)) as UserRecord | null;
  if (existing) return existing;
  const now = Date.now();
  const record: UserRecord = {
    id: user_id,
    user_id,
    category: 'user',
    status: 'active',
    created_at: now,
    updated_at: now,
    running_input_tokens: 0,
    running_output_tokens: 0,
    running_cost_usd: 0,
    hard_cap_usd: DEFAULT_HARD_CAP_USD,
  };
  return repo.put(record);
}

/**
 * Write a Usage row for an interaction and increment the user's running totals.
 * Creates the user record if it doesn't exist yet.
 */
export async function recordUsage(
  repo: Repository,
  args: {
    user_id: string;
    interaction_id: string;
    input_tokens: number;
    output_tokens: number;
    /** Non-token external spend (image/video generation), USD. Defaults to 0. */
    gen_cost_usd?: number;
  }
): Promise<Usage> {
  const { user_id, interaction_id, input_tokens, output_tokens } = args;
  const gen_cost_usd = args.gen_cost_usd ?? 0;
  // Total = token cost + external generation cost. BOTH must hit running_cost_usd so the
  // hard cap actually gates image spend (not just Claude tokens).
  const cost_usd = costUsd(input_tokens, output_tokens) + gen_cost_usd;
  const now = Date.now();

  const usage: Usage = {
    id: newId('usage'),
    user_id,
    category: 'usage',
    status: 'active',
    created_at: now,
    updated_at: now,
    interaction_id,
    input_tokens,
    output_tokens,
    gen_cost_usd,
    cost_usd,
  };
  await repo.put(usage);

  const user = await ensureUserRecord(repo, user_id);
  await repo.update('user', user.id, {
    running_input_tokens: user.running_input_tokens + input_tokens,
    running_output_tokens: user.running_output_tokens + output_tokens,
    running_cost_usd: user.running_cost_usd + cost_usd,
  } as Partial<UserRecord>);

  return usage;
}

/**
 * Set the user's own spend cap.
 *
 * This is THEIR money and therefore their decision — the cap exists so nobody is surprised by a
 * bill, not to ration what they are allowed to make. So a raise is honoured immediately and without
 * argument, and lowering below what is already spent is allowed too (it simply stops further work
 * rather than being rejected as "invalid").
 *
 * Rejected only for values that cannot be meant: not a number, negative, or past the blast-radius
 * ceiling. Returns the resulting budget so a caller never has to re-read to render it.
 */
export async function setSpendCap(
  repo: Repository,
  user_id: string,
  cap_usd: number,
): Promise<{ ok: true; budget: BudgetState } | { ok: false; error: string }> {
  if (!Number.isFinite(cap_usd) || cap_usd < 0) {
    return { ok: false, error: 'A spend cap must be a positive dollar amount.' };
  }
  if (cap_usd > MAX_SELF_SERVE_CAP_USD) {
    return {
      ok: false,
      error: `The highest self-serve cap is $${MAX_SELF_SERVE_CAP_USD}. Contact support to raise it further.`,
    };
  }
  const rounded = Number(cap_usd.toFixed(2));
  const user = await ensureUserRecord(repo, user_id);
  await repo.update('user', user.id, { hard_cap_usd: rounded } as Partial<UserRecord>);
  const spent_usd = user.running_cost_usd;
  return {
    ok: true,
    budget: {
      cap_usd: rounded,
      spent_usd,
      remaining_usd: Math.max(0, rounded - spent_usd),
      allowed: spent_usd < rounded,
      used_fraction: rounded > 0 ? Math.min(1, spent_usd / rounded) : 1,
    },
  };
}

/** The budget as the UI shows it — one read, everything a meter and a warning need. */
export async function getBudget(repo: Repository, user_id: string): Promise<BudgetState> {
  const user = (await repo.get('user', user_id)) as UserRecord | null;
  const cap_usd = user?.hard_cap_usd ?? DEFAULT_HARD_CAP_USD;
  const spent_usd = user?.running_cost_usd ?? 0;
  return {
    cap_usd,
    spent_usd: Number(spent_usd.toFixed(4)),
    remaining_usd: Math.max(0, Number((cap_usd - spent_usd).toFixed(4))),
    allowed: spent_usd < cap_usd,
    used_fraction: cap_usd > 0 ? Math.min(1, spent_usd / cap_usd) : 1,
  };
}

/** The spend gate: allowed while running spend is strictly below the hard cap. */
export async function checkCap(
  repo: Repository,
  user_id: string
): Promise<{ allowed: boolean; spent_usd: number; cap_usd: number; remaining_usd: number }> {
  const user = (await repo.get('user', user_id)) as UserRecord | null;
  const spent_usd = user?.running_cost_usd ?? 0;
  const cap_usd = user?.hard_cap_usd ?? DEFAULT_HARD_CAP_USD;
  return {
    allowed: spent_usd < cap_usd,
    spent_usd,
    cap_usd,
    remaining_usd: Math.max(0, cap_usd - spent_usd),
  };
}
