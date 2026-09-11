/**
 * PROMPT COMPILATION — one brief, N models.
 *
 * The trap this avoids: fanning across five models does NOT mean authoring five prompts. Five
 * editors to keep in sync is five times the work for one image, and it guarantees drift. The user
 * writes ONE brief in the lead model's formula; every other model in the fan gets that same brief
 * COMPILED into its own documented shape (Gemini's Location, xAI's Setting/Camera/Lighting/Mood),
 * reusing the value migration that already exists.
 *
 * A "lens" is therefore a VIEW of one document, never a separate document — except when the user
 * deliberately overrides one model (divergence). That override is opt-in, marked, and reversible:
 * the default is one brief, the backdoor exists for when Ideogram genuinely needs shorter copy than
 * everyone else.
 *
 * Pure + deterministic → unit-tested.
 */

import type { ImageModel, PromptFormula } from './model-registry';
import { migrateFormulaValues, sameShape, type PriorPart } from './formula-migration';
import { getModelFormula } from './model-registry';

export interface CompiledPart {
  id: string;
  label: string;
  guidance: string;
  weight: number;
  value: string;
}

export interface CompiledPrompt {
  modelId: string;
  modelLabel: string;
  parts: CompiledPart[];
  /** The assembled prompt string this model would receive. */
  assembled: string;
  /** True when this model's formula matches the lead's (nothing was re-shaped). */
  identical: boolean;
  /** Human notes about merges/folds, so a re-shape is visible rather than mysterious. */
  notes: string[];
  /** Values with no home in this model's formula — surfaced, never silently dropped. */
  unmapped: { id: string; label: string; value: string }[];
  /** True when the user has deliberately overridden this model's values. */
  diverged: boolean;
}

/** The model's effective formula: its doctrine-distilled one if provided, else registry, else default. */
export function formulaFor(model: ImageModel, doctrineFormula?: PromptFormula | null): PromptFormula {
  return doctrineFormula ?? model.promptFormula ?? getModelFormula(model.id);
}

/**
 * Compile the canonical brief into one model's formula. `override` (a diverged lens's own values)
 * wins over the compiled values for the parts it defines — divergence is per-part, so a user who
 * only rewrote Style keeps every other part in sync with the brief.
 */
export function compileFor(
  model: ImageModel,
  leadFormula: PromptFormula,
  leadValues: Record<string, string>,
  opts: { doctrineFormula?: PromptFormula | null; override?: Record<string, string> } = {},
): CompiledPrompt {
  const formula = formulaFor(model, opts.doctrineFormula);
  const identical = sameShape(leadFormula, formula);

  let values: Record<string, string>;
  let notes: string[] = [];
  let unmapped: CompiledPrompt['unmapped'] = [];

  if (identical) {
    values = { ...leadValues };
  } else {
    const prior: PriorPart[] = leadFormula.parts.map((p) => ({ id: p.id, label: p.label, value: leadValues[p.id] ?? '' }));
    const migrated = migrateFormulaValues(prior, formula);
    values = migrated.values;
    notes = migrated.notes;
    unmapped = migrated.unmapped;
  }

  const override = opts.override ?? {};
  const diverged = Object.keys(override).length > 0;
  const parts: CompiledPart[] = formula.parts.map((p) => ({
    id: p.id,
    label: p.label,
    guidance: p.guidance,
    weight: p.weight,
    value: override[p.id] ?? values[p.id] ?? '',
  }));

  return {
    modelId: model.id,
    modelLabel: model.label,
    parts,
    assembled: parts.map((p) => p.value.trim()).filter(Boolean).join(', '),
    identical,
    notes,
    unmapped,
    diverged,
  };
}

/** Compile the brief for every model in the fan — the lead first (it IS the brief). */
export function compileFan(
  models: ImageModel[],
  leadId: string,
  leadValues: Record<string, string>,
  opts: {
    doctrineFormulas?: Map<string, PromptFormula>;
    overrides?: Record<string, Record<string, string>>;
  } = {},
): CompiledPrompt[] {
  const lead = models.find((m) => m.id === leadId) ?? models[0];
  if (!lead) return [];
  const leadFormula = formulaFor(lead, opts.doctrineFormulas?.get(lead.id));
  const ordered = [lead, ...models.filter((m) => m.id !== lead.id)];
  return ordered.map((m) =>
    compileFor(m, leadFormula, leadValues, {
      doctrineFormula: opts.doctrineFormulas?.get(m.id),
      override: opts.overrides?.[m.id],
    }),
  );
}
