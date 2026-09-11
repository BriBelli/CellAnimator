/**
 * VIDEO COST — estimating spend BEFORE committing to it.
 *
 * Why this exists as its own module: the image path prices a render as `costPerImage × count`, and
 * that shape simply does not describe video. Video cost is seconds × resolution, and the spread
 * inside one model is 20× (Seedance: $0.07/s at 480p, $1.37/s at 4K). A single 10-second 1080p clip
 * is $3.40 — most of the default $5 hard cap in ONE render, where an image is three cents.
 *
 * At that magnitude "generate and find out" is not an acceptable interaction. So this module answers
 * two questions before any money moves: what will this cost, and does it fit the budget left.
 *
 * IT NEVER SUBSTITUTES. An earlier version of this quietly downgraded an unaffordable 4K render to
 * 720p — the graceful-specialist rule misapplied to money. That rule is for CAPABILITY mismatches,
 * where the model simply cannot do what was asked; budget is not a capability, it is the user's own
 * decision about their own funds. Silently delivering something cheaper than what they asked for is
 * exactly the "never override user intent" failure, and it also spends their money on a thing they
 * did not choose.
 *
 * So: the request is priced, and if it does not fit we say so plainly and stop. What DOES fit is
 * reported as INFORMATION — the user (or the agent, out loud) decides whether to shorten it, drop a
 * resolution, or raise their cap. The choice stays theirs.
 *
 * Pure + deterministic → unit-tested, safe to call anywhere.
 */

import type { MediaModel } from './media-registry';

/** Cheapest → most expensive. Also the order a downgrade walks when a render doesn't fit. */
export const RESOLUTION_LADDER = ['480p', '720p', '1080p', '4k'] as const;
export type VideoResolution = (typeof RESOLUTION_LADDER)[number];

export interface VideoSpec {
  durationSec: number;
  resolution?: string;
  /** How many clips (a fan across models, or several takes of one). */
  count?: number;
}

export interface VideoEstimate {
  modelId: string;
  modelLabel: string;
  durationSec: number;
  resolution: string;
  count: number;
  /** USD per second at this resolution. */
  perSecondUsd: number;
  /** Total USD for the whole request. */
  totalUsd: number;
  /** True when the model publishes a per-resolution price; false = derived from its band (a guess
   *  we label as such rather than present as fact). */
  exact: boolean;
}

const round = (n: number) => Number(n.toFixed(3));

/** The per-second price for one model at one resolution. */
export function perSecondFor(model: MediaModel, resolution: string): { usd: number; exact: boolean } {
  const table = model.video?.costPerSecondByResolution;
  if (table && typeof table[resolution] === 'number') return { usd: table[resolution], exact: true };

  // No per-resolution table → interpolate across the model's published band by ladder position. It's
  // an estimate, and `exact: false` is how the caller knows not to quote it as a price.
  const band = model.video?.costPerSecondUsd;
  if (!band) return { usd: 0, exact: false };
  const i = RESOLUTION_LADDER.indexOf(resolution as VideoResolution);
  if (i < 0) return { usd: band[0], exact: false };
  const t = i / (RESOLUTION_LADDER.length - 1);
  return { usd: round(band[0] + (band[1] - band[0]) * t), exact: false };
}

/** What one video request will cost on one model. */
export function estimateVideoCost(model: MediaModel, spec: VideoSpec): VideoEstimate {
  const resolution = spec.resolution ?? '720p';
  const count = Math.max(1, spec.count ?? 1);
  const durationSec = Math.max(1, spec.durationSec);
  const { usd, exact } = perSecondFor(model, resolution);
  return {
    modelId: model.id,
    modelLabel: model.label,
    durationSec,
    resolution,
    count,
    perSecondUsd: usd,
    totalUsd: round(usd * durationSec * count),
    exact,
  };
}

export interface AffordabilityVerdict {
  affordable: boolean;
  estimate: VideoEstimate;
  /** The remaining budget this was judged against. */
  budgetUsd: number;
  /** How much MORE is needed to run the request as asked. 0 when it fits. */
  shortfallUsd: number;
  /**
   * ADVISORY ONLY — the largest version of this request that the remaining budget would cover.
   * This is shown so the user can decide; it is NEVER applied on their behalf. A caller that
   * substitutes this for `estimate` without an explicit user choice is overriding their intent.
   */
  wouldFit?: VideoEstimate;
  /** Plain language: what it costs, what's left, and what the options are. */
  message: string;
}

/**
 * Can this render be paid for? If not, say so and STOP — then report what the budget would cover, as
 * information for the user to act on. Nothing here is applied automatically.
 */
export function checkAffordable(model: MediaModel, spec: VideoSpec, budgetUsd: number): AffordabilityVerdict {
  const estimate = estimateVideoCost(model, spec);
  const money = (n: number) => `$${n.toFixed(2)}`;

  if (estimate.totalUsd <= budgetUsd) {
    return {
      affordable: true,
      estimate,
      budgetUsd,
      shortfallUsd: 0,
      message: `${estimate.durationSec}s at ${estimate.resolution} ≈ ${money(estimate.totalUsd)}${estimate.exact ? '' : ' (estimated)'}. ${money(budgetUsd)} available.`,
    };
  }

  const shortfallUsd = round(estimate.totalUsd - budgetUsd);
  const over = `${estimate.durationSec}s at ${estimate.resolution} costs ${money(estimate.totalUsd)} — ${money(shortfallUsd)} more than the ${money(budgetUsd)} left.`;

  // What the remaining budget WOULD cover, purely so the user can decide. Same resolution first
  // (shortening keeps the look), then lower resolutions — but nothing is chosen for them.
  const sameResSec = Math.floor(budgetUsd / Math.max(1e-9, estimate.perSecondUsd * estimate.count));
  if (sameResSec >= 1) {
    const wouldFit = estimateVideoCost(model, { ...spec, durationSec: sameResSec });
    return {
      affordable: false,
      estimate,
      budgetUsd,
      shortfallUsd,
      wouldFit,
      message: `${over} At ${estimate.resolution} your budget covers up to ${sameResSec}s (${money(wouldFit.totalUsd)}) — or raise your cap to run it as asked.`,
    };
  }

  const requestedIdx = RESOLUTION_LADDER.indexOf((spec.resolution ?? '720p') as VideoResolution);
  for (let i = requestedIdx - 1; i >= 0; i--) {
    const candidate = estimateVideoCost(model, { ...spec, resolution: RESOLUTION_LADDER[i] });
    if (candidate.totalUsd <= budgetUsd) {
      return {
        affordable: false,
        estimate,
        budgetUsd,
        shortfallUsd,
        wouldFit: candidate,
        message: `${over} The same length fits at ${candidate.resolution} (${money(candidate.totalUsd)}) — or raise your cap to run it at ${estimate.resolution}.`,
      };
    }
  }

  const floor = perSecondFor(model, RESOLUTION_LADDER[0]).usd;
  return {
    affordable: false,
    estimate,
    budgetUsd,
    shortfallUsd,
    message: `${over} ${money(budgetUsd)} does not cover any clip on ${estimate.modelLabel} (its floor is ${money(floor)}/second). Raise your cap to continue.`,
  };
}

/** Rank models by what this exact request costs on each — cheapest first. */
export function costRanked(models: MediaModel[], spec: VideoSpec): VideoEstimate[] {
  return models
    .filter((m) => m.modalities.includes('video'))
    .map((m) => estimateVideoCost(m, spec))
    .sort((a, b) => a.totalUsd - b.totalUsd);
}
