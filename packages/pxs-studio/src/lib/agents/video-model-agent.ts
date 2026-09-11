/**
 * THE VIDEO MODEL AGENT — the capability truth for video, and the place the video doctrine finally
 * gets read.
 *
 * Everything the last stages built for video (a verified registry, a task vocabulary, doctrine
 * distilled from each model's own published guide) has so far been inert: distilled and stored, and
 * nothing consulted it. This is the consumer. It answers, for a given request:
 *
 *   · which model should serve it, and what that model actually accepts (duration, resolutions,
 *     aspect ratios, reference count, whether it makes audio in the same pass);
 *   · what its PROMPT FORMULA is — its own, from its own guide, not a generic five;
 *   · what tasks it genuinely does, in our vocabulary;
 *   · what this render will cost before anything is spent.
 *
 * It mirrors `model-agent.ts` deliberately — same shape, same never-dead-end guarantees — but it is
 * a PORT, not a copy: video's axes are its own (a shot has length, camera movement and sound), and
 * pretending otherwise is what made the Video nav a badge on the image agent.
 */

import { MEDIA_MODELS, type MediaModel } from '../engine/media-registry';
import { estimateVideoCost, type VideoEstimate } from '../engine/video-cost';
import { readyVideoProviders } from '../engine/video-executor';
import { normalizeVideoTask, type VideoTask } from '../engine/video-vocabulary';
import type { PromptFormula } from '../engine/model-registry';
import type { ModelDoctrine } from './model-agent/doctrine';
import { getDoctrine, loadDoctrines } from './doctrine-refresh';
import { getDb } from '../db';

/** The generic fallback — used ONLY until a model's own doctrine has been distilled. */
export const DEFAULT_VIDEO_FORMULA: PromptFormula = {
  parts: [
    { id: 'scene', label: 'Scene', guidance: 'What happens and where — the shot in one clear beat.', weight: 3 },
    { id: 'subject', label: 'Subject', guidance: 'The focal subject — materials, wardrobe, distinguishing detail.', weight: 2 },
    { id: 'camera', label: 'Camera', guidance: 'Shot size, angle, lens, and the move (push-in, tracking, orbit).', weight: 2 },
    { id: 'motion', label: 'Motion', guidance: 'How subjects and the world move — pace, direction, physics.', weight: 2 },
    { id: 'style', label: 'Style', guidance: 'Lighting, palette, film stock, mood.', weight: 1.5 },
  ],
  assembly: 'One cinematic sentence per shot, camera and motion explicit.',
};

/** What a video model can actually do for this request — the facts the builder and agent stand on. */
export interface VideoCapabilityFacts {
  modelId: string;
  modelLabel: string;
  /** The exact string sent to the provider — the transparency fact behind "are we on the latest?". */
  providerModelId: string;
  /** ISO date this record was last verified against live docs. */
  verifiedAt: string;
  provider: string;
  /** Seconds in ONE clip. */
  maxDurationSec: number;
  resolutions: string[];
  /** Synced audio generated in the SAME pass — not a post step. */
  nativeAudio: boolean;
  /** Reference images accepted (0 = none). */
  maxReferenceImages: number;
  cameraControls: string[];
  /** The model's REAL formula: its doctrine's, else the registry's, else the generic default. */
  formula: PromptFormula;
  /** Where the formula came from — surfaced so guidance is never mistaken for house style. */
  formulaSource: 'doctrine' | 'registry' | 'default';
  /** Tasks this model's own documentation evidences, in our vocabulary. */
  features: VideoTask[];
  /** The doctrine behind it, when distilled. */
  doctrine?: {
    confidence: 'low' | 'medium' | 'high';
    principles: string[];
    antiPatterns: string[];
    sources: { url: string; kind: string }[];
  };
  /** True when a registered adapter + key can actually run this model today. */
  ready: boolean;
}

/** Every video model in the registry, whether or not it can run yet. */
export function allVideoModels(): MediaModel[] {
  return MEDIA_MODELS.filter((m) => m.modalities.includes('video') && m.video);
}

/** Video models we can ACTUALLY render with right now (adapter registered + key present). */
export function runnableVideoModels(): MediaModel[] {
  const ready = new Set(readyVideoProviders());
  return allVideoModels().filter((m) => ready.has(m.provider));
}

/** Read the doctrine's task patterns back as our vocabulary. */
function featuresFrom(doctrine?: ModelDoctrine | null): VideoTask[] {
  if (!doctrine?.taskPatterns) return [];
  const out: VideoTask[] = [];
  for (const t of doctrine.taskPatterns) {
    const task = normalizeVideoTask(String(t.task));
    if (task && !out.includes(task)) out.push(task);
  }
  return out;
}

/**
 * Capability facts for a KNOWN video model. Pass its doctrine to get its real formula, principles
 * and features; without one it falls back honestly to the registry shape and the generic formula.
 */
export function videoFactsForModel(model: MediaModel, doctrine?: ModelDoctrine | null): VideoCapabilityFacts {
  const v = model.video;
  // The formula ladder — identical in spirit to the image side: the model's own published guide
  // beats our registry entry, which beats a generic default. Reported, never implied.
  const doctrineFormula = doctrine?.formula;
  const registryFormula = v?.promptFormula;
  const formulaSource: VideoCapabilityFacts['formulaSource'] = doctrineFormula
    ? 'doctrine'
    : registryFormula
      ? 'registry'
      : 'default';

  return {
    modelId: model.id,
    modelLabel: model.label,
    providerModelId: model.providerModelId ?? model.id,
    verifiedAt: model.sourceRefreshedAt,
    provider: model.provider,
    maxDurationSec: v?.maxDurationSec ?? 5,
    resolutions: v?.resolutions ?? [],
    nativeAudio: v?.nativeAudio ?? false,
    maxReferenceImages: v?.maxReferenceImages ?? 0,
    cameraControls: v?.cameraControls ?? [],
    formula: doctrineFormula ?? registryFormula ?? DEFAULT_VIDEO_FORMULA,
    formulaSource,
    features: featuresFrom(doctrine),
    doctrine: doctrine
      ? {
          confidence: doctrine.confidence,
          principles: doctrine.principles,
          antiPatterns: doctrine.antiPatterns,
          sources: doctrine.sources,
        }
      : undefined,
    ready: readyVideoProviders().includes(model.provider),
  };
}

export interface VideoRoutingRequest {
  intent: string;
  /** What the user is making — filters to models that actually do it. */
  task?: VideoTask;
  durationSec?: number;
  resolution?: string;
  aspectRatio?: string;
  /** Audio required in the same pass (dialogue, ambience). */
  needsAudio?: boolean;
  /** Reference images the user attached. */
  referenceCount?: number;
  /** Spend still available, USD — models whose cheapest run exceeds it are excluded. */
  budgetUsd?: number;
  /** How many models to fan across. */
  fanModels?: number;
  /** Explicit user picks; when present they win over ranking. */
  models?: string[];
}

export interface VideoCandidate {
  model: MediaModel;
  facts: VideoCapabilityFacts;
  estimate: VideoEstimate;
  /** 0..1 — how well this model fits THIS request. */
  fit: number;
  why: string;
}

export interface VideoRoutingDecision {
  candidates: VideoCandidate[];
  /** Models excluded, with the honest reason — never a silent disappearance. */
  dropped: { modelId: string; label: string; reason: string }[];
}

/**
 * Choose video models for a request. Capability gates first (a model that cannot make audio is not a
 * candidate for a dialogue shot), then budget, then rank. Everything excluded is REPORTED: a model
 * vanishing without explanation is the "where did Flux go?" failure this project already fixed once.
 */
export function routeVideo(
  req: VideoRoutingRequest,
  catalog: MediaModel[],
  doctrines = new Map<string, ModelDoctrine>(),
  /** Provider-readiness, INJECTED — so routing is pure and testable without adapters or keys
   *  (the image router takes `hasKey` for exactly this reason). Defaults to the live registry. */
  isReady: (provider: string) => boolean = (p) => readyVideoProviders().includes(p),
): VideoRoutingDecision {
  const dropped: VideoRoutingDecision['dropped'] = [];
  const durationSec = req.durationSec ?? 5;

  const survivors: VideoCandidate[] = [];
  for (const model of catalog) {
    const facts = videoFactsForModel(model, doctrines.get(model.id));
    const drop = (reason: string) => dropped.push({ modelId: model.id, label: model.label, reason });

    // Knowledge-only records never spend.
    if (model.preview || model.needsResearch) {
      drop('not yet researched — knowledge only');
      continue;
    }
    if (!isReady(model.provider)) {
      drop('no adapter or API key for this provider yet');
      continue;
    }
    if (req.needsAudio && !facts.nativeAudio) {
      drop('does not generate synced audio in one pass');
      continue;
    }
    if (durationSec > facts.maxDurationSec) {
      drop(`makes clips up to ${facts.maxDurationSec}s; you asked for ${durationSec}s`);
      continue;
    }
    if (req.referenceCount && req.referenceCount > 0 && facts.maxReferenceImages === 0) {
      drop('takes no reference images');
      continue;
    }
    // A task the model's own docs evidence — only enforced once a doctrine exists, so a model is
    // never benched for a feature nobody has researched yet.
    if (req.task && facts.features.length > 0 && !facts.features.includes(req.task)) {
      drop(`its documentation does not cover ${req.task}`);
      continue;
    }

    const estimate = estimateVideoCost(model, { durationSec, resolution: req.resolution, count: 1 });
    if (req.budgetUsd != null && estimate.totalUsd > req.budgetUsd) {
      drop(`${estimate.durationSec}s at ${estimate.resolution} costs $${estimate.totalUsd.toFixed(2)} — over the $${req.budgetUsd.toFixed(2)} left`);
      continue;
    }

    survivors.push({ model, facts: { ...facts, ready: true }, estimate, ...scoreVideo(facts, req) });
  }

  // An explicit pick is a directive: honour exactly those (that survived the gates), in the user's order.
  if (req.models && req.models.length > 0) {
    const chosen = req.models
      .map((id) => survivors.find((c) => c.model.id === id))
      .filter((c): c is VideoCandidate => !!c);
    if (chosen.length > 0) return { candidates: chosen, dropped };
  }

  survivors.sort((a, b) => b.fit - a.fit);
  return { candidates: survivors.slice(0, Math.max(1, req.fanModels ?? 1)), dropped };
}

/** How well a model fits — grounded in what its own documentation evidences, not a tier grab. */
function scoreVideo(facts: VideoCapabilityFacts, req: VideoRoutingRequest): { fit: number; why: string } {
  const reasons: string[] = [];
  let score = 0.4; // every runnable model starts as a genuine option

  if (req.task && facts.features.includes(req.task)) {
    score += 0.3;
    reasons.push(`documented for ${req.task}`);
  }
  if (req.needsAudio && facts.nativeAudio) {
    score += 0.15;
    reasons.push('native synced audio');
  }
  if (facts.formulaSource === 'doctrine') {
    // A model whose own guide we have read is one we can prompt properly — that is a real advantage.
    score += 0.1;
    reasons.push('own prompting guide distilled');
  }
  if (req.resolution && facts.resolutions.includes(req.resolution)) {
    score += 0.05;
    reasons.push(`offers ${req.resolution}`);
  }
  return { fit: Math.min(1, Number(score.toFixed(2))), why: reasons.join(' · ') || 'runnable for this request' };
}

/** Load every distilled VIDEO doctrine, keyed by model id. Guarded — never blocks a render. */
export async function loadVideoDoctrines(): Promise<Map<string, ModelDoctrine>> {
  const out = new Map<string, ModelDoctrine>();
  try {
    const db = await getDb();
    for (const [id, rec] of await loadDoctrines(db)) {
      const d = rec.doctrine as ModelDoctrine | undefined;
      if (d && d.modality === 'video') out.set(id, d);
    }
  } catch {
    /* no doctrines yet — facts fall back to the registry shape, honestly */
  }
  return out;
}

/**
 * The capability facts for the model that would serve `req`. Never dead-ends: if routing excludes
 * everything, it reports the best-known model's facts anyway so the builder still has a real formula
 * and real limits to show, rather than degrading to an empty guide.
 */
export async function describeVideoCapabilities(req: VideoRoutingRequest): Promise<VideoCapabilityFacts | null> {
  const doctrines = await loadVideoDoctrines();
  const decision = routeVideo(req, allVideoModels(), doctrines);
  const chosen = decision.candidates[0]?.model ?? runnableVideoModels()[0] ?? allVideoModels()[0];
  if (!chosen) return null;
  return videoFactsForModel(chosen, doctrines.get(chosen.id) ?? (await getDoctrine(await getDb(), chosen.id).catch(() => null)));
}
