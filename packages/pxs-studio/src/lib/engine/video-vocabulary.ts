/**
 * THE VIDEO TASK VOCABULARY — the same controlled-language idea as `task-vocabulary.ts`, for motion.
 *
 * Video needs its OWN nouns, not a stretched version of the image ones. What a professional
 * commissions here is a shot or a sequence, and the axes that decide a model are different: does it
 * hold a character across shots, does it generate synced dialogue in one pass, can it extend a clip,
 * can it interpolate between two frames. "text-to-image" has no equivalent obligation.
 *
 * Same rules as the image vocabulary: WE own the nouns, research TRANSLATES each provider's naming
 * onto them, unknown features are DROPPED rather than coined, and the register stays professional
 * (a production tool, never a toy). Additive — append, never repurpose.
 */

export const VIDEO_TASKS = [
  'text-to-video',
  'image-to-video',
  'keyframe-interpolation',
  'clip-extension',
  'multi-shot-sequence',
  'lipsync-dialogue',
  'native-audio',
  'camera-move',
  'character-consistency-video',
  'style-transfer-video',
  'video-edit',
  'motion-transfer',
  'product-demo',
  'talking-head',
  'b-roll',
  'upscale-video',
] as const;

export type VideoTask = (typeof VIDEO_TASKS)[number];

export interface VideoTaskDef {
  id: VideoTask;
  label: string;
  description: string;
  aliases: string[];
}

export const VIDEO_TASK_DEFS: Record<VideoTask, VideoTaskDef> = {
  'text-to-video': { id: 'text-to-video', label: 'Text to video', description: 'A new clip from a written description alone.', aliases: ['generate video', 'make a video', 't2v'] },
  'image-to-video': { id: 'image-to-video', label: 'Image to video', description: 'Animating a still into motion, using it as the opening frame.', aliases: ['animate', 'make it move', 'i2v', 'start frame'] },
  'keyframe-interpolation': { id: 'keyframe-interpolation', label: 'Keyframe interpolation', description: 'Generating the motion between a start and an end frame you supply.', aliases: ['frames to video', 'first and last frame', 'tween', 'morph between'] },
  'clip-extension': { id: 'clip-extension', label: 'Clip extension', description: 'Continuing an existing clip past its end while holding continuity — how short models reach long runtimes.', aliases: ['extend', 'continue the shot', 'scene extension', 'longer video'] },
  'multi-shot-sequence': { id: 'multi-shot-sequence', label: 'Multi-shot sequence', description: 'Several shots rendered as one continuous beat, consistent in cast, world and audio.', aliases: ['storyboard', 'sequence', 'multi shot', 'scene'] },
  'lipsync-dialogue': { id: 'lipsync-dialogue', label: 'Lip-synced dialogue', description: 'Spoken lines with mouth movement that actually matches the audio.', aliases: ['lip sync', 'talking', 'dialogue', 'speech'] },
  'native-audio': { id: 'native-audio', label: 'Native audio', description: 'Synced sound generated in the same pass as the picture — never a separate post step.', aliases: ['with sound', 'audio included', 'sfx', 'ambience'] },
  'camera-move': { id: 'camera-move', label: 'Camera move', description: 'A directed camera: push-in, tracking, orbit, crane, rack focus.', aliases: ['camera motion', 'dolly', 'pan', 'tracking shot', 'orbit'] },
  'character-consistency-video': { id: 'character-consistency-video', label: 'Character consistency', description: 'One identity held stable across shots and clips.', aliases: ['same character', 'consistent person', 'keep the actor'] },
  'style-transfer-video': { id: 'style-transfer-video', label: 'Style transfer', description: 'Applying a reference look to motion.', aliases: ['restyle video', 'in the style of', 'video style'] },
  'video-edit': { id: 'video-edit', label: 'Video edit', description: 'Changing content inside an existing clip while the rest holds.', aliases: ['edit the video', 'change the clip', 'v2v'] },
  'motion-transfer': { id: 'motion-transfer', label: 'Motion transfer', description: 'Driving a subject with motion captured from another clip.', aliases: ['pose transfer', 'copy the movement', 'drive the animation'] },
  'product-demo': { id: 'product-demo', label: 'Product demo', description: 'Commercial product motion — turntables, features, packaging fidelity.', aliases: ['product video', 'turntable', 'commercial'] },
  'talking-head': { id: 'talking-head', label: 'Talking head', description: 'A presenter shot: framing, eyeline, and delivery that reads as broadcast.', aliases: ['presenter', 'spokesperson', 'to camera'] },
  'b-roll': { id: 'b-roll', label: 'B-roll', description: 'Supporting coverage cut under narration or dialogue.', aliases: ['cutaway', 'coverage', 'establishing'] },
  'upscale-video': { id: 'upscale-video', label: 'Upscale video', description: 'Raising resolution or restoring detail without inventing new content.', aliases: ['upscale', '4k video', 'enhance video'] },
};

const TASK_SET = new Set<string>(VIDEO_TASKS);

export function isVideoTask(v: unknown): v is VideoTask {
  return typeof v === 'string' && TASK_SET.has(v);
}

/**
 * Coerce a model-supplied slug onto the vocabulary — enum-locked, exactly like the image side. An
 * unmapped provider feature is DROPPED, never invented into the vocabulary.
 */
export function normalizeVideoTask(raw: string): VideoTask | null {
  const slug = raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (isVideoTask(slug)) return slug;
  for (const def of Object.values(VIDEO_TASK_DEFS)) {
    if (def.aliases.some((a) => a.toLowerCase().replace(/[\s_]+/g, '-') === slug)) return def.id;
  }
  return null;
}

/** The vocabulary as a prompt block — what research/classification agents are enum-locked to. */
export function videoVocabularyPrompt(): string {
  return VIDEO_TASKS.map((t) => `- ${t}: ${VIDEO_TASK_DEFS[t].description}`).join('\n');
}
