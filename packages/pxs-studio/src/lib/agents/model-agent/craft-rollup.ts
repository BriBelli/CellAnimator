/**
 * CRAFT ROLLUP — what only a FAN can tell you.
 *
 * One model's critique tells you how to please one model. N critiques tell you something better:
 * which weaknesses are UNIVERSAL (every model flags your Location — that's a real craft problem, fix
 * it once and every render improves) versus MODEL-SPECIFIC (only Ideogram cares that you're over its
 * word budget — a compile detail, not a flaw in your brief).
 *
 * That separation is the actual payoff of fanning out at the prompt layer, and it's impossible with
 * a single model. It turns N scores — which would just be noise competing for the same real estate —
 * into one prioritized list of what to do next.
 *
 * Pure + deterministic → unit-tested.
 */

import type { CraftResult, CraftFinding, FindingSeverity } from './craft-critique';

export interface RollupFinding {
  /** The formula part it concerns ('' = the prompt as a whole). Lead-formula id where they agree. */
  partId: string;
  /** The clearest phrasing of the issue among the models that raised it. */
  issue: string;
  fix: string;
  severity: FindingSeverity;
  /** Which models raised it. */
  modelIds: string[];
  modelLabels: string[];
  /** True when a MAJORITY of judged models raised it — fix these first. */
  universal: boolean;
}

export interface CraftRollup {
  /** Models that returned a real critique. */
  judged: { modelId: string; modelLabel: string; score: number }[];
  /** Models with no doctrine yet (or a failed judge) — named, never hidden. */
  unavailable: { modelId: string; modelLabel: string; reason: string }[];
  /** Mean score across judged models — the fan's honest headline. */
  averageScore: number;
  /** Raised by a majority — fix once, everything improves. */
  universal: RollupFinding[];
  /** Raised by a minority — a compile detail for those models. */
  specific: RollupFinding[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { blocking: 0, weak: 1, polish: 2 };

/**
 * The grouping key. Findings about the SAME PART are treated as the same concern, because that is
 * the actionable unit the user acts on ("3 of 4 models flag your Location") and because natural
 * language defeats text matching — "the location is vague", "the location lacks specifics", and
 * "the location is vague here" are one problem written three ways, and no word-overlap heuristic
 * groups them reliably.
 *
 * Consequence, deliberately accepted: if one model raises two separate notes on the same part, the
 * rollup shows the more severe one. The ROLLUP is a summary; the per-lens critique still lists every
 * finding in full, so nothing is actually lost — it's just not repeated in the summary.
 *
 * Whole-prompt findings (no partId) have no such anchor, so they fall back to content words.
 */
function issueKey(f: CraftFinding): string {
  if (f.partId) return `part:${f.partId}`;
  const text = f.issue
    .toLowerCase()
    .replace(/["“”'’][^"“”'’]*["“”'’]/g, ' ') // the quoted user words differ per model — ignore them
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text.split(' ').filter((w) => w.length > 3).slice(0, 3).sort().join('-');
  return `all:${words}`;
}

/**
 * Roll N critiques into one prioritized picture. `partAliases` maps a model's part id back to the
 * lead formula's id (from the compile step), so "location"/"setting" findings group as one.
 */
export function rollupCritiques(
  results: CraftResult[],
  partAliases: Record<string, string> = {},
): CraftRollup {
  const judged = results.filter((r): r is Extract<CraftResult, { available: true }> => r.available);
  const unavailable = results
    .filter((r): r is Extract<CraftResult, { available: false }> => !r.available)
    .map((r) => ({ modelId: r.modelId, modelLabel: r.modelLabel, reason: r.reason }));

  const groups = new Map<string, RollupFinding>();
  for (const r of judged) {
    for (const f of r.findings) {
      const canonical = { ...f, partId: partAliases[f.partId] ?? f.partId };
      const key = issueKey(canonical);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          partId: canonical.partId,
          issue: canonical.issue,
          fix: canonical.fix,
          severity: canonical.severity,
          modelIds: [r.modelId],
          modelLabels: [r.modelLabel],
          universal: false,
        });
        continue;
      }
      if (!existing.modelIds.includes(r.modelId)) {
        existing.modelIds.push(r.modelId);
        existing.modelLabels.push(r.modelLabel);
      }
      // Keep the most severe reading (and ITS wording of the issue), plus the most actionable fix.
      if (SEVERITY_RANK[canonical.severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = canonical.severity;
        existing.issue = canonical.issue;
      }
      if (canonical.fix.length > existing.fix.length) existing.fix = canonical.fix;
    }
  }

  const threshold = Math.ceil(judged.length / 2); // a majority of judged models
  const all = [...groups.values()].map((g) => ({ ...g, universal: judged.length > 1 && g.modelIds.length >= threshold }));
  const order = (a: RollupFinding, b: RollupFinding) =>
    b.modelIds.length - a.modelIds.length || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];

  return {
    judged: judged.map((r) => ({ modelId: r.modelId, modelLabel: r.modelLabel, score: r.score })),
    unavailable,
    averageScore: judged.length > 0 ? Math.round(judged.reduce((n, r) => n + r.score, 0) / judged.length) : 0,
    universal: all.filter((g) => g.universal).sort(order),
    specific: all.filter((g) => !g.universal).sort(order),
  };
}
