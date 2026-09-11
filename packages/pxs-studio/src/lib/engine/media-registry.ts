/**
 * THE MEDIA REGISTRY — the UNION layer over the model stack (Brian's approved shape).
 *
 * One registry, `MEDIA_MODELS`, where every entry declares `modalities` + per-modality criteria.
 * Image / Video / Audio are DERIVED views (`modelsForModality`). A multi-modality model auto-shows in
 * each of its buckets (double-bucketing). "DM / Digital Media" is NOT a fourth store — it's the DERIVED
 * multimodal view (`omniModels`): the models that render more than one modality (the unified renderers).
 *
 * CONSTRUCTIVE, NOT DESTRUCTIVE: the working IMAGE registry (`model-registry.ts` / `IMAGE_MODELS`) is
 * untouched — this layer WRAPS it. The image path keeps running exactly as it did; this adds Video,
 * Audio, and the union surface on top. `IMAGE_MODELS` stays the source of truth for image criteria.
 *
 * SELF-MAINTAINING: video/audio/omni entries below are a SEED (Codex model landscape, 2026-07-26),
 * marked `sourceRefreshedAt` + `needsResearch` where the specifics need live confirmation. The Model
 * agent's refresh (staleness.ts / model-refresh.ts) is what keeps them current — never hardcoded truth
 * (that's how photolif died). Criteria depth here is deliberately PRAGMATIC, not a photolif mega-schema.
 */

import { PROVIDERS, registryTag, type Modality } from './provider-roster';
import { IMAGE_MODELS, type ImageModel, type ModelDoc, type PromptFormula } from './model-registry';

// ── Per-modality criteria ────────────────────────────────────────────────────

/** Video-model criteria — the essentials the agent routes + builds prompts on. */
export interface VideoCriteria {
  /** Longest single clip, seconds. */
  maxDurationSec: number;
  /** Output resolutions offered (e.g. '720p', '1080p'). */
  resolutions: string[];
  /** NATIVE synced audio in ONE render pass — the "one renderer / audio = timing substrate" flag. */
  nativeAudio: boolean;
  /** How motion is directed. */
  motion: ('text' | 'keyframe' | 'image-to-video' | 'camera-path')[];
  /** Named camera moves the model honors (pan / tilt / dolly / tracking / orbit …). */
  cameraControls: string[];
  /** Reference images accepted (start frame / character / style), if any. */
  maxReferenceImages?: number;
  /** (low, high) USD per second of output — the spend band across the model's whole range. */
  costPerSecondUsd?: [number, number];
  /**
   * USD per second BY RESOLUTION — the only shape that estimates a real video honestly.
   *
   * Video cost is driven by two axes at once (seconds × resolution) and the spread is enormous:
   * Seedance is $0.07/s at 480p and $1.37/s at 4K, a 20× swing. A single band cannot tell a user
   * whether the render they are about to commit to costs 30 cents or fourteen dollars, and for a
   * ~50×-an-image medium that difference is the whole decision.
   */
  costPerSecondByResolution?: Record<string, number>;
  /** The prompt formula this model rewards (scene / subject / camera / motion / style parts). */
  promptFormula?: PromptFormula;
}

/** Audio-model criteria — music / speech / sfx generation. */
export interface AudioCriteria {
  /** What it generates. */
  kind: ('music' | 'speech' | 'sfx')[];
  maxDurationSec: number;
  /** Named controls (genre, mood, tempo, key, voice, bpm …). */
  controls: string[];
  costPerMinuteUsd?: [number, number];
  promptFormula?: PromptFormula;
}

/**
 * A model in the union registry. Common fields + `modalities` + the per-modality criteria blocks that
 * apply. For an image-capable model, `image` embeds the full existing `ImageModel` (reuse, no reshape).
 */
export interface MediaModel {
  id: string;
  label: string;
  /** Roster provider id (google / openai / replicate / …) — bridges to `provider-roster.ts`. */
  provider: string;
  envKey: string;
  /** Every modality this model can produce — the double-bucketing driver. */
  modalities: Modality[];
  /** 1 budget/fast · 2 mid · 3 flagship. */
  tier: 1 | 2 | 3;
  brief: string;
  sourceRefreshedAt: string;
  /** Registry knowledge only — excluded from spend until confirmed live. */
  preview?: boolean;
  /** Discovered/seeded but not yet researched — the agent must confirm before routing. Reversible. */
  needsResearch?: boolean;
  /** The provider's own model id (adapter string) when it differs from `id`. */
  providerModelId?: string;
  /** PINNED official docs — the deterministic floor the doctrine pass ingests (see model-registry). */
  docs?: ModelDoc[];
  /** Per-modality criteria — present for each modality in `modalities`. */
  image?: ImageModel;
  video?: VideoCriteria;
  audio?: AudioCriteria;
}

// ── Wrap the existing IMAGE registry (untouched) into the union ───────────────

/** Reverse the roster's registryTag (image models are tagged 'gemini'; the roster id is 'google'). */
function rosterIdForTag(tag: string): string {
  return PROVIDERS.find((p) => registryTag(p) === tag)?.id ?? tag;
}

const IMAGE_AS_MEDIA: MediaModel[] = IMAGE_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
  provider: rosterIdForTag(m.provider),
  envKey: m.envKey,
  modalities: ['image'],
  tier: m.tier,
  brief: m.brief,
  sourceRefreshedAt: m.sourceRefreshedAt,
  preview: m.preview,
  needsResearch: m.needsResearch,
  providerModelId: m.providerModelId,
  image: m,
}));

// ── SEED: Video · Audio · Omni (agent-maintained; see file header) ────────────

const SEEDED = '2026-07-26';
/** Video facts re-verified against the live landscape on this date (the July seed was badly stale). */
const VVID = '2026-08-29';
/** Seedance 2.5 — surfaced by the succession sweep rather than by a person reading a docs page. */
const V25 = '2026-09-03';

/** Video-part prompt formula the router surfaces in the Video builder (scene → style). */
const VIDEO_FORMULA: PromptFormula = {
  parts: [
    { id: 'scene', label: 'Scene', guidance: 'What happens and where — the shot in one clear beat.', weight: 3 },
    { id: 'subject', label: 'Subject', guidance: 'The focal subject — materials, wardrobe, distinguishing detail.', weight: 2 },
    { id: 'camera', label: 'Camera', guidance: 'Shot size, angle, lens, and the move (push-in, tracking, orbit).', weight: 2 },
    { id: 'motion', label: 'Motion', guidance: 'How subjects and the world move — pace, direction, physics.', weight: 2 },
    { id: 'style', label: 'Style', guidance: 'Lighting, palette, film stock, mood.', weight: 1.5 },
  ],
  assembly: 'One cinematic sentence per shot, camera + motion explicit.',
};

/**
 * Pinned official docs for the video models — the same deterministic floor the image side uses
 * (company + key + DOCS). All URLs live-verified 2026-08-29.
 */
const VEO_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://ai.google.dev/gemini-api/docs/video', verifiedAt: VVID },
  { kind: 'model_card', url: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate', verifiedAt: VVID },
  { kind: 'pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing', verifiedAt: VVID },
];
const SEEDANCE_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://fal.ai/seedance-2.0', verifiedAt: VVID },
];
const HAPPYHORSE_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://fal.ai/models/alibaba/happy-horse/v1.1/text-to-video/api', verifiedAt: VVID },
  { kind: 'model_card', url: 'https://fal.ai/happyhorse-1.0', verifiedAt: VVID },
];
const KLING_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://fal.ai/docs/model-api-reference/video-generation-api/kling-video-lipsync', verifiedAt: VVID },
  { kind: 'prompting_guide', url: 'https://kling.ai/blog/kling-video-3-omni-native-lip-sync-audio-guide', verifiedAt: VVID },
];

/**
 * ROUTABLE as of 2026-09-02: Seedance 2.0, Kling 3.0 and Happy Horse 1.1 — each verified by an actual
 * render through the fal adapter (real MP4s, metered cost), which is the only evidence that counts.
 * Veo 3.1 stays `needsResearch` because it has no adapter yet: it is knowledge we can reason about,
 * not a route we can spend on. A model becomes routable when it has rendered, never before.
 */
const VIDEO_MODELS: MediaModel[] = [
  {
    id: 'seedance-2.5', label: 'Seedance 2.5 (ByteDance)', provider: 'fal', envKey: 'FAL_API_KEY',
    providerModelId: 'bytedance/seedance-2.5/text-to-video',
    modalities: ['video'], tier: 3, sourceRefreshedAt: V25, docs: SEEDANCE_DOCS,
    brief:
      'ByteDance Seedance 2.5 — the long-form tier: clips up to 30 SECONDS (double 2.0) with a wider ' +
      'reference budget across images, clips and audio. Not a straight replacement for 2.0, which it ' +
      'beats on length but LOSES to on resolution (2.5 tops out at 1080p; 2.0 reaches 4K), so both are ' +
      'kept and routed by what the shot needs. Found by the succession sweep 2026-09-03, which is the ' +
      'first version bump this system caught itself rather than a human noticing in a browser tab.',
    video: {
      maxDurationSec: 30, resolutions: ['480p', '720p', '1080p'], nativeAudio: true,
      motion: ['text', 'image-to-video', 'keyframe'],
      cameraControls: ['pan', 'tilt', 'dolly', 'tracking', 'orbit'],
      maxReferenceImages: 9,
      costPerSecondUsd: [0.07, 0.34],
      costPerSecondByResolution: { '480p': 0.07, '720p': 0.16, '1080p': 0.34 },
      promptFormula: VIDEO_FORMULA,
    },
  },
  {
    id: 'seedance-2', label: 'Seedance 2.0 (ByteDance)', provider: 'fal', envKey: 'FAL_API_KEY',
    providerModelId: 'bytedance/seedance-2.0/text-to-video',
    modalities: ['video'], tier: 3, sourceRefreshedAt: VVID, docs: SEEDANCE_DOCS,
    brief:
      'ByteDance Seedance 2.0 (Feb 2026) — #1 on Artificial Analysis WITH audio, and the only model in ' +
      'the roster that reaches 4K. Rich input set: 9 images + 3 clips + 3 audio in one generation, 4-15s. ' +
      'KEPT ALONGSIDE 2.5 deliberately: 2.5 doubles the length but stops at 1080p, so 2.0 remains the ' +
      'choice whenever finish resolution matters more than runtime. Verified 2026-08-29.',
    video: {
      maxDurationSec: 15, resolutions: ['480p', '720p', '1080p', '4K'], nativeAudio: true,
      motion: ['text', 'image-to-video', 'keyframe'],
      cameraControls: ['pan', 'tilt', 'dolly', 'tracking', 'orbit'],
      maxReferenceImages: 9,
      costPerSecondUsd: [0.07, 1.37], // 480p → 4K
      costPerSecondByResolution: { '480p': 0.07, '720p': 0.16, '1080p': 0.34, '4k': 1.37 }, // verified 2026-08-29
      promptFormula: VIDEO_FORMULA,
    },
  },
  {
    id: 'veo-3.1', label: 'Veo 3.1 (Google)', provider: 'google', envKey: 'GEMINI_API_KEY',
    providerModelId: 'veo-3.1-generate-preview',
    modalities: ['video'], tier: 3, sourceRefreshedAt: VVID, needsResearch: true, docs: VEO_DOCS,
    brief:
      'Google Veo 3.1 (Mar 2026) — the realism + native-audio flagship: synced dialogue, ambience and SFX in ONE pass at 48kHz, 1080p with 4K upscaling. SCENE EXTENSION chains up to 20 clips for 140s+ narratives, and frames-to-video interpolates between a start and end image — both of which matter more than clip length for film work. Family: quality / fast / lite. Every output carries a mandatory SynthID watermark. Verified 2026-08-29.',
    video: {
      maxDurationSec: 8, resolutions: ['720p', '1080p', '4K'], nativeAudio: true,
      motion: ['text', 'image-to-video', 'keyframe', 'camera-path'],
      cameraControls: ['pan', 'tilt', 'dolly', 'tracking', 'orbit'],
      maxReferenceImages: 3,
      costPerSecondUsd: [0.03, 0.6], // lite/no-audio → 4K with audio
      promptFormula: VIDEO_FORMULA,
    },
  },
  {
    id: 'kling-3', label: 'Kling 3.0 (Kuaishou)', provider: 'fal', envKey: 'FAL_API_KEY',
    providerModelId: 'fal-ai/kling-video/v3/pro',
    modalities: ['video'], tier: 3, sourceRefreshedAt: VVID, docs: KLING_DOCS,
    brief:
      'Kling 3.0 (Feb 2026) — the STORYBOARD model: a multi-shot mode that renders 1-6 shots from one prompt (15s total) with a shared audio timeline, plus native joint audio and lip-sync across Mandarin, English, Japanese, Korean and Spanish with no separate pass. Directly serves sequence work rather than single clips. Audio adds ~$0.056/s, voice control ~$0.028/s. Verified 2026-08-29 — the earlier seed had nativeAudio FALSE, which was wrong and would have routed every dialogue shot away from it.',
    video: {
      maxDurationSec: 15, resolutions: ['720p', '1080p'], nativeAudio: true,
      motion: ['text', 'image-to-video', 'keyframe'],
      cameraControls: ['pan', 'tilt', 'dolly', 'zoom'],
      maxReferenceImages: 1,
      costPerSecondUsd: [0.05, 0.25],
      promptFormula: VIDEO_FORMULA,
    },
  },
  {
    id: 'happy-horse-1.1', label: 'Happy Horse 1.1 (Alibaba)', provider: 'fal', envKey: 'FAL_API_KEY',
    providerModelId: 'alibaba/happy-horse/v1.1',
    modalities: ['video'], tier: 3, sourceRefreshedAt: VVID, docs: HAPPYHORSE_DOCS,
    brief:
      'Alibaba Happy Horse 1.1 — the 1.x line took #1 on Artificial Analysis WITHOUT audio and roughly tied #1 with it. A unified 15B transformer with joint audio-video, multilingual lip-sync and 1080p, plus a video-EDIT endpoint the rest of the roster lacks. The widest aspect range here (21:9 through 9:21). $0.14/s at 720p, $0.28/s at 1080p. Verified 2026-08-31 — the July seed had neither this model NOR its 1.0 predecessor, and we seeded 1.0 before finding 1.1 was live.',
    video: {
      maxDurationSec: 15, resolutions: ['720p', '1080p'], nativeAudio: true,
      motion: ['text', 'image-to-video'],
      cameraControls: ['pan', 'tilt', 'tracking'],
      maxReferenceImages: 4,
      costPerSecondUsd: [0.14, 0.28],
      costPerSecondByResolution: { '720p': 0.14, '1080p': 0.28 }, // verified 2026-08-31
      promptFormula: VIDEO_FORMULA,
    },
  },
];

const AUDIO_FORMULA: PromptFormula = {
  parts: [
    { id: 'kind', label: 'Kind', guidance: 'Music, speech, or SFX — and the role (score, stinger, ambience).', weight: 2 },
    { id: 'mood', label: 'Mood', guidance: 'Emotion + energy — the feeling the cue carries.', weight: 2 },
    { id: 'detail', label: 'Detail', guidance: 'Instrumentation / voice / tempo / key, and what it should NOT include.', weight: 2 },
  ],
  assembly: 'A short brief: kind, mood, then instrumentation/tempo.',
};

const AUDIO_MODELS: MediaModel[] = [
  {
    id: 'lyria-2', label: 'Lyria 2 (Google)', provider: 'google', envKey: 'GEMINI_API_KEY',
    modalities: ['audio'], tier: 3, sourceRefreshedAt: SEEDED, needsResearch: true,
    brief: 'Google music generation — high-fidelity instrumental + song scoring. Route film score + music beds.',
    audio: { kind: ['music'], maxDurationSec: 120, controls: ['genre', 'mood', 'tempo', 'key', 'instrumentation'], costPerMinuteUsd: [0.05, 0.3], promptFormula: AUDIO_FORMULA },
  },
  {
    id: 'musicgen', label: 'MusicGen (Replicate)', provider: 'replicate', envKey: 'REPLICATE_API_TOKEN',
    modalities: ['audio'], tier: 1, sourceRefreshedAt: SEEDED, needsResearch: true,
    brief: 'Open music + SFX generation, fast + cheap. Route quick beds, loops, and sound effects.',
    audio: { kind: ['music', 'sfx'], maxDurationSec: 30, controls: ['genre', 'mood', 'tempo'], costPerMinuteUsd: [0.01, 0.05], promptFormula: AUDIO_FORMULA },
  },
];

/** OMNI / DM — genuine multi-output models. These populate the DERIVED `omniModels()` view AND each of
 *  their per-modality buckets. Seeded conservatively (needsResearch) — the agent confirms real span. */
const OMNI_MODELS: MediaModel[] = [
  {
    id: 'gemini-omni', label: 'Gemini Omni (Google)', provider: 'google', envKey: 'GEMINI_API_KEY',
    modalities: ['image', 'audio'], tier: 3, sourceRefreshedAt: SEEDED, needsResearch: true,
    brief: 'Native multimodal — interleaved image + audio in one context (the unified renderer). Confirm live span before routing; today a reasoning-forward Omni exemplar.',
    audio: { kind: ['speech', 'sfx'], maxDurationSec: 60, controls: ['voice', 'mood', 'pacing'], promptFormula: AUDIO_FORMULA },
  },
];

// ── The union + derived views ─────────────────────────────────────────────────

/** The whole union: wrapped image models + seeded video/audio/omni. ONE registry. */
export const MEDIA_MODELS: MediaModel[] = [
  ...IMAGE_AS_MEDIA,
  ...VIDEO_MODELS,
  ...AUDIO_MODELS,
  ...OMNI_MODELS,
];

/** All media models. */
export function mediaModels(): MediaModel[] {
  return MEDIA_MODELS;
}

/** DERIVED bucket for a modality — an Omni model appears in each of its buckets (double-bucketing). */
export function modelsForModality(modality: Modality): MediaModel[] {
  return MEDIA_MODELS.filter((m) => m.modalities.includes(modality));
}

/** The DM / Digital-Media view — DERIVED: models that render more than one modality (unified renderers).
 *  Not a separate registry; just the multimodal slice of the union. */
export function omniModels(): MediaModel[] {
  return MEDIA_MODELS.filter((m) => m.modalities.length > 1);
}

/** Models a given roster provider offers (for the per-provider knowledge shards). */
export function mediaModelsForProvider(providerId: string): MediaModel[] {
  return MEDIA_MODELS.filter((m) => m.provider === providerId);
}

/** Look up a media model by id. */
export function getMediaModel(id: string): MediaModel | undefined {
  return MEDIA_MODELS.find((m) => m.id === id);
}

/** The four browsable surfaces + their counts (Image / Video / Audio / DM). Convenience for reports. */
export function modalitySurfaces(): { modality: Modality | 'dm'; label: string; count: number }[] {
  return [
    { modality: 'image', label: 'Image', count: modelsForModality('image').length },
    { modality: 'video', label: 'Video', count: modelsForModality('video').length },
    { modality: 'audio', label: 'Audio', count: modelsForModality('audio').length },
    { modality: 'dm', label: 'Digital Media (Omni)', count: omniModels().length },
  ];
}

/**
 * VIDEO models projected into the shape the doctrine/refresh machinery already consumes.
 *
 * The doctrine pass only needs `{ id, label, provider, docs, promptFormula }` — it reads documents,
 * it does not care about reference pools or batch strategy. Rather than fork that machinery for a
 * second modality (two copies of a self-maintaining loop is how they drift apart), video borrows it
 * through this projection. Only models with PINNED docs are returned: nothing to read means nothing
 * to distill, and an empty doctrine is worse than none.
 */
export function videoModelsForDoctrine(): ImageModel[] {
  return MEDIA_MODELS.filter((m) => m.modalities.includes('video') && (m.docs ?? []).length > 0).map(
    (m) =>
      ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        envKey: m.envKey,
        tier: m.tier,
        capabilities: [],
        bestFor: [],
        strengths: { photorealism: 0, prompt_adherence: 0, editing: 0, style_versatility: 0, text_rendering: 0, speed: 0, resolution: 0, consistency: 0, multimodal: 0 },
        supportsEditing: false,
        maxReferenceImages: m.video?.maxReferenceImages ?? 0,
        aspectRatios: [],
        costPerImageUsd: [0, 0],
        maxBatchN: 1,
        batchStrategy: 'parallel',
        brief: m.brief,
        sourceRefreshedAt: m.sourceRefreshedAt,
        docs: m.docs,
        promptFormula: m.video?.promptFormula,
        providerModelId: m.providerModelId,
      }) as unknown as ImageModel,
  );
}
