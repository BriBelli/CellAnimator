/**
 * THE VIDEO EXECUTION SEAM — the video twin of `executor.ts`, deliberately NOT a reuse of it.
 *
 * Why a separate seam: the image executor is image-shaped in ways that matter. It assumes a call that
 * returns in seconds and hands back finished pixels. Video is a JOB: you submit, it queues, it runs
 * for minutes, and you poll until a clip exists. It also carries parameters images have no concept of
 * — duration, frame rate, resolution tiers, whether audio is generated in the same pass, a start
 * frame, an end frame. Forcing that through `GenRequest` would mean lying about all of it, and the
 * UI could never show honest progress because there'd be nothing to report between "sent" and "done".
 *
 * So the contract is a STREAM OF JOB EVENTS. An adapter yields `queued` the moment the provider
 * accepts the job, then `progress` as it advances, then `clip` per delivered video. That is what lets
 * a minute-long render feel alive instead of frozen — the same reason the image fan streams tiles.
 *
 * Registration mirrors the image side exactly (`registerVideoExecutor` / `getVideoExecutor`), so the
 * two stacks stay recognisably the same shape without sharing a type that fits neither.
 */

import type { VideoTask } from './video-vocabulary';

/** A request to generate video from one model. */
export interface VideoRequest {
  /** Registry model id (e.g. 'seedance-2'). The adapter maps it to the provider's endpoint. */
  modelId: string;
  prompt: string;
  /** Seconds of output. Adapters clamp to what the model actually offers. */
  durationSec?: number;
  aspectRatio?: string;
  /** '480p' | '720p' | '1080p' | '4k' — adapters map onto the model's own tiers. */
  resolution?: string;
  /** Generate synced audio in the SAME pass, where the model supports it. */
  audio?: boolean;
  /** The still to animate FROM (image-to-video). */
  startFrame?: string;
  /** The still to land ON — with `startFrame`, this is keyframe interpolation. */
  endFrame?: string;
  /** Reference images guiding the whole clip (character/style/objects), NOT frames. */
  references?: string[];
  /**
   * Reference CLIPS and AUDIO — motion and sound to guide the render, not just stills.
   *
   * Some models take far more than pictures: Seedance 2.0 accepts 9 images + 3 clips + 3 audio
   * tracks in one generation, each addressable from the prompt. Modelling references as images-only
   * would have silently capped it at a third of what it can do — the capability would exist, be paid
   * for, and be unreachable.
   */
  videoRefs?: string[];
  audioRefs?: string[];
  /** What the user is actually making — several providers expose a different ENDPOINT per task. */
  task?: VideoTask;
  /**
   * A SEQUENCE: one prompt per shot, rendered as a single continuous clip.
   *
   * This is not "several renders" — Kling composes multiple shots inside one generation with a
   * shared audio timeline, so the cast, world and sound carry across cuts in a way that stitching
   * separate clips cannot reproduce. Models without the capability fall back to the first shot and
   * say so, rather than silently dropping the rest.
   */
  shots?: string[];
  /** Things to keep OUT of frame, where the model accepts a negative prompt. */
  negativePrompt?: string;
}

/** One produced clip. */
export interface VideoClip {
  url: string;
  durationSec?: number;
  /** True when the clip carries generated audio (not silent). */
  hasAudio?: boolean;
  /** Poster frame, when the provider gives one — lets the UI show something before the video loads. */
  thumbnailUrl?: string;
}

/** Normalized failure reasons — same taxonomy as the image seam so callers handle one vocabulary. */
export type VideoErrorReason =
  | 'no_key'
  | 'moderated'
  | 'rate_limited'
  | 'bad_request'
  | 'transport'
  | 'timeout'
  | 'unknown';

/**
 * Job lifecycle. `queued` fires as soon as the provider accepts (so the UI can stop guessing),
 * `progress` while it runs, `clip` per delivered video, then exactly one terminal `done` or `error`.
 */
export type VideoEvent =
  | { type: 'queued'; jobId: string; queuePosition?: number }
  | { type: 'progress'; pct?: number; stage?: string }
  | { type: 'clip'; clip: VideoClip; index: number }
  | { type: 'error'; reason: VideoErrorReason; detail?: string }
  | { type: 'done'; clips: VideoClip[]; costUsd?: number };

export interface VideoExecutor {
  /** Roster provider id ('fal', 'google', 'replicate'). */
  readonly provider: string;
  /** True when the key this provider needs is present. */
  isConfigured(): boolean;
  generate(req: VideoRequest): AsyncIterable<VideoEvent>;
}

const REGISTRY = new Map<string, VideoExecutor>();

export function registerVideoExecutor(executor: VideoExecutor): void {
  REGISTRY.set(executor.provider, executor);
}

export function getVideoExecutor(provider: string): VideoExecutor | undefined {
  return REGISTRY.get(provider);
}

/** Providers with a registered adapter AND a key — the video models we can actually run today. */
export function readyVideoProviders(): string[] {
  return [...REGISTRY.values()].filter((e) => e.isConfigured()).map((e) => e.provider);
}
