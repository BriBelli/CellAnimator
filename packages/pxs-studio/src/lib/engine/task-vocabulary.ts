/**
 * THE TASK VOCABULARY — Pixcel's controlled, professional language for what a user is actually
 * trying to MAKE, and the spine of model selection.
 *
 * Why a controlled vocabulary instead of scraped feature lists: every provider names the same
 * capability differently and at a different register — one ships "Story-to-Comic Strip" (toy), the
 * next calls the same thing "sequential panel generation", the next doesn't name it at all and just
 * demonstrates it in a cookbook. Those names change monthly. If we stored provider vocabulary we'd
 * store noise, and a user asking for a STORYBOARD would match nothing.
 *
 * So WE own the nouns. The research/doctrine pass's job is TRANSLATION: read each model's docs and
 * map whatever they call it onto these slugs, with a support level and the source. That makes
 * "I need a character sheet" a routable query instead of a research project, and it's what lets the
 * Model agent answer "which model does X" without a human crawling eight doc sites.
 *
 * Rules for this list:
 *   · PROFESSIONAL register always (a production tool, never a toy) — 'storyboard-panels', never
 *     'comic strip maker'.
 *   · A task is something a professional would COMMISSION, not a knob (aspect ratio is not a task).
 *   · Additive + reversible: new tasks append; nothing here is a cage. Unknown provider features map
 *     to the closest slug or are dropped — never invented into the vocabulary by an LLM.
 */

/** Every task Pixcel can route. Additive — append, don't renumber or repurpose. */
export const IMAGE_TASKS = [
  'text-to-image',
  'photoreal-portrait',
  'product-shot',
  'character-sheet',
  'character-consistency',
  'storyboard-panels',
  'scene-composite',
  'style-transfer',
  'text-in-image',
  'text-edit-in-place',
  'multi-turn-editing',
  'inpaint-masked-edit',
  'background-replace',
  'sketch-to-render',
  'virtual-try-on',
  'logo-mark',
  'vector-illustration',
  'icon-set',
  'infographic',
  'poster-layout',
  'ui-mockup',
  'web-grounded-facts',
  'upscale-enhance',
  'image-to-video',
] as const;

export type ImageTask = (typeof IMAGE_TASKS)[number];

/** How well a model serves a task. The distinction Brian's native-capability-FIRST rule demands:
 *  `native` = the model does it as a documented feature; `technique` = achievable through a RECIPE
 *  over its inputs (Tao-style workarounds live here — agent toolkit, never a user-facing button);
 *  `unsupported` = it genuinely can't, and we say so instead of faking it. */
export type TaskSupport = 'native' | 'technique' | 'unsupported';

export interface TaskDef {
  id: ImageTask;
  /** Professional label for UI. */
  label: string;
  /** One line: what a professional means when they commission this. */
  description: string;
  /** Everyday phrasings that should classify INTO this task (matching aid, not an exhaustive list). */
  aliases: string[];
}

export const TASK_DEFS: Record<ImageTask, TaskDef> = {
  'text-to-image': { id: 'text-to-image', label: 'Text to image', description: 'A new image from a written description, no input imagery.', aliases: ['generate', 'create an image', 'make a picture'] },
  'photoreal-portrait': { id: 'photoreal-portrait', label: 'Photoreal portrait', description: 'A believable photographic likeness of a person, with real lens and lighting behavior.', aliases: ['headshot', 'portrait photo', 'realistic person'] },
  'product-shot': { id: 'product-shot', label: 'Product shot', description: 'Commercial product photography — clean staging, controlled light, packaging fidelity.', aliases: ['packshot', 'ecommerce photo', 'product photography'] },
  'character-sheet': { id: 'character-sheet', label: 'Character sheet', description: 'A multi-view/multi-pose reference sheet defining one character for reuse across shots.', aliases: ['model sheet', 'turnaround', 'character reference sheet', 'style sheet'] },
  'character-consistency': { id: 'character-consistency', label: 'Character consistency', description: 'Holding one identity stable across separate generations.', aliases: ['same character', 'consistent face', 'keep the person'] },
  'storyboard-panels': { id: 'storyboard-panels', label: 'Storyboard panels', description: 'A sequence of shots telling one continuous beat, consistent in world and cast.', aliases: ['storyboard', 'shot sequence', 'comic panels', 'sequential panels'] },
  'scene-composite': { id: 'scene-composite', label: 'Scene composite', description: 'Combining subjects/objects from several references into one believable scene.', aliases: ['put the person in the scene', 'blend images', 'compositing', 'merge photos'] },
  'style-transfer': { id: 'style-transfer', label: 'Style transfer', description: 'Applying a reference aesthetic to new or existing content.', aliases: ['in the style of', 'restyle', 'apply look'] },
  'text-in-image': { id: 'text-in-image', label: 'Text in image', description: 'Legible, well-kerned words rendered inside the artwork.', aliases: ['typography', 'words in image', 'lettering', 'signage'] },
  'text-edit-in-place': { id: 'text-edit-in-place', label: 'Edit text in place', description: 'Changing wording inside an existing image without disturbing the layout around it.', aliases: ['change the text', 'fix the wording', 'replace copy'] },
  'multi-turn-editing': { id: 'multi-turn-editing', label: 'Multi-turn editing', description: 'Iterative conversational refinement that preserves prior context across turns.', aliases: ['keep editing', 'now change', 'conversational edit'] },
  'inpaint-masked-edit': { id: 'inpaint-masked-edit', label: 'Masked edit', description: 'Changing a specified region while the rest of the frame stays pixel-stable.', aliases: ['inpaint', 'mask edit', 'edit this area', 'semantic masking'] },
  'background-replace': { id: 'background-replace', label: 'Background replace', description: 'Swapping the environment while preserving the subject.', aliases: ['change background', 'cut out', 'new backdrop'] },
  'sketch-to-render': { id: 'sketch-to-render', label: 'Sketch to render', description: 'Turning line art, a wireframe, or a rough into a finished render.', aliases: ['render my sketch', 'line art to image', 'concept to final'] },
  'virtual-try-on': { id: 'virtual-try-on', label: 'Virtual try-on', description: 'Placing garments or products onto a person while holding both identities.', aliases: ['try on', 'outfit swap', 'wear this'] },
  'logo-mark': { id: 'logo-mark', label: 'Logo mark', description: 'An original brand mark — scalable, reproducible, typographically sound.', aliases: ['logo', 'wordmark', 'brand mark'] },
  'vector-illustration': { id: 'vector-illustration', label: 'Vector illustration', description: 'Clean scalable vector artwork, ideally native SVG output.', aliases: ['svg', 'flat illustration', 'vector art'] },
  'icon-set': { id: 'icon-set', label: 'Icon set', description: 'A family of icons consistent in weight, grid, and metaphor.', aliases: ['icons', 'iconography', 'pictograms'] },
  'infographic': { id: 'infographic', label: 'Infographic', description: 'Information design — data, labels, and structure that must read correctly.', aliases: ['diagram', 'chart image', 'explainer graphic'] },
  'poster-layout': { id: 'poster-layout', label: 'Poster layout', description: 'Composed key art with hierarchy, headline, and title treatment.', aliases: ['poster', 'key art', 'movie poster', 'title card'] },
  'ui-mockup': { id: 'ui-mockup', label: 'UI mockup', description: 'Interface and screen design rendered as an image.', aliases: ['app screen', 'landing page mock', 'interface design'] },
  'web-grounded-facts': { id: 'web-grounded-facts', label: 'Web-grounded imagery', description: 'Imagery whose content must reflect real, current, verifiable facts.', aliases: ['real data', 'up to date facts', 'search grounded'] },
  'upscale-enhance': { id: 'upscale-enhance', label: 'Upscale / enhance', description: 'Raising resolution or restoring detail without inventing new content.', aliases: ['upscale', 'enhance', 'higher resolution', '4k'] },
  'image-to-video': { id: 'image-to-video', label: 'Image to video', description: 'Animating a still into motion (the bridge into the video pipeline).', aliases: ['animate', 'make it move', 'video from image'] },
};

const TASK_SET = new Set<string>(IMAGE_TASKS);

/** Is this a task slug we own? */
export function isImageTask(v: unknown): v is ImageTask {
  return typeof v === 'string' && TASK_SET.has(v);
}

/**
 * Coerce a model-supplied slug onto the vocabulary — enum-locked. Exact match first, then a light
 * normalization (spaces/underscores → dashes, lowercase), then an alias match. Returns null when it
 * genuinely isn't one of ours: an unmapped provider feature is DROPPED, never invented into the
 * vocabulary. This is the guardrail that keeps "Story-to-Comic Strip" from ever entering the system
 * as its own noun — it either lands on `storyboard-panels` or it doesn't land.
 */
export function normalizeTask(raw: string): ImageTask | null {
  const slug = raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (isImageTask(slug)) return slug;
  for (const def of Object.values(TASK_DEFS)) {
    if (def.aliases.some((a) => a.toLowerCase().replace(/[\s_]+/g, '-') === slug)) return def.id;
  }
  return null;
}

/** The vocabulary as a compact prompt block — what research/classification agents are enum-locked to. */
export function taskVocabularyPrompt(): string {
  return IMAGE_TASKS.map((t) => `- ${t}: ${TASK_DEFS[t].description}`).join('\n');
}
