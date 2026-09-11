/**
 * FORMULA MIGRATION — carrying a user's work across a change of prompt formula.
 *
 * Real per-model formulas mean the builder's SHAPE changes: Gemini teaches Subject·Action·Location·
 * Composition·Style; xAI teaches Subject·Action·Setting·Camera·Lighting·Mood; a doctrine pass can
 * re-shape either overnight when a provider edits their guide. Without migration, switching models
 * (or a routine doctrine refresh) would silently blank fields the user had written — the worst kind
 * of cage: one that eats your work.
 *
 * So values move by MEANING, not just by id:
 *   1. same id            — 'subject' → 'subject'
 *   2. same semantic group — 'context' → 'location' → 'setting' (all say WHERE)
 *   3. absorbed           — a model with no 'lighting' part folds it into 'style'; no 'camera' folds
 *                           into 'composition'. Merged text is joined, never overwritten.
 * Anything that still has nowhere to go is REPORTED as `unmapped`, never silently dropped — the
 * caller surfaces it so the user can re-place their own words.
 *
 * Pure + deterministic → unit-tested.
 */

import type { PromptFormula } from './model-registry';

/** Parts that mean the same thing across model vocabularies. */
const GROUPS: string[][] = [
  ['subject', 'main-subject', 'focal-point'],
  ['action', 'motion', 'pose', 'activity'],
  ['location', 'context', 'setting', 'environment', 'scene', 'background', 'place'],
  ['composition', 'camera', 'framing', 'shot', 'angle', 'lens', 'perspective'],
  ['style', 'aesthetic', 'medium', 'look', 'art-style'],
  ['lighting', 'light', 'illumination'],
  ['mood', 'atmosphere', 'tone', 'feeling'],
  ['text', 'typography', 'copy', 'lettering'],
  ['color', 'palette', 'grade', 'color-grade'],
];

/** When a target formula has no home for a group, fold it into this one (the model's guide covers
 *  it there — e.g. Gemini's Style guidance explicitly includes lighting and color grade). */
const ABSORBED_BY: Record<string, string[]> = {
  lighting: ['style', 'mood', 'composition'],
  mood: ['style', 'lighting'],
  color: ['style', 'lighting'],
  camera: ['composition'],
  // A model with no dedicated Style part (xAI teaches Lighting + Mood instead) still needs the
  // user's look description to REACH the render — merging keeps it in the prompt, where unmapped
  // would silently exclude it until the user intervened. The merge is always noted.
  style: ['mood', 'lighting', 'composition'],
  text: ['subject', 'style'],
};

const groupOf = (id: string): string | null => {
  const key = id.trim().toLowerCase();
  const g = GROUPS.find((grp) => grp.includes(key));
  return g ? g[0] : null;
};

export interface MigratedValues {
  /** New part id → carried value. */
  values: Record<string, string>;
  /** Old parts whose text had nowhere to land — surfaced, never dropped silently. */
  unmapped: { id: string; label: string; value: string }[];
  /** Human notes about merges, so a fold-in is visible rather than mysterious. */
  notes: string[];
}

export interface PriorPart {
  id: string;
  label?: string;
  value: string;
}

/**
 * Carry prior part values onto a new formula. Non-destructive: every non-empty value either lands
 * on a part, merges into an absorbing part, or is reported in `unmapped`.
 */
export function migrateFormulaValues(prior: PriorPart[], next: PromptFormula): MigratedValues {
  const out: MigratedValues = { values: {}, unmapped: [], notes: [] };
  const filled = prior.filter((p) => p.value?.trim());
  if (filled.length === 0) return out;

  const nextIds = next.parts.map((p) => p.id);
  const nextByGroup = new Map<string, string>();
  for (const p of next.parts) {
    const g = groupOf(p.id);
    if (g && !nextByGroup.has(g)) nextByGroup.set(g, p.id);
  }
  const labelOf = (id: string) => next.parts.find((p) => p.id === id)?.label ?? id;

  const append = (targetId: string, text: string) => {
    out.values[targetId] = out.values[targetId] ? `${out.values[targetId]}, ${text}` : text;
  };

  for (const p of filled) {
    const value = p.value.trim();

    // 1. exact id
    if (nextIds.includes(p.id)) {
      append(p.id, value);
      continue;
    }
    // 2. same meaning, different vocabulary
    const group = groupOf(p.id);
    const sameGroup = group ? nextByGroup.get(group) : undefined;
    if (sameGroup) {
      append(sameGroup, value);
      if (sameGroup !== p.id) out.notes.push(`"${p.label ?? p.id}" carried over into ${labelOf(sameGroup)}.`);
      continue;
    }
    // 3. absorbed by a broader part
    const absorbers = group ? (ABSORBED_BY[group] ?? []) : [];
    const target = absorbers.map((a) => nextByGroup.get(a)).find(Boolean);
    if (target) {
      append(target, value);
      out.notes.push(`This model folds ${p.label ?? p.id} into ${labelOf(target)} — merged there.`);
      continue;
    }
    out.unmapped.push({ id: p.id, label: p.label ?? p.id, value });
  }

  if (out.unmapped.length > 0) {
    const names = out.unmapped.map((u) => u.label).join(', ');
    out.notes.push(`This model's formula has no equivalent for: ${names}. Your text is kept — re-place it where it fits.`);
  }
  return out;
}

/** Do two formulas have the same shape? (Skip a migration when nothing actually changed.) */
export function sameShape(a: PromptFormula | undefined, b: PromptFormula | undefined): boolean {
  if (!a || !b) return a === b;
  return a.parts.length === b.parts.length && a.parts.every((p, i) => p.id === b.parts[i].id);
}
