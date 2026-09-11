/**
 * THE FEATURE MAP — "which model does X?", answered from evidence instead of a human crawling eight
 * documentation sites.
 *
 * Composed, never hand-typed. Two evidence sources, in priority order:
 *   1. DOCTRINE (strongest) — the model's own official docs, read in full, its features translated
 *      onto our controlled vocabulary with a native/technique support level (see task-vocabulary.ts).
 *   2. CAPABILITY TAGS (fallback) — the registry's researched capability axes, which imply a floor of
 *      task support even before a doctrine exists (a model tagged `vector` obviously does vectors).
 *
 * Anything neither source evidences is honestly `unsupported` — the system says "this model can't"
 * rather than routing a job to a model that will fumble it. That honesty is the whole point: it's
 * what makes "I want a character style sheet" a routable question, and what stops a user from
 * discovering a limitation only after they've paid for the render.
 *
 * Pure + deterministic (doctrines are passed in, not fetched) → unit-tested, safe anywhere.
 */

import type { ImageModel, Capability } from './model-registry';
import { IMAGE_TASKS, type ImageTask, type TaskSupport } from './task-vocabulary';
import type { ModelDoctrine } from '../agents/model-agent/doctrine';

/** One model's support for one task, with the receipts. */
export interface FeatureEntry {
  task: ImageTask;
  support: TaskSupport;
  /** How to do it (from the model's docs) — empty when only implied by capability tags. */
  how: string;
  /** Where the claim came from: 'doctrine' (its own docs) or 'capability' (researched tags). */
  evidence: 'doctrine' | 'capability' | 'none';
}

export type FeatureMap = Record<ImageTask, FeatureEntry>;

/**
 * The capability→task floor. Deliberately CONSERVATIVE: it only claims what a capability tag
 * genuinely implies, so the doctrine layer (real docs) does the heavy lifting. Everything here is
 * `technique`-grade at best — a tag is not documentation. Exception: text-to-image, which every
 * image model does natively by definition.
 */
const CAPABILITY_IMPLIES: Partial<Record<ImageTask, Capability[]>> = {
  'photoreal-portrait': ['photorealism'],
  'product-shot': ['photorealism'],
  'character-consistency': ['multi_reference'],
  'scene-composite': ['multi_reference'],
  'style-transfer': ['multi_reference'],
  'text-in-image': ['text_in_image'],
  'text-edit-in-place': ['text_in_image', 'editing'],
  'inpaint-masked-edit': ['editing'],
  'background-replace': ['editing'],
  'sketch-to-render': ['editing'],
  'vector-illustration': ['vector'],
  'logo-mark': ['vector'],
  'icon-set': ['vector'],
  'upscale-enhance': ['high_resolution'],
};

/** Build one model's full feature map from its doctrine (if any) + its capability tags. */
export function buildFeatureMap(model: ImageModel, doctrine?: ModelDoctrine | null): FeatureMap {
  const byTask = new Map(doctrine?.taskPatterns?.map((t) => [t.task, t]) ?? []);
  const caps = new Set(model.capabilities);

  const out = {} as FeatureMap;
  for (const task of IMAGE_TASKS) {
    const documented = byTask.get(task);
    if (documented) {
      out[task] = { task, support: documented.support, how: documented.pattern, evidence: 'doctrine' };
      continue;
    }
    if (task === 'text-to-image') {
      out[task] = { task, support: 'native', how: '', evidence: 'capability' };
      continue;
    }
    const required = CAPABILITY_IMPLIES[task];
    const implied = required && required.length > 0 && required.every((c) => caps.has(c));
    out[task] = implied
      ? { task, support: 'technique', how: '', evidence: 'capability' }
      : { task, support: 'unsupported', how: '', evidence: 'none' };
  }
  return out;
}

/** One task's support for one model — the direct "can it do X?" question. */
export function supportFor(model: ImageModel, task: ImageTask, doctrine?: ModelDoctrine | null): FeatureEntry {
  return buildFeatureMap(model, doctrine)[task];
}

export interface TaskCandidate {
  model: ImageModel;
  entry: FeatureEntry;
}

/**
 * Every model that can serve `task`, best evidence first: documented-native, then documented-
 * technique, then capability-implied. Within a rank, richer typed reference support and higher
 * craft win — but the ORDER here is evidence, not opinion; the router still ranks on fit/cost.
 * `unsupported` models are excluded entirely (never route a job a model can't do).
 */
export function modelsForTask(
  models: ImageModel[],
  task: ImageTask,
  doctrines: Map<string, ModelDoctrine> = new Map(),
): TaskCandidate[] {
  const rank = (e: FeatureEntry): number =>
    e.evidence === 'doctrine' && e.support === 'native' ? 0 : e.evidence === 'doctrine' ? 1 : 2;

  return models
    .map((model) => ({ model, entry: supportFor(model, task, doctrines.get(model.id)) }))
    .filter((c) => c.entry.support !== 'unsupported')
    .sort((a, b) => rank(a.entry) - rank(b.entry) || b.model.tier - a.model.tier);
}

/** Compact "what is this model FOR" summary — the tasks it genuinely serves, strongest first. */
export function documentedTasks(model: ImageModel, doctrine?: ModelDoctrine | null): FeatureEntry[] {
  const map = buildFeatureMap(model, doctrine);
  return IMAGE_TASKS.map((t) => map[t])
    .filter((e) => e.support !== 'unsupported' && e.evidence === 'doctrine')
    .sort((a, b) => (a.support === b.support ? 0 : a.support === 'native' ? -1 : 1));
}
