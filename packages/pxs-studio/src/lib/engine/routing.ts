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
import { classifyRequest, crossValidateFit, pickRoster } from './selection';

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
  /** MANUAL model pick (the picker UI): fan across EXACTLY these model ids (those that survive Gate 1).
   *  Overrides the auto top-N. Empty/absent → auto. Never dead-ends — if none survive, falls back to auto. */
  models?: string[];
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
    // REFERENCES: keep any model that can ACCEPT this many references — accepting a reference is NOT
    // the same as "multi_reference" (composing from >1). A single ref only needs capacity >= 1. This is
    // what wrongly benched Flux/etc. (they take references fine). Capacity = the flat pool, or the sum of
    // typed per-role pools. NOTE: the counts themselves live in the registry and must be kept ACCURATE by
    // the Model agent — a wrong count here is a data bug, not a routing bug.
    if (req.references && req.references.length > 0) {
      const capacity = m.referenceLimits
        ? m.referenceLimits.object + m.referenceLimits.character + m.referenceLimits.style
        : m.maxReferenceImages;
      if (capacity < req.references.length) {
        dropped.push({ modelId: m.id, reason: 'missing_capability' });
        continue;
      }
    }
    if (req.editing && !m.supportsEditing) {
      dropped.push({ modelId: m.id, reason: 'no_edit' });
      continue;
    }
    // ASPECT is NOT a hard bench. A model's hand-typed aspectRatios list is a data hint, not a hard
    // wall — nearly every image model accepts an arbitrary ratio (or snaps to the nearest), and the
    // reference-fit already letterboxes onto the target frame. Benching gpt/grok because their list
    // happens to omit "3:4" is exactly the hand-typed-data-collapses-the-fan bug: it left one Gemini
    // model standing on a portrait character sheet. Aspect is handled downstream (adapter clamps); a
    // ratio the model doesn't list only costs a small score nudge (scoreModelForRequest), never a drop.
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
 * Deterministic single pick — the best CROSS-VALIDATED fit takes the whole count (not "highest tier").
 * Used when Gate 2's LLM call is unavailable, when only one model is asked for, so routing never
 * dead-ends AND the single pick is still the right specialist for the class.
 */
export function deterministicRoute(
  req: RoutingRequest,
  survivors: ImageModel[],
  dropped: DroppedModel[]
): RoutingDecision | null {
  if (survivors.length === 0) return null;
  const [best] = pickRoster(survivors, classifyRequest(req), 1);
  const primary: RoutedModel = {
    modelId: best.model.id,
    n: Math.max(1, req.count),
    rationale: best.rationale,
    score: best.fit.score,
  };
  return { primary, fanout: [primary], dropped, estCostUsd: estimateCost([primary]) };
}

/**
 * A model's FIT for THIS request — the cross-validated verdict (0..1), NOT a tier grab. Delegates to the
 * roster engine: classify the request into the craft axes it needs, then score the model on axis
 * alignment corroborated by its own capability tags (tier is only a weak prior). Kept as the public
 * scoring entry point; the exact reasoning lives in `selection.ts`.
 */
export function scoreModelForRequest(m: ImageModel, req: RoutingRequest): number {
  return crossValidateFit(m, classifyRequest(req)).score;
}

/**
 * MULTI-MODEL fan-out — the ROSTER: render across the top-`fanModels` models chosen by cross-validated
 * fit AND spread for genuine diversity of approach (different specialists / cabinets), so the fan is real
 * alternatives, not clones of the flagship. Autonomous + self-maintaining (reads researched strengths),
 * never a static rating. Never dead-ends: fewer survivors than asked just fans across what exists.
 */
export function deterministicFanout(
  req: RoutingRequest,
  survivors: ImageModel[],
  dropped: DroppedModel[]
): RoutingDecision | null {
  if (survivors.length === 0) return null;
  const want = Math.max(1, req.fanModels ?? 1);
  const per = Math.max(1, req.perModel ?? 1);
  const fanout: RoutedModel[] = pickRoster(survivors, classifyRequest(req), want).map((p) => ({
    modelId: p.model.id,
    n: per,
    rationale: p.rationale,
    score: p.fit.score,
  }));
  return { primary: fanout[0], fanout, dropped, estCostUsd: estimateCost(fanout) };
}

/* ── Gate 2 — LLM rank over survivors ──────────────────────────────────────── */

const RANK_SYSTEM = `You are the routing oracle for an image-generation coordinator — the Model agent's Orient step.
You are given a user's creative intent, the CLASS PROFILE it was classified into (the craft axes it needs), and candidate models. Each candidate carries a pre-computed CROSS-VALIDATED fit (axis alignment · capability corroboration · a weak tier prior) plus what it is genuinely best at. Choose the model — or a small diverse fan-out — that is the right SPECIALIST for this class.

Reason like the roster, not the leaderboard:
- Pick the genuine specialist for the CLASS. Do NOT default to the highest tier / flagship — a vector-logo request wants the vector/typography specialist even if a flagship generalist scores a high raw number.
- Trust the cross-validation: prefer a candidate whose fit is CORROBORATED (axis strength AND a matching capability), over one riding a single high axis or tier alone.
- If you fan across more than one, make them genuinely DIFFERENT approaches (different cabinets), not near-duplicates — that's what makes comparing them a real decision.
- Assign each chosen model an integer n ≥ 1; the n values MUST sum to exactly the requested count.
- Every chosen modelId MUST be one of the candidate ids. Never invent an id.
- One-sentence rationale per pick, grounded in the class + its strengths (not "it's the best model").

Respond with ONLY a JSON object, no prose:
{"fanout":[{"modelId":"<id>","n":<int>,"rationale":"<one sentence>"}]}`;

/** Build the candidate block the ranker reads — grounded in the CROSS-VALIDATED fit (not tier alone),
 *  so the LLM reasons over the same evidence the deterministic roster does. */
function candidateBrief(m: ImageModel, req: RoutingRequest): string {
  const fit = crossValidateFit(m, classifyRequest(req));
  const axes = fit.topAxes.map((a) => a.replace(/_/g, ' ')).join(', ');
  const corr = fit.confident ? 'corroborated' : 'uncorroborated';
  return (
    `- ${m.id} | ${m.label} | tier ${m.tier} | $${m.costPerImageUsd[0]}-${m.costPerImageUsd[1]}/img\n` +
    `    fit ${Math.round(fit.score * 100)} (${corr}; strong on ${axes || 'general craft'}) | best for: ${m.bestFor.join(', ')}\n` +
    `    ${m.brief}`
  );
}

/** One-line summary of the request's classified craft profile — the axes it needs, heaviest first. */
function describeProfile(req: RoutingRequest): string {
  const p = classifyRequest(req);
  const top = (Object.entries(p.weights) as [keyof typeof p.weights & string, number][])
    .filter(([, w]) => w > 0.15)
    .sort((a, b) => b[1] - a[1])
    .map(([k, w]) => `${k.replace(/_/g, ' ')} ${w.toFixed(1)}`);
  return top.join(', ') || 'general';
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
  // MANUAL pick (the picker UI) — fan across EXACTLY the chosen models that survive Gate 1. Never a
  // dead-end: if none of the picks survive, fall through to the auto pick below.
  if (req.models && req.models.length > 0) {
    const chosen = survivors.filter((m) => req.models!.includes(m.id));
    if (chosen.length > 0) {
      const per = Math.max(1, req.perModel ?? 1);
      const fanout: RoutedModel[] = chosen.map((m) => ({
        modelId: m.id,
        n: per,
        rationale: `Manual pick — ${m.label}.`,
        score: scoreModelForRequest(m, req),
      }));
      return { primary: fanout[0], fanout, dropped, estCostUsd: estimateCost(fanout) };
    }
  }
  // Explicit fan-out (auto): fan across the top-N survivors by live fit + provider diversity.
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
            `CLASS PROFILE (axes it needs): ${describeProfile(req)}\n` +
            `\nCANDIDATES:\n${survivors.map((m) => candidateBrief(m, req)).join('\n')}`,
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
