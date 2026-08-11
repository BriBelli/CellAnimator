/**
 * The routing brain — how the coordinator turns an intent into "which model(s),
 * how many images each." A faithful re-creation of photolif's TWO-GATE routing on
 * our own registry:
 *
 *   Gate 1 (deterministic, pure, testable) — drop every model that CANNOT satisfy
 *           the request: missing capability, unsupported aspect ratio, no edit path
 *           when editing, no API key present, or blown budget. Closed + auditable.
 *
 *   Gate 2 (LLM rank) — hand the SURVIVING catalog (ids + briefs) to Opus and let it
 *           rank + assign the fan-out (which models, how many images each) with a
 *           rationale. Falls back to a deterministic pick if the call fails.
 *
 * Gate 1 is the guardrail; Gate 2 is the craft. The router NEVER hardcodes a model —
 * it reasons over the registry. `dropped` is surfaced for transparency (the console).
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  IMAGE_MODELS,
  getModel,
  type Capability,
  type ImageModel,
} from './model-registry';

const MODEL = 'claude-opus-4-8';

/** What the user wants, normalized into routable terms. */
export interface RoutingRequest {
  /** The user's ask, verbatim-ish (the LLM ranker reads this). */
  intent: string;
  /** Capabilities the request REQUIRES (Gate-1 hard filter). */
  needs: Capability[];
  aspectRatio?: string;
  /** Desired number of images total (K) — the single/spread path splits this across models. */
  count: number;
  /** FAN-OUT breadth: distinct models to render across in ONE turn (decision-closure — you see N
   *  models' takes side by side). >1 → the coordinator fans across the top-N. Default 1 (single). */
  fanModels?: number;
  /** Images PER model in a fan-out (the Artlist "Number of Images"). Default 1. Total = fanModels×perModel. */
  perModel?: number;
  /** Input images (https or data URLs) to edit / compose from — forwarded to the adapter. */
  references?: string[];
  /** True when the request edits/composes input images. */
  editing?: boolean;
  /** Optional hard budget for the whole request (USD). */
  budgetUsd?: number;
}

/** One model's slice of the fan-out. */
export interface RoutedModel {
  modelId: string;
  n: number;
  rationale: string;
  /** The fit score the fan-out ranked this model by (higher = better fit for THIS request). Surfaced
   *  per-result so the UI can show a per-model score (Slice 3). */
  score?: number;
}

/** A Gate-1 drop, kept for transparency. */
export interface DroppedModel {
  modelId: string;
  reason: 'missing_capability' | 'aspect_ratio' | 'no_edit' | 'no_key' | 'over_budget' | 'preview';
}

/** The routing outcome the coordinator dispatches. */
export interface RoutingDecision {
  primary: RoutedModel;
  /** The full fan-out (includes primary). Multi-model when >1 entry. */
  fanout: RoutedModel[];
  dropped: DroppedModel[];
  /** (low, high) estimated USD across the whole fan-out. */
  estCostUsd: [number, number];
}

/** Injectable key check — defaults to process.env, overridable for tests. */
export type HasKey = (envKey: string) => boolean;
const defaultHasKey: HasKey = (envKey) => !!process.env[envKey];

/* ── Gate 1 — deterministic filter (pure) ──────────────────────────────────── */

/**
 * Filter the catalog to models that CAN satisfy the request. Pure: no I/O beyond
 * the injected `hasKey`. Returns survivors + the drop list (with reasons).
 */
export function gate1Filter(
  req: RoutingRequest,
  hasKey: HasKey = defaultHasKey,
  catalog: ImageModel[] = IMAGE_MODELS
): { survivors: ImageModel[]; dropped: DroppedModel[] } {
  const survivors: ImageModel[] = [];
  const dropped: DroppedModel[] = [];

  for (const m of catalog) {
    // Preview models are registry KNOWLEDGE only — never routed to (not yet callable).
    if (m.preview) {
      dropped.push({ modelId: m.id, reason: 'preview' });
      continue;
    }
    const missing = req.needs.find((c) => !m.capabilities.includes(c));
    if (missing) {
      dropped.push({ modelId: m.id, reason: 'missing_capability' });
      continue;
    }
    if (req.editing && !m.supportsEditing) {
      dropped.push({ modelId: m.id, reason: 'no_edit' });
      continue;
    }
    if (req.aspectRatio && !m.aspectRatios.includes(req.aspectRatio)) {
      dropped.push({ modelId: m.id, reason: 'aspect_ratio' });
      continue;
    }
    if (!hasKey(m.envKey)) {
      dropped.push({ modelId: m.id, reason: 'no_key' });
      continue;
    }
    if (req.budgetUsd != null) {
      const minSpend = m.costPerImageUsd[0] * Math.max(1, req.count);
      if (minSpend > req.budgetUsd) {
        dropped.push({ modelId: m.id, reason: 'over_budget' });
        continue;
      }
    }
    survivors.push(m);
  }

  return { survivors, dropped };
}

/** Sum a fan-out's (low, high) cost band. */
export function estimateCost(fanout: RoutedModel[]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const r of fanout) {
    const m = getModel(r.modelId);
    if (!m) continue;
    lo += m.costPerImageUsd[0] * r.n;
    hi += m.costPerImageUsd[1] * r.n;
  }
  return [Number(lo.toFixed(3)), Number(hi.toFixed(3))];
}

/**
 * Deterministic fallback ranking — the highest-tier survivor takes the whole count.
 * Used when Gate 2's LLM call is unavailable or fails, so routing never dead-ends.
 */
export function deterministicRoute(
  req: RoutingRequest,
  survivors: ImageModel[],
  dropped: DroppedModel[]
): RoutingDecision | null {
  if (survivors.length === 0) return null;
  const best = [...survivors].sort((a, b) => b.tier - a.tier || b.strengths.prompt_adherence - a.strengths.prompt_adherence)[0];
  const primary: RoutedModel = {
    modelId: best.id,
    n: Math.max(1, req.count),
    rationale: `Highest-tier model satisfying the request (${best.label}).`,
  };
  return { primary, fanout: [primary], dropped, estCostUsd: estimateCost([primary]) };
}

/**
 * Score a model's FIT for THIS request — read live from the registry (self-maintaining), never a static
 * rating (photolif's fatal flaw). Grounded in the STRUCTURED request signals (editing / references /
 * needs) matched to the model's strengths + tier — not prompt NLP (that's the LLM ranker's job). This
 * is what makes the fan-out's auto pick "the top-N for what you actually asked," and it stays current
 * as the Model agent's refresh updates the registry.
 */
export function scoreModelForRequest(m: ImageModel, req: RoutingRequest): number {
  let s = m.tier * 2 + m.strengths.prompt_adherence;
  if (req.editing) s += m.strengths.editing;
  if (req.references && req.references.length > 0) {
    s += m.strengths.multimodal + (m.capabilities.includes('multi_reference') ? 2 : 0) + m.strengths.consistency;
  }
  for (const need of req.needs) if (m.capabilities.includes(need)) s += 1;
  return s;
}

/**
 * Pick the top-`want` models to fan across — scored by fit, then spread for PROVIDER DIVERSITY. Decision
 * closure needs DIFFERENT takes (GPT vs Gemini vs Flux), not three variants of one family — so the first
 * pass takes the best model per provider, then fills any remaining slots with the next-best overall.
 */
export function pickFanout(survivors: ImageModel[], req: RoutingRequest, want: number): ImageModel[] {
  const scored = survivors
    .map((m) => ({ m, s: scoreModelForRequest(m, req) }))
    .sort((a, b) => b.s - a.s);
  const chosen: ImageModel[] = [];
  const usedProviders = new Set<string>();
  for (const { m } of scored) {
    if (chosen.length >= want) break;
    if (usedProviders.has(m.provider)) continue;
    chosen.push(m);
    usedProviders.add(m.provider);
  }
  for (const { m } of scored) {
    if (chosen.length >= want) break;
    if (!chosen.includes(m)) chosen.push(m);
  }
  return chosen;
}

/**
 * MULTI-MODEL fan-out: render across the top-`fanModels` models (by live fit score + provider
 * diversity), each producing `perModel` images — the N×M grid that gives decision closure. Autonomous
 * and self-maintaining (scores the current registry), never a static rating. Never dead-ends: fewer
 * survivors than asked just fans across what exists.
 */
export function deterministicFanout(
  req: RoutingRequest,
  survivors: ImageModel[],
  dropped: DroppedModel[]
): RoutingDecision | null {
  if (survivors.length === 0) return null;
  const want = Math.max(1, req.fanModels ?? 1);
  const per = Math.max(1, req.perModel ?? 1);
  const fanout: RoutedModel[] = pickFanout(survivors, req, want).map((m) => ({
    modelId: m.id,
    n: per,
    rationale: `Fan-out pick — ${m.label} (tier ${m.tier}, best fit for this request).`,
    score: scoreModelForRequest(m, req),
  }));
  return { primary: fanout[0], fanout, dropped, estCostUsd: estimateCost(fanout) };
}

/* ── Gate 2 — LLM rank over survivors ──────────────────────────────────────── */

const RANK_SYSTEM = `You are the routing oracle for an image-generation coordinator.
You are given a user's creative intent and a catalog of candidate image models (each with a brief describing what it is best at). Choose the best model — or a small multi-model fan-out — to fulfil the request, and split the requested image COUNT across them.

Rules:
- Prefer ONE model unless a spread genuinely serves the user (e.g. "show me different directions" → 2-3 diverse models).
- Assign each chosen model an integer n ≥ 1; the n values MUST sum to exactly the requested count.
- Every chosen modelId MUST be one of the candidate ids. Never invent an id.
- Give a one-sentence rationale per chosen model, grounded in its brief.

Respond with ONLY a JSON object, no prose:
{"fanout":[{"modelId":"<id>","n":<int>,"rationale":"<one sentence>"}]}`;

/** Build the candidate block the ranker reads. */
function candidateBrief(m: ImageModel): string {
  return `- ${m.id} | ${m.label} | tier ${m.tier} | $${m.costPerImageUsd[0]}-${m.costPerImageUsd[1]}/img | ${m.brief}`;
}

/**
 * Full route: Gate 1 filter → Gate 2 LLM rank (with deterministic fallback).
 * `client` is injectable so callers can pass a shared Anthropic instance (and tests
 * can pass a stub). Returns null only when Gate 1 leaves NO survivors.
 */
export async function route(
  req: RoutingRequest,
  opts: { client?: Anthropic; hasKey?: HasKey; catalog?: ImageModel[] } = {}
): Promise<RoutingDecision | null> {
  const { survivors, dropped } = gate1Filter(req, opts.hasKey, opts.catalog);
  if (survivors.length === 0) return null;
  // Explicit fan-out (Slice 1): fan across the top-N survivors deterministically. Slice 2 makes WHICH
  // N an intelligent, scored choice — this is the engine floor that proves N-model parallel render.
  if ((req.fanModels ?? 1) > 1) return deterministicFanout(req, survivors, dropped);
  if (survivors.length === 1) return deterministicRoute(req, survivors, dropped);

  const client = opts.client ?? new Anthropic();
  try {
    // `thinking: 'adaptive'` isn't in this SDK version's types yet — same `as any`
    // workaround the chat-turn route uses for the adaptive-thinking param.
    const rankParams = {
      model: MODEL,
      max_tokens: 500,
      thinking: { type: 'adaptive' },
      system: RANK_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `INTENT: ${req.intent}\n` +
            `IMAGE COUNT: ${req.count}\n` +
            (req.aspectRatio ? `ASPECT: ${req.aspectRatio}\n` : '') +
            `\nCANDIDATES:\n${survivors.map(candidateBrief).join('\n')}`,
        },
      ],
    };
    const msg = await client.messages.create(rankParams as any);

    const text = (msg.content ?? [])
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const fanout = parseFanout(text, survivors, req.count);
    if (fanout.length === 0) return deterministicRoute(req, survivors, dropped);
    return { primary: fanout[0], fanout, dropped, estCostUsd: estimateCost(fanout) };
  } catch {
    // Ranker unavailable — never dead-end; fall back to the deterministic pick.
    return deterministicRoute(req, survivors, dropped);
  }
}

/**
 * Tolerantly parse the ranker's JSON. Drops entries whose modelId isn't a survivor,
 * coerces n to a positive int, and rebalances so the n values sum to `count`.
 * Exported for unit testing (the riskiest parsing logic).
 */
export function parseFanout(
  text: string,
  survivors: ImageModel[],
  count: number
): RoutedModel[] {
  const ids = new Set(survivors.map((m) => m.id));
  let parsed: unknown;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text);
  } catch {
    return [];
  }

  const raw = (parsed as { fanout?: unknown })?.fanout;
  if (!Array.isArray(raw)) return [];

  const cleaned: RoutedModel[] = [];
  for (const e of raw) {
    const modelId = (e as { modelId?: unknown })?.modelId;
    if (typeof modelId !== 'string' || !ids.has(modelId)) continue;
    const nRaw = Number((e as { n?: unknown })?.n);
    const n = Number.isFinite(nRaw) ? Math.max(1, Math.floor(nRaw)) : 1;
    const rationale =
      typeof (e as { rationale?: unknown })?.rationale === 'string'
        ? ((e as { rationale: string }).rationale)
        : 'Selected by the routing oracle.';
    cleaned.push({ modelId, n, rationale });
  }
  if (cleaned.length === 0) return [];

  // Rebalance the n values so they sum to exactly `count` (trim overflow, pad the first).
  const target = Math.max(1, count);
  let sum = cleaned.reduce((s, r) => s + r.n, 0);
  while (sum > target) {
    const trimmable = [...cleaned].reverse().find((r) => r.n > 1);
    if (!trimmable) break;
    trimmable.n -= 1;
    sum -= 1;
  }
  if (sum < target) {
    cleaned[0].n += target - sum;
  }
  return cleaned;
}
