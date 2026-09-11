/**
 * The image-model registry — the coordinator's pantry.
 *
 * A faithful TS re-creation of photolif's `model_registry.py` field shape (label,
 * provider, env_key, tier, strengths, best_for, capability + cost + batch fields,
 * and a human `brief`), curated to a real starter catalog spanning the providers
 * we'll wire first. The coordinator's router (see `routing.ts`) selects from this
 * by capability + ranking — it is NEVER a hardcoded switch.
 *
 * SELF-RESTOCKING (live): each record carries `sourceRefreshedAt`. The model-intelligence workflow
 * (agents/model-intelligence.ts) re-verifies every record against live docs on a daily TTL and
 * overlays sourced corrections — capabilities AND the strength/tier ranking axes. The seed below is
 * only the bootstrap floor; the research pass owns the truth. HIGH-END ONLY: superseded/budget
 * models are pruned, not kept "just in case" (they pollute the fan-out).
 *
 * NO KEYS / NO SPEND live here — this is pure data + lookup. Provider adapters
 * (which actually call the APIs and read `env_key`) live behind the executor seam.
 */

/** A provider we can dispatch an image generation to. */
export type ImageProvider = 'openai' | 'fal' | 'gemini' | 'ideogram' | 'recraft' | 'stability' | 'replicate' | 'xai';

/** The capability axes a request can require and a model can satisfy. */
export type Capability =
  | 'text_in_image' // legible text rendered inside the image
  | 'editing' // edit / inpaint an input image
  | 'multi_reference' // compose from >1 reference image
  | 'photorealism'
  | 'vector' // clean vector / logo / icon output
  | 'high_resolution'
  | 'fast'
  | 'cheap';

/** How a model produces N images in one logical request. */
export type BatchStrategy = 'native' | 'parallel';

/** What an input SLOT is for — the ROLE an image plays when you hand it to the model. Roles are
 *  ours (stable, routable); the slot's `param` carries the provider's own name for it. */
export type SlotRole =
  | 'general' // one undifferentiated pool (any mix of roles)
  | 'character' // identity to hold across generations
  | 'style' // aesthetic to apply
  | 'object' // a specific thing to reproduce faithfully
  | 'subject' // the image being edited / the base plate
  | 'mask' // where an edit may apply
  | 'sketch'; // line art / wireframe to render from

/**
 * ONE INPUT CHANNEL a model actually offers. This replaces the Gemini-shaped
 * `{object, character, style}` approximation that was forced onto every model — real models differ
 * structurally, not just numerically: Ideogram has separate style_reference_images and
 * character_reference_images plus style CODES that are mutually exclusive with style refs; OpenAI
 * has a flat 16-image edit pool plus exactly one mask that applies to the FIRST image; FLUX takes 8
 * index-addressable refs you cite positionally in the prompt ("the coat from image 3"); Recraft
 * builds a reusable style_id from 1-5 images at a different endpoint entirely.
 *
 * A count alone can't express any of that, and the difference is exactly what makes a reference
 * "work" or silently do nothing. Research-owned like everything else; the seed is the bootstrap.
 */
export interface InputSlot {
  /** The PROVIDER's own parameter name — what the adapter actually sends. */
  param: string;
  role: SlotRole;
  /** Short human label for the Guide/picker ("Style references"). */
  label: string;
  /** Max images this slot accepts. `undefined` = the docs describe the slot but publish no count —
   *  honest unknown, for research to fill; never invent a number. */
  max?: number;
  /** How the model TREATS these inputs — the usage fact that makes them work (e.g. index-addressable,
   *  applied to the first image only, produces a reusable id). */
  notes?: string;
  /** Other slots/params that CANNOT be combined with this one (provider-enforced exclusivity). */
  conflictsWith?: string[];
  /** Size/format constraints as the docs state them. */
  constraints?: string;
}

/** What a pinned official document is FOR — drives which pass reads it (doctrine reads the
 *  prompting_guide + api_reference in full; pricing/model_card ground the numbers). */
export type ModelDocKind = 'api_reference' | 'prompting_guide' | 'pricing' | 'model_card';

/** One PINNED official document for a model — part of the deterministic floor (Brian's cut: the
 *  floor is company + API key + DOCS; everything distilled FROM the docs is autonomous). Each URL is
 *  live-verified when pinned (`verifiedAt`); the intelligence workflow re-fetches them in full on a
 *  TTL and re-distills only when content actually changed. Tavily still hunts for docs we did NOT
 *  pin — pinning is a floor, never a ceiling. */
export interface ModelDoc {
  kind: ModelDocKind;
  url: string;
  /** ISO date the URL was last confirmed live + on-topic. */
  verifiedAt: string;
}

/** One part of a model's PROMPT FORMULA — the documented shape it rewards. Drives the builder's
 *  parts, guidance, and (weighted) scoring. `weight` = how much this part matters FOR THIS MODEL
 *  (heavier parts move the quality score more). Part ORDER is meaningful (some models weight by
 *  position). The Model agent owns this; today it's curated registry data, later shard/Tavily-fed. */
export interface PromptFormulaPart {
  id: string; // 'subject' | 'action' | 'context' | 'composition' | 'style' | model-defined
  label: string;
  guidance: string;
  weight: number; // relative, e.g. 1–3
}

/** A model's prompt formula — the ordered, weighted parts + a note on how it wants them assembled. */
export interface PromptFormula {
  parts: PromptFormulaPart[];
  /** One line on assembly (order/format the model rewards) — surfaced in the Guide. */
  assembly?: string;
}

/** The 9 strength axes (0–5), mirrored from photolif's `strengths`. */
export interface ModelStrengths {
  photorealism: number;
  prompt_adherence: number;
  editing: number;
  style_versatility: number;
  text_rendering: number;
  speed: number;
  resolution: number;
  consistency: number;
  multimodal: number;
}

/** One image model the coordinator can route to. */
export interface ImageModel {
  /** Stable registry id (also the id passed to the provider adapter). */
  id: string;
  /** Human label shown in the badge / console ("FLUX1.1 Pro (fal)"). */
  label: string;
  provider: ImageProvider;
  /** The env var holding this provider's key. The adapter reads it; the registry never does. */
  envKey: string;
  /** 1 = budget/fast, 2 = mid, 3 = flagship. */
  tier: 1 | 2 | 3;
  strengths: ModelStrengths;
  /** Fast-path tags the router's Gate-1 filter matches against. */
  capabilities: Capability[];
  /** Human intents this model is a strong pick for (feeds the Gate-2 ranker's context). */
  bestFor: string[];
  supportsEditing: boolean;
  /** Total reference images the model accepts across all roles (the flat pool). */
  maxReferenceImages: number;
  /** Typed per-ROLE reference limits (LEGACY, Gemini-shaped). Superseded by `inputSlots`, which
   *  expresses real input channels; kept because existing routing/coordinator paths read it and a
   *  researched card may still carry it. When both exist, `inputSlots` wins (see reference-planning). */
  referenceLimits?: { object: number; character: number; style: number };
  /** The model's REAL input channels (see InputSlot). The structural truth about how references are
   *  passed — what makes "attach a style ref" land in the slot the model actually reads. */
  inputSlots?: InputSlot[];
  /** The model's documented PROMPT FORMULA (ordered, weighted parts). Absent → the generic default
   *  formula applies (see `getModelFormula`) until the Model agent researches this model's real one. */
  promptFormula?: PromptFormula;
  aspectRatios: string[];
  /** (low, high) USD per image — the spend band used for cost caps + the console. */
  costPerImageUsd: [number, number];
  /** Largest N the provider will produce in ONE native call (batch); parallel otherwise. */
  maxBatchN: number;
  batchStrategy: BatchStrategy;
  /** The model brief — WHY/when to pick it. This is the curated craft the router reasons over. */
  brief: string;
  /** The model's PINNED official docs (see ModelDoc). The doctrine pass ingests these in FULL. */
  docs?: ModelDoc[];
  /** ISO date the record was last verified (self-restocking freshness signal). */
  sourceRefreshedAt: string;
  /** Registry KNOWLEDGE only — not yet callable/available. Gate 1 drops preview models from
   *  routing (never spends on them), but the Model agent can still reason/report about them
   *  ("keeps up with the models" without breaking the working flow). Flip when it goes live. */
  preview?: boolean;
  /** The provider's OWN canonical model id — the string the adapter passes to the API — when it
   *  differs from our registry `id` slug (e.g. flux-2-pro → 'black-forest-labs/flux-2-pro'). The refresh
   *  worker matches a provider's live listing against THIS (falling back to `id`) to confirm a model
   *  still exists. Absent → match on `id`. */
  providerModelId?: string;
  /** A model the refresh worker DISCOVERED live but that hasn't been curated/researched yet. Like
   *  `preview`, Gate 1 excludes it from spend — the Model agent knows it exists and must research it
   *  before it's routable. Reversible. */
  needsResearch?: boolean;
}

/**
 * The Gemini image family's REAL formula — Google's published "Image Generation Framework"
 * (Subject + Action + Location + Composition + Style), verified 2026-08-24 from the official
 * prompting guide. Note it teaches LOCATION, not the generic "context", and its guide's
 * Creative-Director section is what the guidance lines carry (design the light, choose the lens,
 * define the grade, emphasize materiality).
 *
 * SEEDED, NOT FINAL: the doctrine pass re-distills this from the live guide and supersedes it
 * (see factsForModel's formula ladder). A seeded formula is a bootstrap floor, never the authority.
 */
const GEMINI_IMAGE_FORMULA: PromptFormula = {
  parts: [
    { id: 'subject', label: 'Subject', guidance: 'The main focal point — emphasize materiality and texture; the guide rewards physical specificity.', weight: 3 },
    { id: 'action', label: 'Action', guidance: 'What the subject is doing — pose, stance, expression.', weight: 1.5 },
    { id: 'location', label: 'Location', guidance: 'Where it happens. Use POSITIVE framing — say what IS there, never what isn\'t.', weight: 2 },
    { id: 'composition', label: 'Composition', guidance: 'Direct the camera: shot type, angle, lens, focus and depth of field.', weight: 2 },
    { id: 'style', label: 'Style', guidance: 'Design the lighting, color grade / film stock, palette and medium.', weight: 2 },
  ],
  assembly: 'Subject-led natural language, one flowing description — the model reasons over the whole prompt. Put any in-image words in "quotes".',
};

/**
 * xAI's published director formula — "subject + action + setting + camera + lighting + mood",
 * natural language as a short scene description rather than keyword soup (verified 2026-08-24,
 * xAI docs). Six parts, with camera/lighting/mood SEPARATED — a genuinely different shape from the
 * Gemini five, which is exactly why one generic formula could never serve both. Doctrine supersedes.
 */
const XAI_IMAGE_FORMULA: PromptFormula = {
  parts: [
    { id: 'subject', label: 'Subject', guidance: 'Who or what the shot is about.', weight: 3 },
    { id: 'action', label: 'Action', guidance: 'What they are doing — the beat of the moment.', weight: 1.5 },
    { id: 'setting', label: 'Setting', guidance: 'Where it happens, and what is around them.', weight: 2 },
    { id: 'camera', label: 'Camera', guidance: 'Shot type, angle, lens — direct it like a DP.', weight: 2 },
    { id: 'lighting', label: 'Lighting', guidance: 'Light source, direction, quality, time of day.', weight: 2 },
    { id: 'mood', label: 'Mood', guidance: 'The emotional register the frame should carry.', weight: 1.5 },
  ],
  assembly: 'Write like a director: a short natural-language scene description, not a pile of keywords.',
};

/** Pinned docs, live-verified 2026-08-24. Families share their provider's canonical set. */
const V = '2026-08-24';
/** Second verification sweep — prompting-guide SUB-pages, found via each provider's llms.txt index. */
const V2 = '2026-08-27';
/** Third sweep — Recraft V4.1 (the registry was still routing to V3, two generations behind). */
const V3 = '2026-08-28';
const GEMINI_IMAGE_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://ai.google.dev/gemini-api/docs/image-generation', verifiedAt: V },
  { kind: 'prompting_guide', url: 'https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana', verifiedAt: V },
  { kind: 'pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing', verifiedAt: V },
];
// OpenAI publishes a clean MARKDOWN twin of every doc page (append `.md`) — pure content, none of
// the site navigation that was swamping the read. Verified 2026-08-24: the .md guide is 32KB of
// actual guidance where the HTML page's first 16KB is chrome.
const OPENAI_IMAGE_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://developers.openai.com/api/docs/guides/image-generation.md', verifiedAt: V },
  { kind: 'prompting_guide', url: 'https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide.md', verifiedAt: V },
];
// A provider's PROMPTING GUIDE is usually several pages: an index that teaches nothing plus the
// sub-pages that carry the actual structure. Pinning only the index is why FLUX/Ideogram/Recraft had
// principles but no FORMULA — the page naming the components was never read. Sub-pages found via each
// provider's llms.txt index, all verified live 2026-08-27; .md variants are clean content, no chrome.
const FLUX_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://docs.bfl.ml/flux_2/flux2_image_editing.md', verifiedAt: V2 },
  { kind: 'prompting_guide', url: 'https://docs.bfl.ml/guides/prompting_summary.md', verifiedAt: V2 },
  { kind: 'prompting_guide', url: 'https://docs.bfl.ml/guides/prompting_unified_basics.md', verifiedAt: V2 },
];
const XAI_IMAGE_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://docs.x.ai/developers/model-capabilities/imagine', verifiedAt: V },
  { kind: 'model_card', url: 'https://docs.x.ai/developers/models/grok-imagine-image', verifiedAt: V },
];
const IDEOGRAM_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://developer.ideogram.ai/api-reference/api-reference/generate-v3', verifiedAt: V },
  { kind: 'prompting_guide', url: 'https://docs.ideogram.ai/using-ideogram/getting-started/prompting-guide/3-prompt-structure.md', verifiedAt: V2 },
  { kind: 'prompting_guide', url: 'https://docs.ideogram.ai/using-ideogram/getting-started/prompting-guide/2-prompting-fundamentals.md', verifiedAt: V2 },
];
const RECRAFT_DOCS: ModelDoc[] = [
  { kind: 'api_reference', url: 'https://www.recraft.ai/docs/api-reference/models/recraft-v4-1.md', verifiedAt: V3 },
  { kind: 'api_reference', url: 'https://www.recraft.ai/docs/api-reference/endpoints.md', verifiedAt: V3 },
  { kind: 'prompting_guide', url: 'https://www.recraft.ai/docs/prompt-engineering-guide/prompting-with-recraft-v4.md', verifiedAt: V2 },
  { kind: 'prompting_guide', url: 'https://www.recraft.ai/docs/prompt-engineering-guide/introduction.md', verifiedAt: V2 },
];

/** Verified input channels per model family (2026-08-24, from the pinned docs). */
const OPENAI_IMAGE_SLOTS: InputSlot[] = [
  { param: 'image', role: 'general', label: 'Input images', max: 16, notes: 'Flat pool on /v1/images/edits — reference, compose, or edit; no per-role split.', constraints: 'png/webp/jpg, <50MB each' },
  { param: 'mask', role: 'mask', label: 'Edit mask', max: 1, notes: 'Applied to the FIRST input image only; transparent areas mark where edits may apply.', constraints: 'PNG <4MB, same dimensions as the image' },
];
const FLUX_SLOTS: InputSlot[] = [
  { param: 'input_images', role: 'general', label: 'Reference images', max: 8, notes: 'INDEX-ADDRESSABLE: cite them positionally in the prompt ("the person from image 1 in the outfit from image 4"). Order is meaningful.', constraints: 'jpeg, png, gif or webp' },
];
const GEMINI_PRO_SLOTS: InputSlot[] = [
  { param: 'contents[].inlineData', role: 'object', label: 'Object references', max: 10, notes: 'High-fidelity reproduction of specific things. 14 images total across all roles.' },
  { param: 'contents[].inlineData', role: 'character', label: 'Character references', max: 5, notes: 'Identity consistency across generations.' },
  { param: 'contents[].inlineData', role: 'style', label: 'Style references', max: 3, notes: 'Aesthetic transfer only — not identity.' },
];
const GEMINI_FLASH_SLOTS: InputSlot[] = [
  { param: 'contents[].inlineData', role: 'general', label: 'Reference images', max: 14, notes: 'Coherence reported across ~14 objects / 5 characters; the per-role split is NOT published — research owes the breakdown.' },
];
const IDEOGRAM_SLOTS: InputSlot[] = [
  { param: 'style_reference_images', role: 'style', label: 'Style references', max: 3, conflictsWith: ['style_codes', 'style_type'], constraints: '10MB total across all style references; JPEG/PNG/WebP' },
  { param: 'character_reference_images', role: 'character', label: 'Character reference', max: 1, notes: 'Single-image character consistency; an optional matching mask is supported.', constraints: '10MB total; JPEG/PNG/WebP' },
];
const RECRAFT_SLOTS: InputSlot[] = [
  { param: 'style (POST /v1/styles)', role: 'style', label: 'Style set', max: 5, notes: 'Uploaded at a SEPARATE endpoint (1-5 images + a base style) which returns a reusable style_id you then pass to generations — not a per-request reference.' },
];
const XAI_IMAGE_SLOTS: InputSlot[] = [
  { param: 'image', role: 'general', label: 'Source images', max: 3, notes: 'Editing / multi-image compositing on the Imagine API.' },
];

const REFRESHED = '2026-07-06';
/** Records fact-checked against live provider docs on this date (see each brief for the source). */
const VERIFIED = '2026-08-24';

/**
 * The curated starter catalog. Real model ids + provider routes; a handful across
 * providers so the router has genuine material to choose from. Extend freely —
 * this is data, and P6 will keep it fresh automatically.
 */
export const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'gpt-image-1.5',
    label: 'GPT Image 1.5 (OpenAI)',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    providerModelId: 'gpt-image-1.5',
    tier: 3,
    strengths: { photorealism: 5, prompt_adherence: 5, editing: 5, style_versatility: 5, text_rendering: 5, speed: 4, resolution: 5, consistency: 5, multimodal: 5 },
    capabilities: ['text_in_image', 'editing', 'multi_reference', 'photorealism', 'high_resolution'],
    bestFor: ['text in image', 'editing', 'hero image', 'world knowledge', 'premium'],
    supportsEditing: true,
    maxReferenceImages: 16,
    aspectRatios: ['1:1', '16:9', '9:16', '3:2', '2:3'],
    costPerImageUsd: [0.02, 0.19],
    maxBatchN: 10,
    batchStrategy: 'native',
    brief:
      'OpenAI flagship (GPT Image 1.5, Dec 2025 — built into the GPT-5 stack, ~4x faster than gpt-image-1). Best-in-class prompt adherence, in-image text, and editing: images.edit accepts up to 16 input images. Reach for it on hero images, legible text, and multi-turn edits. Native batch up to n=10. Verified 2026-08-24 (OpenAI API reference).',
    docs: OPENAI_IMAGE_DOCS,
    inputSlots: OPENAI_IMAGE_SLOTS,
    sourceRefreshedAt: VERIFIED,
  },
  {
    id: 'flux-2-pro',
    label: 'FLUX.2 [pro] (Replicate)',
    provider: 'replicate',
    envKey: 'REPLICATE_API_TOKEN',
    providerModelId: 'black-forest-labs/flux-2-pro',
    tier: 3,
    strengths: { photorealism: 5, prompt_adherence: 5, editing: 4, style_versatility: 5, text_rendering: 4, speed: 3, resolution: 5, consistency: 5, multimodal: 5 },
    capabilities: ['photorealism', 'high_resolution', 'multi_reference', 'editing'],
    bestFor: ['photoreal hero', 'multi-reference compose', 'character consistency', 'editing', 'style range'],
    supportsEditing: true,
    maxReferenceImages: 8,
    // Verified against the live Replicate schema 2026-08-27 — FLUX.2 does NOT accept 21:9.
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4'],
    costPerImageUsd: [0.04, 0.08],
    maxBatchN: 4,
    batchStrategy: 'parallel',
    brief:
      'Black Forest Labs FLUX.2 [pro] via Replicate — photoreal flagship with true MULTI-REFERENCE: composes/edits from up to 8 reference images, index-addressable ("the person from image 1 in the outfit from image 4"), strong character + product consistency. Verified 2026-08-24 from the Replicate model page. Route heavy in-image text to gpt-image-1 / ideogram.',
    docs: FLUX_DOCS,
    inputSlots: FLUX_SLOTS,
    sourceRefreshedAt: '2026-08-24',
  },
  {
    id: 'flux-2-dev',
    label: 'FLUX.2 [dev] (Replicate)',
    provider: 'replicate',
    envKey: 'REPLICATE_API_TOKEN',
    providerModelId: 'black-forest-labs/flux-2-dev',
    tier: 2,
    strengths: { photorealism: 4, prompt_adherence: 4, editing: 3, style_versatility: 4, text_rendering: 3, speed: 4, resolution: 4, consistency: 4, multimodal: 4 },
    capabilities: ['fast', 'cheap', 'photorealism', 'multi_reference', 'editing'],
    bestFor: ['multi-reference compose', 'cheap fan-out', 'drafts', 'exploration'],
    supportsEditing: true,
    maxReferenceImages: 8,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4'],
    costPerImageUsd: [0.01, 0.03],
    maxBatchN: 4,
    batchStrategy: 'parallel',
    brief:
      'Black Forest Labs FLUX.2 [dev] via Replicate — the affordable FLUX.2, same MULTI-REFERENCE stack (up to 8 refs + editing) at a fraction of pro cost. Great for reference-driven fan-outs and exploration. Verified 2026-08-24 from Replicate.',
    docs: FLUX_DOCS,
    inputSlots: FLUX_SLOTS,
    sourceRefreshedAt: '2026-08-24',
  },
  // ── Gemini 3.x image family — GA since May 2026 and wired through the gemini adapter (same
  //    generateContent endpoint the 2.5 model used; API ids verified 2026-08-24). The legacy
  //    nano-banana (2.5 Flash Image, 3-ref cap) is retired from the catalog: high-end only. ──
  {
    id: 'gemini-3-pro-image',
    label: 'Nano Banana Pro (Gemini 3 Pro Image)',
    provider: 'gemini',
    envKey: 'GEMINI_API_KEY',
    providerModelId: 'gemini-3-pro-image',
    tier: 3,
    strengths: { photorealism: 5, prompt_adherence: 5, editing: 5, style_versatility: 5, text_rendering: 5, speed: 3, resolution: 5, consistency: 5, multimodal: 5 },
    capabilities: ['editing', 'multi_reference', 'text_in_image', 'photorealism', 'high_resolution'],
    bestFor: ['character consistency', 'style transfer', 'multi-reference compose', 'flagship quality'],
    supportsEditing: true,
    maxReferenceImages: 14,
    referenceLimits: { object: 10, character: 5, style: 3 },
    inputSlots: GEMINI_PRO_SLOTS,
    promptFormula: GEMINI_IMAGE_FORMULA,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    costPerImageUsd: [0.134, 0.24],
    maxBatchN: 4,
    batchStrategy: 'parallel',
    brief:
      'Nano Banana Pro (gemini-3-pro-image, GA May 2026) — the family flagship. Distinct reference pools, 14 total: up to 10 object refs (high-fidelity), 5 character refs (consistency), and 3 style refs. $0.134/img at 1K-2K, $0.24 at 4K. First pick when a shot needs precise, typed references held together. Verified 2026-08-24 (ai.google.dev docs + pricing).',
    docs: GEMINI_IMAGE_DOCS,
    sourceRefreshedAt: VERIFIED,
  },
  {
    id: 'gemini-3.1-flash-image',
    label: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
    provider: 'gemini',
    envKey: 'GEMINI_API_KEY',
    providerModelId: 'gemini-3.1-flash-image',
    tier: 2,
    strengths: { photorealism: 4, prompt_adherence: 5, editing: 5, style_versatility: 4, text_rendering: 4, speed: 5, resolution: 4, consistency: 5, multimodal: 5 },
    capabilities: ['editing', 'multi_reference', 'text_in_image', 'fast', 'photorealism'],
    bestFor: ['fast multi-reference compose', 'character consistency', 'object insertion'],
    supportsEditing: true,
    maxReferenceImages: 14,
    inputSlots: GEMINI_FLASH_SLOTS,
    promptFormula: GEMINI_IMAGE_FORMULA,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    costPerImageUsd: [0.045, 0.15],
    maxBatchN: 8,
    batchStrategy: 'parallel',
    brief:
      'Nano Banana 2 (gemini-3.1-flash-image, Feb 2026) — the fast tier with real quality: high multi-reference (coherence across ~14 objects / 5 characters per DeepMind) at $0.045-$0.15 by resolution. Per-role reference split not published where we can verify — the research pass owns sourcing it. Verified 2026-08-24 (pricing + API id).',
    docs: GEMINI_IMAGE_DOCS,
    sourceRefreshedAt: VERIFIED,
  },
  {
    id: 'ideogram-v3',
    label: 'Ideogram 3.0',
    provider: 'ideogram',
    envKey: 'IDEOGRAM_API_KEY',
    tier: 2,
    strengths: { photorealism: 4, prompt_adherence: 5, editing: 3, style_versatility: 4, text_rendering: 5, speed: 3, resolution: 4, consistency: 4, multimodal: 2 },
    capabilities: ['text_in_image', 'high_resolution'],
    bestFor: ['typography', 'posters', 'logos with text', 'signage', 'legible words'],
    supportsEditing: true,
    maxReferenceImages: 4,
    referenceLimits: { object: 0, character: 1, style: 3 },
    // Live-verified 2026-08-27 from the API's own rejection message (it enumerates the valid set).
    aspectRatios: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:10', '10:16', '2:1', '1:2'],
    costPerImageUsd: [0.06, 0.09],
    maxBatchN: 1,
    batchStrategy: 'parallel',
    brief:
      'Ideogram 3.0 — the typography specialist. Best-in-class for accurate, well-kerned in-image text: posters, ads, packaging, wordmarks. Typed reference pools: up to 3 style refs + 1 character ref (10MB total each pool). Verified 2026-08-24 (developer.ideogram.ai). Contested crown: grok-imagine-image-2.0 now ranks #2 on Arena for text.',
    docs: IDEOGRAM_DOCS,
    inputSlots: IDEOGRAM_SLOTS,
    sourceRefreshedAt: VERIFIED,
  },
  {
    id: 'recraft-v4.1',
    label: 'Recraft V4.1',
    provider: 'recraft',
    envKey: 'RECRAFT_API_KEY',
    providerModelId: 'recraftv4_1',
    tier: 2,
    strengths: { photorealism: 4, prompt_adherence: 5, editing: 4, style_versatility: 5, text_rendering: 4, speed: 3, resolution: 5, consistency: 4, multimodal: 2 },
    capabilities: ['vector', 'text_in_image', 'high_resolution'],
    bestFor: ['vector art', 'logos', 'icons', 'brand systems', 'flat design', 'SVG output'],
    supportsEditing: true,
    maxReferenceImages: 1,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    costPerImageUsd: [0.035, 0.08],
    maxBatchN: 1,
    batchStrategy: 'parallel',
    brief:
      'Recraft V4.1 (May 2026) — the design/vector specialist, and the Recraft API\'s DEFAULT model. Native editable SVG via the _vector variants, brand-consistent style sets, cleaner icons and vectors by default. V4.1 reads intent more naturally, so shorter prompts land better. $0.035 raster / $0.08 vector. First pick for logos, icon sets, and flat vector illustration. Verified 2026-08-28 (recraft.ai API reference); replaces V3 (Oct 2024).',
    docs: RECRAFT_DOCS,
    inputSlots: RECRAFT_SLOTS,
    sourceRefreshedAt: V3,
  },
  {
    id: 'grok-imagine-image-2.0',
    label: 'Grok Imagine Image 2.0 (xAI)',
    provider: 'xai',
    envKey: 'XAI_API_KEY',
    providerModelId: 'grok-imagine-image-2.0',
    tier: 3,
    strengths: { photorealism: 4, prompt_adherence: 5, editing: 5, style_versatility: 4, text_rendering: 5, speed: 4, resolution: 4, consistency: 4, multimodal: 3 },
    capabilities: ['photorealism', 'multi_reference', 'editing', 'text_in_image', 'fast'],
    bestFor: ['typography', 'infographics', 'posters', 'title screens', 'expressive characters', 'photoreal'],
    supportsEditing: true,
    // xAI Imagine API: editing/compositing accepts up to 3 source images per request (1K/2K output).
    // The old "no count limit, use 8" note was for the retired grok-2-image path — do not resurrect it.
    maxReferenceImages: 3,
    aspectRatios: ['1:1', '16:9', '9:16', '3:2', '2:3'],
    costPerImageUsd: [0.02, 0.07],
    maxBatchN: 4,
    batchStrategy: 'parallel',
    brief:
      'xAI Grok Imagine Image 2.0 (shipped 2026-08-07) — typography-aware: plans layout/text before painting, so infographics, posters, and title screens hold structure. xAI reports #2 on Arena for BOTH text-to-image and editing. Editing/compositing takes up to 3 source images. Still strong expressive characters (Brian rated the Grok line a hit for characters). Verified 2026-08-24 (x.ai news + API docs).',
    docs: XAI_IMAGE_DOCS,
    inputSlots: XAI_IMAGE_SLOTS,
    promptFormula: XAI_IMAGE_FORMULA,
    sourceRefreshedAt: VERIFIED,
  },
];

/**
 * Models we have DELIBERATELY removed from the catalog, and why. Discovery must not resurrect them.
 *
 * Without this, the loop fights itself: a superseded model gets pruned for good reason, the next
 * provider sweep finds it live, research dutifully re-adds it, and it's back in the fan-out — which
 * is exactly what happened to the legacy 2.5 Flash Image on 2026-08-25. Knowledge is kept (the agent
 * can still reason about these); routing is refused. Reversible by deleting the entry — never a cage.
 */
export const PRUNED_MODEL_IDS: Record<string, string> = {
  'gemini-2.5-flash-image': 'superseded by the Gemini 3.x family (3-reference cap); high-end roster only',
  'nano-banana': 'legacy alias of gemini-2.5-flash-image — see above',
  'gemini-3.1-flash-lite-image': 'budget tier; pollutes the fan-out without adding craft',
  'grok-2-image': 'superseded by grok-imagine-image-2.0',
  'recraft-v3': 'superseded by Recraft V4.1 (May 2026) — two generations behind',
  recraftv3: 'superseded by Recraft V4.1 — provider id form',
  // VIDEO: OpenAI deprecated Sora 2 on 2026-04-26 and the API SHUTS DOWN 2026-09-24. Routing to it
  // would start failing outright within weeks, so it is pruned before it can strand a render.
  'sora-2': 'DEPRECATED 2026-04-26; OpenAI API shutdown 2026-09-24 — successors: Seedance 2.0, Veo 3.1',
  'gpt-image-1': 'superseded by gpt-image-1.5',
};

/** Is this id one we deliberately pruned? (Matched against both our slug and the provider id.) */
export function isPruned(id: string): boolean {
  const key = id.toLowerCase().replace(/^models\//, '').trim();
  return Object.keys(PRUNED_MODEL_IDS).some((p) => key === p || key.endsWith(`/${p}`));
}

/** Look a model up by id. Returns undefined for unknown ids. */
export function getModel(id: string): ImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

/** The default image model — the graceful fallback when live model SELECTION fails (e.g. the router
 *  LLM hangs). Used to keep the builder's reference facts populated so the References field is never
 *  silently empty. Nano Banana Pro if present, else the first catalog entry. Never a dead-end. */
export const DEFAULT_IMAGE_MODEL_ID = 'gemini-3-pro-image';
export function getDefaultImageModel(): ImageModel {
  return getModel(DEFAULT_IMAGE_MODEL_ID) ?? IMAGE_MODELS[0];
}

/** The generic image formula — the SAFETY NET when a model has no curated `promptFormula` yet.
 *  Structural (the classic 5-part), equal-ish weights. The Model agent replaces this with the
 *  model's REAL formula as it's researched (registry `promptFormula` or a shard). Never a cage. */
export const DEFAULT_IMAGE_FORMULA: PromptFormula = {
  parts: [
    { id: 'subject', label: 'Subject', guidance: 'The main focal point — be specific about materials and texture.', weight: 3 },
    { id: 'action', label: 'Action', guidance: 'What the subject is doing — pose, stance, expression.', weight: 1.5 },
    { id: 'context', label: 'Context', guidance: 'The environment and framing — say what you want, not what you don\'t.', weight: 2 },
    { id: 'composition', label: 'Composition', guidance: 'Shot type, angle, lens, and depth of field.', weight: 1.5 },
    { id: 'style', label: 'Style', guidance: 'Lighting, palette, mood, and medium.', weight: 2 },
  ],
  assembly: 'A structured, comma-joined prompt in Subject→Style order.',
};

/** The target model's PROMPT FORMULA — its own if curated, else the generic default. This is what
 *  drives the builder's parts + the weighted, honest score. */
export function getModelFormula(id: string): PromptFormula {
  return getModel(id)?.promptFormula ?? DEFAULT_IMAGE_FORMULA;
}

/** Every model that advertises ALL of the required capabilities. */
export function modelsWithCapabilities(required: Capability[]): ImageModel[] {
  if (required.length === 0) return [...IMAGE_MODELS];
  return IMAGE_MODELS.filter((m) => required.every((c) => m.capabilities.includes(c)));
}

/** The distinct env keys the current catalog depends on (for a "which keys are set?" check). */
export function requiredEnvKeys(): string[] {
  return Array.from(new Set(IMAGE_MODELS.map((m) => m.envKey)));
}
