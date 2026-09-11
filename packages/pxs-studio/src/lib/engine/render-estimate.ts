/**
 * WHAT THIS RENDER WILL COST — one estimator for both media, so the number can be shown BEFORE the
 * user commits rather than discovered on the invoice.
 *
 * Image and video price on completely different axes (images: per image × count; video: per second ×
 * resolution), and video is roughly 50× an image per render. A single control surface that spends
 * either has to speak both, or it can only warn about one of them.
 *
 * This never blocks and never substitutes — it reports. The user decides whether the number is worth
 * it, adjusts the knobs that move it (models, count, duration, resolution), or raises their cap.
 *
 * Pure + deterministic → unit-tested, safe to call on every keystroke of the render controls.
 */

import { getModel, type ImageModel } from './model-registry';
import { MEDIA_MODELS } from './media-registry';
import { estimateVideoCost } from './video-cost';

export interface RenderPlan {
  medium: 'image' | 'video';
  /** Registry ids in the fan. */
  modelIds: string[];
  /** Images (or clips) PER model. */
  perModel: number;
  /** Video only. */
  durationSec?: number;
  resolution?: string;
}

export interface ModelLineItem {
  modelId: string;
  modelLabel: string;
  /** Units this model produces (images, or clips). */
  units: number;
  lowUsd: number;
  highUsd: number;
  /** False when the price is interpolated from a band rather than published per-tier. */
  exact: boolean;
}

export interface RenderEstimate {
  medium: 'image' | 'video';
  lines: ModelLineItem[];
  /** Cheapest plausible total. */
  lowUsd: number;
  /** Dearest plausible total — the number a warning should be based on. */
  highUsd: number;
  /** True when every line has a published price (so low/high is a range, not a guess). */
  exact: boolean;
  /** One line for the control surface, e.g. "4 clips · 10s · 1080p ≈ $13.60". */
  summary: string;
}

const round = (n: number) => Number(n.toFixed(3));
const money = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(2)}`;

/** Price a planned render across every model in the fan. */
export function estimateRender(plan: RenderPlan): RenderEstimate {
  const perModel = Math.max(1, plan.perModel);
  const lines: ModelLineItem[] = [];

  for (const id of plan.modelIds) {
    if (plan.medium === 'video') {
      const media = MEDIA_MODELS.find((m) => m.id === id);
      if (!media?.video) continue;
      const e = estimateVideoCost(media, {
        durationSec: plan.durationSec ?? 5,
        resolution: plan.resolution,
        count: perModel,
      });
      lines.push({ modelId: id, modelLabel: media.label, units: perModel, lowUsd: e.totalUsd, highUsd: e.totalUsd, exact: e.exact });
      continue;
    }
    const model: ImageModel | undefined = getModel(id);
    if (!model) continue;
    const [lo, hi] = model.costPerImageUsd;
    lines.push({
      modelId: id,
      modelLabel: model.label,
      units: perModel,
      lowUsd: round(lo * perModel),
      highUsd: round(hi * perModel),
      // Image models publish a BAND (quality/size tiers move the real price inside it), so a single
      // figure would be a guess dressed as a price. The range is the honest form.
      exact: lo === hi,
    });
  }

  const lowUsd = round(lines.reduce((n, l) => n + l.lowUsd, 0));
  const highUsd = round(lines.reduce((n, l) => n + l.highUsd, 0));
  const exact = lines.length > 0 && lines.every((l) => l.exact);
  const units = lines.reduce((n, l) => n + l.units, 0);

  const noun = plan.medium === 'video' ? (units === 1 ? 'clip' : 'clips') : units === 1 ? 'image' : 'images';
  const spec =
    plan.medium === 'video'
      ? ` · ${plan.durationSec ?? 5}s${plan.resolution ? ` · ${plan.resolution}` : ''}`
      : '';
  const price = lowUsd === highUsd ? money(highUsd) : `${money(lowUsd)}–${money(highUsd)}`;
  const summary = lines.length === 0 ? 'No models selected' : `${units} ${noun}${spec} ≈ ${price}`;

  return { medium: plan.medium, lines, lowUsd, highUsd, exact, summary };
}

export type BudgetVerdict = 'ok' | 'tight' | 'over';

export interface RenderAffordability {
  verdict: BudgetVerdict;
  estimate: RenderEstimate;
  remainingUsd: number;
  /** How much more is needed, on the DEAREST outcome. 0 unless `over`. */
  shortfallUsd: number;
  message: string;
}

/** Warn while there is still time to change something. `tight` = it fits, but only just. */
export function checkRenderBudget(plan: RenderPlan, remainingUsd: number, tightFraction = 0.5): RenderAffordability {
  const estimate = estimateRender(plan);

  if (estimate.highUsd > remainingUsd) {
    return {
      verdict: 'over',
      estimate,
      remainingUsd,
      shortfallUsd: round(estimate.highUsd - remainingUsd),
      // Says what it costs, what is left, and what to change — never picks a cheaper render for them.
      message: `${estimate.summary}, over the ${money(remainingUsd)} left. Reduce the models, count${plan.medium === 'video' ? ', length or resolution' : ''}, or raise your budget.`,
    };
  }
  if (remainingUsd > 0 && estimate.highUsd / remainingUsd >= tightFraction) {
    return {
      verdict: 'tight',
      estimate,
      remainingUsd,
      shortfallUsd: 0,
      message: `${estimate.summary} — that is most of the ${money(remainingUsd)} you have left.`,
    };
  }
  return {
    verdict: 'ok',
    estimate,
    remainingUsd,
    shortfallUsd: 0,
    message: `${estimate.summary} · ${money(remainingUsd)} available`,
  };
}
