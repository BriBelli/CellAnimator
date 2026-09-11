/**
 * THE VIDEO AGENT — the specialist that turns a handed-off brief into a concrete shot plan.
 *
 * This is the piece that makes everything the video stages built actually reach a person: the
 * registry facts, the doctrine distilled from each model's own published guide, the task vocabulary,
 * the cost gate. Until now they were all read by nothing, and the Video nav routed to the image agent
 * wearing a video badge.
 *
 * It mirrors `image-agent.ts` in shape — pre-ground the target model, plan against ITS formula,
 * refine, emit a builder block, then render — but the substance is video's own:
 *
 *   · A shot has LENGTH, a camera that moves, physics, and often sound. Those are the specs the
 *     agent owns, and they are the axes that decide both quality and price.
 *   · A SEQUENCE is a first-class thing, not several renders: Kling composes multiple shots in one
 *     generation with a shared audio timeline, which stitched clips cannot reproduce.
 *   · Cost is settled before dispatch, because one 10-second 1080p clip is ~50× an image.
 *
 * Never dead-ends: if routing finds nothing, the guide is still built from the best-known model's
 * real formula so the user sees a working surface and an honest reason, not an empty panel.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AGENT_MODELS } from './model-config';
import { parseJsonResponse, responseText } from './model-agent/json-response';
import {
  describeVideoCapabilities,
  loadVideoDoctrines,
  allVideoModels,
  videoFactsForModel,
  type VideoCapabilityFacts,
  type VideoRoutingRequest,
} from './video-model-agent';
import { coordinateVideo, type VideoCoordEvent } from '../engine/video-coordinator';
import { normalizeVideoTask, videoVocabularyPrompt, type VideoTask } from '../engine/video-vocabulary';

const MODEL = AGENT_MODELS.imageAgent;

/** One formula part in the video builder (mirrors the image builder part, so the UI is shared). */
export interface VideoBuilderPart {
  id: string;
  label: string;
  guidance: string;
  /** ONLY what the user actually specified — empty if unmentioned; never invented. */
  value: string;
  /** The agent's suggested improvement — the field placeholder. */
  recommend?: string;
  chips: string[];
  weight?: number;
}

/** The structured consult for video — the Prompt Guide, shaped by the target model's own formula. */
export interface VideoBuilderBlock {
  kind: 'builder';
  surface?: 'canvas';
  title: string;
  media: 'video';
  parts: VideoBuilderPart[];
  modelId?: string;
  assembly?: string;
  model?: { label: string; maxReferences: number; supports: string[] };
  /** The shot specs the agent owns — what the render controls bind to. */
  shot?: { durationSec: number; resolution?: string; aspectRatio?: string; audio: boolean; task?: VideoTask };
}

export type VideoAgentEvent =
  | { type: 'agent_start' }
  | { type: 'step'; id: string; label?: string; status: 'start' | 'done'; detail?: string }
  | { type: 'agent_text'; delta: string }
  | { type: 'agent_usage'; inputTokens: number; outputTokens: number }
  | { type: 'agent_a2ui'; block: VideoBuilderBlock }
  | { type: 'gen_start' }
  | { type: 'gen_plan'; models: { modelId: string; label: string; why: string; estUsd: number }[]; dropped?: { modelId: string; label: string; reason: string }[]; estimatedUsd: number }
  | { type: 'fan_model'; modelId: string; state: 'queued' | 'running' | 'done' | 'failed'; stage?: string; delivered?: number; ms?: number; reason?: string }
  | { type: 'clip'; url: string; modelId: string; modelLabel: string; index: number }
  | { type: 'gen_notice'; message: string }
  | { type: 'gen_error'; message: string }
  | { type: 'gen_done'; costUsd: number };

export const VIDEO_AGENT_SYSTEM = `You are the VIDEO AGENT — a specialist that turns a handed-off creative brief into a concrete SHOT plan. You have ALREADY been oriented: the brief is VERIFIED, do not re-question it — start at DECIDE.

Respond in TWO parts, in order:
1) a SHORT opener as plain text — one calm sentence, no fluff, no exclamation. On a CONSULTATION hand-off invite the user to shape the shot and NEVER claim you're rendering; on a GENERATION turn note what you're rendering.
2) return your plan as JSON.

You OWN the shot specs (the Operator handed only the brief). A shot is not a picture: it has LENGTH, a camera that MOVES, physics, and often SOUND — and those choices drive both the result and the price.

- prompt: a model-ready description of the shot.
- task: what is actually being made, chosen from the VIDEO TASK VOCABULARY below. Pick the one that fits; omit if genuinely unclear.
- durationSec: how long the shot runs. Default 5. Ask for length the beat NEEDS — video is priced per second, so seconds are money.
- resolution: '480p' | '720p' | '1080p' | '4k'. Default 720p unless the brief calls for finish quality.
- aspectRatio: e.g. '16:9', '9:16' for vertical.
- audio: true when the shot needs sound generated WITH the picture (dialogue, ambience, effects). Only where it is genuinely part of the shot.
- shots: for a SEQUENCE, one prompt per shot in order. A sequence rendered as one generation keeps cast, world and audio continuous across cuts in a way separate clips cannot. Use it only when the brief is genuinely multi-shot; otherwise omit.
- parts: break the brief into the TARGET MODEL'S formula — the exact parts and order given in the PROMPT FORMULA block of your instructions (they differ per model; never substitute a generic set). For each: id, label, one-line guidance, and:
  • value = ONLY what the USER actually specified for that part. EMPTY if they didn't mention it. NEVER invent or expand — that is what recommend is for.
  • recommend = your suggested improvement, specific and cinematic (the field placeholder).
  • chips = 3-5 quick-adds tailored to THIS shot (e.g. Camera: "slow push-in", "handheld tracking", "locked-off wide").

VIDEO TASK VOCABULARY:
__VIDEO_TASKS__

Respond with ONLY a JSON object, no prose after it:
{"opener":"<one sentence>","prompt":"...","task":"<slug|null>","durationSec":5,"resolution":"720p","aspectRatio":"16:9","audio":false,"shots":["..."],"parts":[{"id":"...","label":"...","guidance":"...","value":"...","recommend":"...","chips":["..."]}]}`;

/** The target model's formula + doctrine, rendered for the agent's instructions. */
function videoFormulaBrief(f: VideoCapabilityFacts): string {
  const parts = f.formula.parts.map((p, i) => `${i + 1}. ${p.label} (id: ${p.id}) — ${p.guidance}`).join('\n');
  const lines = [`PROMPT FORMULA for ${f.modelLabel} — fill EXACTLY these parts, in this order:`, parts];
  if (f.formula.assembly) lines.push(`ASSEMBLY: ${f.formula.assembly}`);
  if (f.formulaSource === 'doctrine') lines.push(`(This is ${f.modelLabel}'s OWN published formula, distilled from its documentation.)`);
  lines.push(
    `MODEL LIMITS: clips up to ${f.maxDurationSec}s · ${f.resolutions.join(', ') || 'default resolution'} · ` +
      `${f.nativeAudio ? 'generates synced audio in the same pass' : 'NO audio — picture only'} · ` +
      `${f.maxReferenceImages > 0 ? `up to ${f.maxReferenceImages} reference images` : 'no reference images'}` +
      `${f.cameraControls.length ? ` · camera: ${f.cameraControls.join(', ')}` : ''}`,
  );
  if (f.doctrine?.principles?.length) lines.push(`WHAT THIS MODEL REWARDS:\n${f.doctrine.principles.slice(0, 6).map((x) => `- ${x}`).join('\n')}`);
  if (f.doctrine?.antiPatterns?.length) lines.push(`WHAT IT PUNISHES:\n${f.doctrine.antiPatterns.slice(0, 4).map((x) => `- ${x}`).join('\n')}`);
  return lines.join('\n');
}

/** Build the builder parts from the model's formula + the agent's content, matched by id. */
export function buildVideoParts(
  facts: VideoCapabilityFacts,
  raw: unknown,
  fallbackSubject: string,
): VideoBuilderPart[] {
  const content = new Map<string, { value?: string; recommend?: string; chips?: string[] }>();
  if (Array.isArray(raw)) {
    for (const p of raw as Array<Record<string, unknown>>) {
      if (typeof p?.id === 'string') {
        content.set(p.id, {
          value: typeof p.value === 'string' ? p.value : '',
          recommend: typeof p.recommend === 'string' ? p.recommend : undefined,
          chips: Array.isArray(p.chips) ? (p.chips as unknown[]).filter((c): c is string => typeof c === 'string') : [],
        });
      }
    }
  }
  // STRUCTURE comes from the model's formula; CONTENT from the agent. A part the agent skipped is
  // still shown (empty) rather than dropped — the formula is the model's, not the agent's to edit.
  return facts.formula.parts.map((fp, i) => {
    const c = content.get(fp.id);
    let value = c?.value ?? '';
    if (!value && i === 0) value = fallbackSubject; // seed the lead part from the brief
    return {
      id: fp.id,
      label: fp.label,
      guidance: fp.guidance,
      value,
      recommend: c?.recommend || undefined,
      chips: c?.chips ?? [],
      weight: fp.weight,
    };
  });
}

export interface VideoAgentFrame {
  goal: string;
  subject?: string;
  budgetUsd?: number;
}

export interface VideoAgentTurn {
  userMessage?: string;
  /** Present → RENDER this shot now (the user committed from the builder). */
  renderPrompt?: string;
  /** The shot specs the user set in the controls. */
  shot?: { durationSec?: number; resolution?: string; aspectRatio?: string; audio?: boolean; models?: string[]; fanModels?: number; perModel?: number };
  client?: Anthropic;
}

/**
 * Run one Video agent turn. Consultation legs plan the shot and emit the builder; a render leg
 * dispatches through the coordinator and streams the job lifecycle.
 */
export async function* runVideoAgent(frame: VideoAgentFrame, turn: VideoAgentTurn = {}): AsyncGenerator<VideoAgentEvent> {
  yield { type: 'agent_start' };

  const baseReq: VideoRoutingRequest = {
    intent: turn.renderPrompt ?? frame.goal,
    durationSec: turn.shot?.durationSec,
    resolution: turn.shot?.resolution,
    aspectRatio: turn.shot?.aspectRatio,
    needsAudio: turn.shot?.audio,
    budgetUsd: frame.budgetUsd,
    models: turn.shot?.models,
    fanModels: turn.shot?.fanModels,
  };

  // ── RENDER LEG ────────────────────────────────────────────────────────────────────────────────
  if (turn.renderPrompt) {
    yield { type: 'gen_start' };
    let cost = 0;
    for await (const ev of coordinateVideo(baseReq, { budgetUsd: frame.budgetUsd, perModel: turn.shot?.perModel ?? 1 })) {
      yield* forwardCoordEvent(ev);
      if (ev.type === 'done') cost = ev.costUsd;
    }
    yield { type: 'gen_done', costUsd: cost };
    return;
  }

  // ── CONSULTATION LEG ──────────────────────────────────────────────────────────────────────────
  // PRE-GROUND first: the agent must be told the target model's REAL parts before it writes them,
  // or it defaults to a generic set and the model's own documented shape never reaches the builder.
  yield { type: 'step', id: 'grounding', label: 'Grounding the shot in the model…', status: 'start' };
  const facts = await describeVideoCapabilities(baseReq).catch(() => null);
  yield { type: 'step', id: 'grounding', status: 'done' };

  if (!facts) {
    yield { type: 'gen_error', message: 'No video model is configured yet.' };
    yield { type: 'gen_done', costUsd: 0 };
    return;
  }

  yield { type: 'step', id: 'shaping', label: `Shaping the ${facts.formula.parts.length} shot parts…`, status: 'start' };
  let plan: Record<string, unknown> = {};
  try {
    const client = turn.client ?? new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: VIDEO_AGENT_SYSTEM.replace('__VIDEO_TASKS__', videoVocabularyPrompt()),
      messages: [
        {
          role: 'user',
          content:
            `BRIEF (verified — start at Decide):\n${JSON.stringify(frame)}\n\n` +
            `This is the CONSULTATION leg: do NOT render, nothing is generated now.\n\n${videoFormulaBrief(facts)}`,
        },
      ],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);
    plan = parseJsonResponse(responseText(msg)) ?? {};
    const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    yield { type: 'agent_usage', inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 };
  } catch (err) {
    yield { type: 'gen_error', message: err instanceof Error ? err.message : 'The video agent failed to plan' };
    yield { type: 'gen_done', costUsd: 0 };
    return;
  }
  yield { type: 'step', id: 'shaping', status: 'done' };

  if (typeof plan.opener === 'string' && plan.opener.trim()) {
    yield { type: 'agent_text', delta: plan.opener.trim() };
  }

  const subject = (frame.subject || frame.goal || 'the shot').trim();
  const task = typeof plan.task === 'string' ? normalizeVideoTask(plan.task) : null;
  // Clamp to what the model actually accepts — asking for 30s from a 15s model is a guaranteed failure.
  const durationSec = Math.min(
    facts.maxDurationSec,
    Math.max(1, typeof plan.durationSec === 'number' ? Math.round(plan.durationSec) : 5),
  );
  const resolution = typeof plan.resolution === 'string' && facts.resolutions.includes(plan.resolution) ? plan.resolution : undefined;
  // Only claim audio when the model can actually make it.
  const audio = plan.audio === true && facts.nativeAudio;

  yield {
    type: 'agent_a2ui',
    block: {
      kind: 'builder',
      surface: 'canvas',
      title: `Shot · ${subject}`,
      media: 'video',
      parts: buildVideoParts(facts, plan.parts, subject),
      modelId: facts.modelId,
      assembly: facts.formula.assembly,
      model: {
        label: facts.modelLabel,
        maxReferences: facts.maxReferenceImages,
        supports: [
          `up to ${facts.maxDurationSec}s`,
          ...(facts.nativeAudio ? ['synced audio'] : []),
          ...(facts.resolutions.length ? [facts.resolutions.join(' · ')] : []),
          ...facts.features.slice(0, 4),
        ],
      },
      shot: { durationSec, resolution, aspectRatio: typeof plan.aspectRatio === 'string' ? plan.aspectRatio : undefined, audio, task: task ?? undefined },
    },
  };
  yield { type: 'gen_done', costUsd: 0 };
}

/** Translate coordinator events into the agent's stream shape. */
function* forwardCoordEvent(ev: VideoCoordEvent): Generator<VideoAgentEvent> {
  switch (ev.type) {
    case 'routed':
      yield { type: 'gen_plan', models: ev.models, dropped: ev.dropped, estimatedUsd: ev.estimatedUsd };
      break;
    case 'model_queued':
      yield { type: 'fan_model', modelId: ev.modelId, state: 'queued' };
      break;
    case 'model_progress':
      yield { type: 'fan_model', modelId: ev.modelId, state: 'running', stage: ev.stage };
      break;
    case 'clip':
      yield { type: 'clip', url: ev.tile.clip.url, modelId: ev.tile.modelId, modelLabel: ev.tile.modelLabel, index: ev.totalSoFar - 1 };
      break;
    case 'model_done':
      yield { type: 'fan_model', modelId: ev.modelId, state: 'done', delivered: ev.delivered, ms: ev.ms };
      break;
    case 'model_error':
      yield { type: 'fan_model', modelId: ev.modelId, state: 'failed', reason: ev.detail ?? ev.reason };
      break;
    case 'notice':
      yield { type: 'gen_notice', message: ev.message };
      break;
    case 'error':
      yield { type: 'gen_error', message: ev.message };
      break;
    default:
      break;
  }
}

/** Facts for the default video model — used to build a guide when routing finds nothing. */
export async function defaultVideoFacts(): Promise<VideoCapabilityFacts | null> {
  const models = allVideoModels();
  if (models.length === 0) return null;
  const doctrines = await loadVideoDoctrines();
  return videoFactsForModel(models[0], doctrines.get(models[0].id));
}
