/**
 * PROMPT SCORING — two honest axes, never one fake number.
 *
 * What this replaces: a single "Prompt quality" percentage computed as `min(1, words/10)` per part.
 * Ten words of anything scored a part at 100%, so filler read as excellence and the ring was
 * theatre — it measured TYPING, not craft, and it could never be wrong out loud.
 *
 * The honest split:
 *   · STRUCTURE (here) — deterministic, free, instant: are this model's formula parts actually
 *     populated, with enough specificity to be worth sending? It is CAPPED (see STRUCTURE_CAP)
 *     because completeness alone cannot earn "excellent": a fully-filled prompt of vague words is a
 *     complete prompt, not a good one. This axis is always labelled "structure", never "quality".
 *   · CRAFT (agents/model-agent/craft-critique.ts) — the real judgement: the assembled prompt read
 *     against THAT model's distilled doctrine (its own published guide), returning a score WITH the
 *     reasons and the fixes, each grounded in a doctrine line. Only craft can reach the top band.
 *
 * The rule this file exists to enforce: a number the user can't interrogate is a lie. Structure says
 * only what it can prove; craft has to show its work.
 *
 * Pure + deterministic → unit-tested.
 */

export type ScoreBand = 'thin' | 'good' | 'strong';

/** Structure can never exceed this — the ceiling only a craft judgement can lift. */
export const STRUCTURE_CAP = 70;

/** One part's current content, as the user has shaped it. */
export interface ScoredPartInput {
  id: string;
  /** The part's weight in the model's formula (heavier parts move the overall score more). */
  weight: number;
  /** The free-text value. */
  value: string;
  /** Added anchor chips. */
  anchors: string[];
}

export interface PartScore {
  id: string;
  raw: number; // 0..1
  band: ScoreBand;
  /** Why this part reads thin — shown on the part, so a band is never unexplained. */
  reason?: string;
}

export interface BuilderScore {
  parts: PartScore[];
  /** 0–STRUCTURE_CAP, weighted across parts. NOT a quality percentage. */
  overall: number;
  overallBand: ScoreBand;
  /** How many parts are at least 'good' (the "N/N parts" readout). */
  filled: number;
  total: number;
}

/** Words that fill space without adding an instruction the model can act on. */
const FILLER = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are',
  'be', 'very', 'really', 'nice', 'good', 'great', 'beautiful', 'amazing', 'stunning', 'cool',
  'awesome', 'perfect', 'best', 'high', 'quality', 'detailed', 'realistic', 'it', 'its', 'this',
  'that', 'some', 'thing', 'things', 'stuff',
]);

/**
 * A single part's raw 0..1 strength. Measures SUBSTANCE, not length: only distinct, non-filler words
 * count, so "very beautiful amazing stunning quality" scores near zero while five concrete words
 * score well. Repetition is deduped — the old curve rewarded padding.
 */
export function scorePart(value: string, anchors: string[]): { raw: number; band: ScoreBand; reason?: string } {
  const text = [value, ...anchors].join(' ').trim();
  if (!text) return { raw: 0, band: 'thin', reason: 'Empty — this part is not reaching the model.' };

  const words = text.toLowerCase().split(/[^a-z0-9'-]+/).filter(Boolean);
  const substantive = new Set(words.filter((w) => w.length > 2 && !FILLER.has(w)));
  const count = substantive.size;
  // Full strength at ~6 distinct substantive words — concrete direction, not word count.
  const raw = Math.min(1, count / 6);

  let reason: string | undefined;
  if (count === 0) reason = 'Only filler words — nothing here directs the model.';
  else if (words.length >= 8 && count / words.length < 0.35) reason = 'Mostly filler — trim it to the concrete direction.';
  else if (count < 3) reason = 'Thin — add specific, visible detail.';

  return { raw, band: bandOf(raw), reason };
}

/** Map a 0..1 strength onto a band. */
export function bandOf(raw: number): ScoreBand {
  if (raw < 0.4) return 'thin';
  if (raw < 0.78) return 'good';
  return 'strong';
}

/**
 * Score the STRUCTURE of the builder — per-part bands + a weighted overall, capped at STRUCTURE_CAP.
 * A "strong" structure band means "complete and specific enough to send", never "this is excellent".
 */
export function scoreBuilder(parts: ScoredPartInput[]): BuilderScore {
  let weightSum = 0;
  let acc = 0;
  const scored: PartScore[] = parts.map((p) => {
    const { raw, band, reason } = scorePart(p.value, p.anchors);
    const w = p.weight > 0 ? p.weight : 1;
    weightSum += w;
    acc += raw * w;
    return { id: p.id, raw, band, reason };
  });
  const ratio = weightSum > 0 ? acc / weightSum : 0;
  const overall = Math.round(ratio * STRUCTURE_CAP);
  const filled = scored.filter((s) => s.band !== 'thin').length;
  return {
    parts: scored,
    overall,
    overallBand: ratio < 0.45 ? 'thin' : ratio < 0.8 ? 'good' : 'strong',
    filled,
    total: parts.length,
  };
}

/** Human label for a structure band — deliberately about COMPLETENESS, not quality. */
export function bandLabel(band: ScoreBand): string {
  return band === 'strong' ? 'Complete' : band === 'good' ? 'Taking shape' : 'Thin';
}
