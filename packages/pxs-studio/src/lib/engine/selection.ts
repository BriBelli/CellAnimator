/**
 * MODEL SELECTION — the ROSTER / Orient engine. This is the foundation: choosing WHICH models render is
 * not a tier grab, it's a reasoned, cross-validated act.
 *
 * The failure it replaces: scoring `tier*2 + a few signals`, which always hands the request to the same
 * high-tier generalists — "the obvious grab" — regardless of what the render actually is. A vector logo
 * and a photoreal portrait got the same three flagships.
 *
 * The philosophy (Statue / OODA-Orient): understand the request as a CLASS, then CROSS-VALIDATE each
 * candidate from THREE INDEPENDENT ANGLES that must broadly AGREE before a model is trusted —
 *   A) axis alignment   — the model's researched craft strengths vs the axes this render needs,
 *   B) corroboration    — the model's OWN capability tags confirm the specialist need (not just a high
 *                          number on an axis — a genuine flag for it),
 *   C) prior            — tier, but only a WEAK nudge, never the driver.
 * A pick is "confident" only when A and B agree. Then the fan is spread for genuine DIVERSITY of
 * approach ("the top cabinets for X" — different specialists), so the multi-model fan gives real
 * decision closure instead of three clones of the flagship.
 *
 * Grounded (reads the registry's researched strengths — self-maintaining, not a hand-typed rating) and
 * transparent (every pick carries the axes that WON it). No prompt NLP here — the agent already reasoned
 * the prompt into structured `needs`; semantic nuance is the Gate-2 ranker's job.
 */

import type { ImageModel, ModelStrengths, Capability } from './model-registry';
import type { RoutingRequest } from './routing';

const AXES: (keyof ModelStrengths)[] = [
  'photorealism',
  'prompt_adherence',
  'editing',
  'style_versatility',
  'text_rendering',
  'speed',
  'resolution',
  'consistency',
  'multimodal',
];

export interface RequestProfile {
  /** 0..1 weight per craft axis — how much THIS render needs each. */
  weights: Record<keyof ModelStrengths, number>;
  /** The structured needs (capabilities) the agent reasoned — corroborates specialists (angle B). */
  needs: Capability[];
  /** References anchor the render → identity/compose consistency dominates. */
  referenceDriven: boolean;
}

/**
 * CLASSIFY a request into the craft axes it needs — from STRUCTURED signals only (the agent's `needs`,
 * references, editing, resolution). No prompt-string parsing: the Image agent already turned the prompt
 * into `needs`; re-doing NLP here would double-guess it. Every render needs baseline prompt-adherence +
 * some resolution; the rest is lit up by what the request declares.
 */
export function classifyRequest(req: RoutingRequest): RequestProfile {
  const w: Record<keyof ModelStrengths, number> = {
    photorealism: 0,
    prompt_adherence: 0.6, // every render needs the model to actually follow the brief
    editing: 0,
    style_versatility: 0,
    text_rendering: 0,
    speed: 0,
    resolution: 0.35,
    consistency: 0,
    multimodal: 0,
  };
  const needs = req.needs ?? [];
  const bump = (k: keyof ModelStrengths, v: number) => {
    w[k] = Math.min(1, w[k] + v);
  };
  for (const n of needs) {
    if (n === 'photorealism') bump('photorealism', 1);
    else if (n === 'text_in_image') bump('text_rendering', 1);
    else if (n === 'vector') bump('style_versatility', 0.8);
    else if (n === 'multi_reference') {
      bump('multimodal', 1);
      bump('consistency', 0.8);
    } else if (n === 'editing') bump('editing', 1);
    else if (n === 'high_resolution') bump('resolution', 0.8);
    else if (n === 'fast') bump('speed', 0.7);
    else if (n === 'cheap') bump('speed', 0.3);
  }
  const referenceDriven = (req.references?.length ?? 0) > 0;
  if (referenceDriven) {
    bump('multimodal', 0.8);
    bump('consistency', 1); // holding the identity across the fan is the whole job
    bump('editing', 0.5);
  }
  if (req.editing) bump('editing', 1);
  return { weights: w, needs, referenceDriven };
}

export interface FitBreakdown {
  /** 0..1 cross-validated fit — the combined verdict. */
  score: number;
  /** Angle A — weighted average of the model's strength on the axes that matter. */
  alignment: number;
  /** Angle B — fraction of the request's needs the model's OWN capability tags confirm. */
  corroboration: number;
  /** Angle C — tier, as a weak prior. */
  prior: number;
  /** A and B agree above baseline → a corroborated pick, not a lucky high axis. */
  confident: boolean;
  /** The axes that drove the fit — the WHY, surfaced to the console/UI. */
  topAxes: (keyof ModelStrengths)[];
}

/**
 * CROSS-VALIDATE a model's fit for a classified request. Three independent angles; A is the driver, B
 * must corroborate for confidence, C only nudges. This is what separates a genuine specialist (strong
 * axis AND a matching capability flag) from a generalist that merely posts a high number everywhere.
 */
export function crossValidateFit(model: ImageModel, profile: RequestProfile): FitBreakdown {
  const s = model.strengths;
  const weightSum = AXES.reduce((a, k) => a + profile.weights[k], 0) || 1;

  // Angle A — weighted average of the model's strength on the axes that matter (0..1).
  let alignRaw = 0;
  const contrib: { axis: keyof ModelStrengths; c: number }[] = [];
  for (const k of AXES) {
    const c = profile.weights[k] * (s[k] / 5);
    alignRaw += c;
    if (profile.weights[k] > 0.15) contrib.push({ axis: k, c });
  }
  const alignment = alignRaw / weightSum;

  // Angle B — do the model's OWN capability tags confirm the needs? (a specialist flag, not just a
  // high axis). Empty needs → neutral (nothing to corroborate against).
  const caps = new Set<Capability>(model.capabilities);
  const corroboration =
    profile.needs.length === 0 ? 0.6 : profile.needs.filter((n) => caps.has(n)).length / profile.needs.length;

  // Angle C — tier as a WEAK prior only.
  const prior = model.tier / 3;

  const score = 0.6 * alignment + 0.28 * corroboration + 0.12 * prior;
  const confident = alignment >= 0.6 && corroboration >= 0.5;
  const topAxes = contrib.sort((a, b) => b.c - a.c).slice(0, 3).map((x) => x.axis);
  return { score, alignment, corroboration, prior, confident, topAxes };
}

function strengthVec(m: ImageModel): number[] {
  return AXES.map((k) => m.strengths[k] / 5);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export interface RosterPick {
  model: ImageModel;
  fit: FitBreakdown;
  rationale: string;
}

/**
 * Pick a DIVERSE roster of specialists for the profile. Best cross-validated fit first; then each next
 * slot maximizes (fit − redundancy), where redundancy penalizes a near-identical strength signature or
 * the same provider. The result is a fan of REAL alternatives — different cabinets that each bring
 * something — so comparing them is a genuine decision, not three variants of one model.
 */
export function pickRoster(models: ImageModel[], profile: RequestProfile, want: number): RosterPick[] {
  const scored = models
    .map((m) => ({ m, fit: crossValidateFit(m, profile) }))
    .sort((a, b) => b.fit.score - a.fit.score);
  if (scored.length === 0) return [];

  const chosen = [scored[0]];
  const pool = scored.slice(1);
  const LAMBDA = 0.35; // how hard redundancy is penalized against raw fit

  while (chosen.length < want && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let redundancy = 0;
      for (const c of chosen) {
        const sim = cosine(strengthVec(cand.m), strengthVec(c.m));
        const providerPenalty = cand.m.provider === c.m.provider ? 0.25 : 0;
        redundancy = Math.max(redundancy, sim + providerPenalty);
      }
      const val = cand.fit.score - LAMBDA * redundancy;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    chosen.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }

  return chosen.map(({ m, fit }) => ({ model: m, fit, rationale: rationaleFor(m, fit) }));
}

function rationaleFor(m: ImageModel, fit: FitBreakdown): string {
  const axes = fit.topAxes.map((a) => a.replace(/_/g, ' ')).join(', ');
  const conf = fit.confident ? 'strong, corroborated match' : 'partial match';
  return `${m.label} — ${conf}${axes ? ` on ${axes}` : ''} (fit ${Math.round(fit.score * 100)}).`;
}
