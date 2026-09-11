/**
 * fal VIDEO adapter — the access layer for Seedance 2.0 (and next Kling and HappyHorse, which live on
 * the same platform and speak the same queue protocol).
 *
 * fal is a QUEUE, not a request/response API: you POST to `queue.fal.run/{endpoint}`, get a
 * `request_id` back immediately, poll a status URL while it runs, then fetch the result. That is why
 * the video seam streams job events — a 75-second render with no signal between "sent" and "done" is
 * indistinguishable from a hang, which is the same "where did it go?" hole the image fan status panel
 * exists to close.
 *
 * ENDPOINT PER TASK: Seedance exposes text-to-video, image-to-video and reference-to-video as
 * SEPARATE endpoints with different required inputs — the same "capability is a route, not a flag"
 * shape as Recraft's vector models. Sending references to the text endpoint does not fail loudly; it
 * silently ignores them, so the endpoint is chosen from what the caller actually supplied.
 *
 * Schemas and prices verified live 2026-08-29 against fal's OpenAPI; both paths confirmed rendering.
 */

import {
  registerVideoExecutor,
  type VideoClip,
  type VideoErrorReason,
  type VideoEvent,
  type VideoExecutor,
  type VideoRequest,
} from '../video-executor';

/** Registry model id → the fal endpoint FAMILY (the task suffix is appended per request). */
const ENDPOINT_FAMILY: Record<string, string> = {
  'seedance-2': 'bytedance/seedance-2.0',
  'seedance-2.5': 'bytedance/seedance-2.5',
  'kling-3': 'fal-ai/kling-video/v3/pro',
  'happy-horse-1.1': 'alibaba/happy-horse/v1.1',
};

/** Which input dialect a family speaks. Same platform and queue, genuinely different parameters —
 *  Kling takes `multi_prompt`/`shot_type` for sequences and a negative prompt; Seedance takes
 *  resolution tiers and up to 9 index-addressable references. One planner per dialect. */
const DIALECT: Record<string, Dialect> = {
  'seedance-2': 'seedance',
  'seedance-2.5': 'seedance',
  'kling-3': 'kling',
  'happy-horse-1.1': 'happyhorse',
};
type Dialect = 'seedance' | 'kling' | 'happyhorse';

/** Happy Horse takes duration as an INTEGER (Seedance and Kling both take a string) and offers the
 *  widest aspect range in the roster. A wrong TYPE is a 422, so the dialects cannot be merged. */
const HH_ASPECTS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '5:4', '4:5']);
const HH_RESOLUTIONS = new Set(['720p', '1080p']);
const HH_MAX_REFERENCES = 4;

const KLING_ASPECTS = new Set(['16:9', '9:16', '1:1']);
/** Kling accepts whole seconds 3–15. */
const KLING_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/**
 * Duration enums are per MODEL, not per dialect: Seedance 2.0 accepts 4-15s, 2.5 accepts 4-30s.
 * Sharing one range would silently clamp a 30-second request on 2.5 to 15 — the model's headline
 * capability, paid for and unreachable, with nothing reporting why.
 */
const DURATIONS_BY_FAMILY: Record<string, number[]> = {
  'bytedance/seedance-2.5': Array.from({ length: 27 }, (_, i) => i + 4), // 4..30
};
const DEFAULT_DURATIONS = Array.from({ length: 12 }, (_, i) => i + 4); // 4..15
const ASPECTS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const RESOLUTIONS = new Set(['480p', '720p', '1080p', '4k']);
/** Per-second price by resolution (fal, verified 2026-08-29) — video cost scales with BOTH. */
const COST_PER_SEC: Record<string, number> = { '480p': 0.07, '720p': 0.16, '1080p': 0.34, '4k': 1.37 };
/** Seedance reference caps, from the live schema: 9 images + 3 clips + 3 audio in ONE generation. */
const MAX_REFERENCES = 9;
const MAX_VIDEO_REFS = 3;
const MAX_AUDIO_REFS = 3;

/** How long we wait for one clip before calling it: video is minutes, but not unbounded. */
const MAX_WAIT_MS = 8 * 60_000;
const POLL_MS = 3_000;

/** Snap a requested duration onto the enum THIS model actually accepts. */
function clampDuration(sec: number | undefined, family: string): string {
  if (!sec) return 'auto';
  const range = DURATIONS_BY_FAMILY[family] ?? DEFAULT_DURATIONS;
  return String(range.reduce((a, b) => (Math.abs(b - sec) < Math.abs(a - sec) ? b : a)));
}

function statusFrom(code: number): VideoErrorReason {
  if (code === 401 || code === 403) return 'no_key';
  if (code === 429) return 'rate_limited';
  if (code === 422 || code === 400) return 'bad_request';
  return 'unknown';
}

/**
 * Pick the endpoint and build its input from what the caller actually supplied — the inputs ARE the
 * task. Pure and exported so this routing can be proven WITHOUT a paid render.
 */
export function planFalRequest(
  req: VideoRequest,
  family: string,
  dialect: Dialect = 'seedance',
): { path: string; input: Record<string, unknown> } {
  if (dialect === 'kling') return planKling(req, family);
  if (dialect === 'happyhorse') return planHappyHorse(req, family);
  return planSeedance(req, family);
}

/** Happy Horse: integer durations, the widest aspect range, and a reference pool. */
function planHappyHorse(req: VideoRequest, family: string): { path: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (req.aspectRatio && HH_ASPECTS.has(req.aspectRatio)) input.aspect_ratio = req.aspectRatio;
  if (req.resolution && HH_RESOLUTIONS.has(req.resolution)) input.resolution = req.resolution;
  // INTEGER, not a string — the same value in the wrong type is a 422.
  if (req.durationSec) input.duration = Math.max(3, Math.min(15, Math.round(req.durationSec)));

  if (req.startFrame) {
    input.image_url = req.startFrame;
    return { path: `${family}/image-to-video`, input };
  }
  if (req.references && req.references.length > 0) {
    input.image_urls = req.references.slice(0, HH_MAX_REFERENCES);
    return { path: `${family}/reference-to-video`, input };
  }
  return { path: `${family}/text-to-video`, input };
}

/**
 * Kling: the SEQUENCE model. `multi_prompt` renders several shots as one clip with a shared audio
 * timeline — the reason it exists in the roster — so a sequence request must reach that parameter
 * rather than being flattened into a single prompt.
 */
function planKling(req: VideoRequest, family: string): { path: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = {};
  const shots = (req.shots ?? []).filter((s) => s.trim());
  if (shots.length > 1) {
    // Each shot is an OBJECT with its own duration — not a bare string (fal rejects those with a
    // 422 the queue reports as COMPLETED, which is how this hid). Split the requested runtime evenly
    // across shots so a 10s three-shot sequence is three ~3s beats rather than three 10s clips.
    const per = req.durationSec ? Math.max(1, Math.min(15, Math.round(req.durationSec / shots.length))) : 5;
    input.multi_prompt = shots.map((prompt) => ({ prompt, duration: String(per) }));
    input.shot_type = 'customize'; // the caller wrote the shots; don't let the model re-cut them
  } else {
    input.prompt = shots[0] ?? req.prompt;
  }
  if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
  if (req.aspectRatio && KLING_ASPECTS.has(req.aspectRatio)) input.aspect_ratio = req.aspectRatio;
  if (typeof req.audio === 'boolean') input.generate_audio = req.audio;
  if (req.durationSec && !input.multi_prompt) {
    input.duration = String(
      KLING_DURATIONS.reduce((a, b) => (Math.abs(b - req.durationSec!) < Math.abs(a - req.durationSec!) ? b : a)),
    );
  }
  // Kling animates from a single start frame; it has no multi-reference pool.
  if (req.startFrame) {
    input.image_url = req.startFrame;
    return { path: `${family}/image-to-video`, input };
  }
  return { path: `${family}/text-to-video`, input };
}

function planSeedance(req: VideoRequest, family: string): { path: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (req.aspectRatio && ASPECTS.has(req.aspectRatio)) input.aspect_ratio = req.aspectRatio;
  if (req.resolution && RESOLUTIONS.has(req.resolution)) input.resolution = req.resolution;
  if (typeof req.audio === 'boolean') input.generate_audio = req.audio;
  input.duration = clampDuration(req.durationSec, family);

  // A start frame — plus an end frame makes it keyframe interpolation.
  if (req.startFrame) {
    input.image_url = req.startFrame;
    if (req.endFrame) input.end_image_url = req.endFrame;
    return { path: `${family}/image-to-video`, input };
  }
  // References guide the whole clip rather than acting as frames — and they are not only images.
  // Seedance addresses each one from the PROMPT (@Image1, @Video2, @Audio1), so the adapter appends a
  // legend naming what each slot holds; without it the model receives the media but is never told
  // what to do with any of it.
  const images = (req.references ?? []).slice(0, MAX_REFERENCES);
  const videos = (req.videoRefs ?? []).slice(0, MAX_VIDEO_REFS);
  const audio = (req.audioRefs ?? []).slice(0, MAX_AUDIO_REFS);
  if (images.length > 0 || videos.length > 0 || audio.length > 0) {
    if (images.length) input.image_urls = images;
    if (videos.length) input.video_urls = videos;
    if (audio.length) input.audio_urls = audio;
    input.prompt = `${req.prompt}${seedanceLegend(images.length, videos.length, audio.length)}`;
    return { path: `${family}/reference-to-video`, input };
  }
  return { path: `${family}/text-to-video`, input };
}

/**
 * Seedance addresses references positionally FROM THE PROMPT (@Image1, @Video2, @Audio1). Attaching
 * media without naming it is the silent-failure case: the request succeeds, the reference is ignored,
 * and nothing reports why. Returns '' when there is nothing attached.
 */
export function seedanceLegend(images: number, videos: number, audio: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= images; i++) parts.push(`@Image${i}`);
  for (let i = 1; i <= videos; i++) parts.push(`@Video${i}`);
  for (let i = 1; i <= audio; i++) parts.push(`@Audio${i}`);
  if (parts.length === 0) return '';
  return `\n\nAttached references, addressable in this prompt: ${parts.join(', ')}.`;
}

type Submitted = { request_id?: string; status_url?: string; response_url?: string };
type JobStatus = { status?: string; queue_position?: number };
type JobResult = { video?: { url?: string }; videos?: Array<{ url?: string }> };

class FalVideoExecutor implements VideoExecutor {
  readonly provider = 'fal';

  isConfigured(): boolean {
    return !!process.env.FAL_API_KEY;
  }

  /** Pull the provider's own explanation for a failed job. Never throws — a missing explanation is
   *  still better handled than a crash on the error path. */
  private async failureDetail(responseUrl: string | undefined, key: string): Promise<string> {
    if (!responseUrl) return '';
    try {
      const res = await fetch(responseUrl, { headers: { Authorization: `Key ${key}` } });
      const body = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown; message?: unknown };
        const d = parsed.detail ?? parsed.error ?? parsed.message;
        return (typeof d === 'string' ? d : JSON.stringify(d ?? '')).slice(0, 300);
      } catch {
        return body.slice(0, 300);
      }
    } catch {
      return '';
    }
  }

  async *generate(req: VideoRequest): AsyncIterable<VideoEvent> {
    const key = process.env.FAL_API_KEY;
    if (!key) {
      yield { type: 'error', reason: 'no_key' };
      return;
    }
    const family = ENDPOINT_FAMILY[req.modelId];
    if (!family) {
      yield { type: 'error', reason: 'bad_request', detail: `no fal endpoint for ${req.modelId}` };
      return;
    }

    const { path, input } = planFalRequest(req, family, DIALECT[req.modelId] ?? 'seedance');
    const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };

    // 1. SUBMIT — returns immediately with a job handle.
    let submitted: Submitted | null = null;
    try {
      const res = await fetch(`https://queue.fal.run/${path}`, { method: 'POST', headers, body: JSON.stringify(input) });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`[fal-video] ${path} ${res.status}: ${detail.slice(0, 300)}`);
        yield { type: 'error', reason: statusFrom(res.status), detail: detail.slice(0, 200) || undefined };
        return;
      }
      submitted = (await res.json().catch(() => null)) as Submitted | null;
    } catch {
      yield { type: 'error', reason: 'transport' };
      return;
    }
    if (!submitted?.request_id || !submitted.status_url) {
      yield { type: 'error', reason: 'unknown', detail: 'fal accepted the job but returned no handle' };
      return;
    }
    yield { type: 'queued', jobId: submitted.request_id };

    // 2. POLL — report movement so a multi-minute render never looks frozen.
    const started = Date.now();
    let lastStage = '';
    for (;;) {
      if (Date.now() - started > MAX_WAIT_MS) {
        yield { type: 'error', reason: 'timeout', detail: `no result after ${Math.round(MAX_WAIT_MS / 60000)} minutes` };
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));

      let status: JobStatus | null = null;
      try {
        const res = await fetch(submitted.status_url, { headers: { Authorization: `Key ${key}` } });
        if (!res.ok) {
          if (res.status >= 500) continue; // a transient status blip is not a failed render
          yield { type: 'error', reason: statusFrom(res.status) };
          return;
        }
        status = (await res.json().catch(() => null)) as JobStatus | null;
      } catch {
        continue; // keep polling through a dropped connection
      }

      const state = status?.status ?? '';
      if (state === 'COMPLETED') break;
      if (state === 'IN_QUEUE' || state === 'IN_PROGRESS') {
        const stage =
          state === 'IN_QUEUE'
            ? `Queued${status?.queue_position ? ` · position ${status.queue_position}` : ''}`
            : 'Generating…';
        if (stage !== lastStage) {
          lastStage = stage;
          yield { type: 'progress', stage };
        }
        continue;
      }
      // A failed job knows WHY, and the reason lives on the response endpoint rather than the status
      // one. Reporting a bare status here sends you hunting for an adapter bug when the truth is
      // usually concrete (an unreachable reference image, a moderated prompt). Ask, then say.
      const detail = await this.failureDetail(submitted.response_url, key);
      console.warn(`[fal-video] ${path} job ${state || 'failed'}: ${detail || '(no detail)'}`);
      yield {
        type: 'error',
        reason: /moderat|safety|nsfw|policy/i.test(detail) ? 'moderated' : 'unknown',
        detail: detail || `fal reported status ${state || 'unknown'}`,
      };
      return;
    }

    // 3. COLLECT.
    let result: JobResult | null = null;
    try {
      const res = await fetch(submitted.response_url ?? submitted.status_url.replace(/\/status$/, ''), {
        headers: { Authorization: `Key ${key}` },
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        console.warn(`[fal-video] ${path} result ${res.status}: ${body}`);
        yield { type: 'error', reason: statusFrom(res.status), detail: body || undefined };
        return;
      }
      result = (await res.json().catch(() => null)) as JobResult | null;
    } catch {
      yield { type: 'error', reason: 'transport' };
      return;
    }

    // A job can finish "successfully" and still hand back a validation error — fal marks the request
    // COMPLETED and puts a 422 body on the response. Without this the adapter reported a bare
    // 'bad_request' and the actual message ("multi_prompt[0] should be an object") was discarded.
    const failure = (result as { detail?: unknown } | null)?.detail;
    if (failure) {
      const detail = (typeof failure === 'string' ? failure : JSON.stringify(failure)).slice(0, 300);
      console.warn(`[fal-video] ${path} rejected the input: ${detail}`);
      yield { type: 'error', reason: 'bad_request', detail };
      return;
    }

    const urls = [result?.video?.url, ...(result?.videos ?? []).map((v) => v?.url)].filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    );
    if (urls.length === 0) {
      yield { type: 'error', reason: 'unknown', detail: 'the job completed but returned no video' };
      return;
    }

    const clips: VideoClip[] = [];
    let index = 0;
    for (const url of urls) {
      const clip: VideoClip = { url, durationSec: req.durationSec, hasAudio: req.audio ?? undefined };
      clips.push(clip);
      yield { type: 'clip', clip, index: index++ };
    }

    const perSec = COST_PER_SEC[req.resolution ?? '720p'] ?? COST_PER_SEC['720p'];
    yield { type: 'done', clips, costUsd: Number((perSec * (req.durationSec ?? 5) * clips.length).toFixed(3)) };
  }
}

registerVideoExecutor(new FalVideoExecutor());
