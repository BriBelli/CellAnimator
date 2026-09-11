/**
 * Gemini adapter — the Nano Banana family (Gemini 3 Pro Image / 3.1 Flash Image).
 *
 * Implements the ImageExecutor seam over Google's Generative Language REST API
 * (no new SDK dependency — raw fetch, server-side only). Reads GEMINI_API_KEY from
 * the environment; the registry never sees the key.
 *
 * The family produces one image per call, so N images = N parallel calls, and we
 * stream each tile the moment it lands (completion order) rather than waiting for
 * the whole batch. References (data: or http[s] URLs) are inlined for edit/compose.
 */

import {
  registerExecutor,
  type GenEvent,
  type GenImage,
  type GenErrorReason,
  type GenRequest,
  type ImageExecutor,
} from '../executor';
import { referenceLegend } from './_util';

/** registry modelId → the provider's actual API model string (GA ids verified 2026-08-24).
 *  'nano-banana' kept as an alias so persisted old picks still render (routes to the 3.1 successor). */
const API_MODEL: Record<string, string> = {
  'gemini-3-pro-image': 'gemini-3-pro-image',
  'gemini-3.1-flash-image': 'gemini-3.1-flash-image',
  'nano-banana': 'gemini-3.1-flash-image',
};

const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/** Per-image price at the default 1K-2K output (mirrors the registry cost bands). */
const COST_FOR: Record<string, number> = {
  'gemini-3-pro-image': 0.134,
  'gemini-3.1-flash-image': 0.067,
};
const DEFAULT_COST = 0.067;

interface InlinePart {
  inlineData: { mimeType: string; data: string };
}

/** Fetch a reference image (data: or http[s]) and return an inlineData part, or null. */
async function referencePart(ref: string): Promise<InlinePart | null> {
  try {
    if (ref.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(ref);
      if (!m) return null;
      return { inlineData: { mimeType: m[1], data: m[2] } };
    }
    const res = await fetch(ref);
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    return { inlineData: { mimeType: mime, data: buf.toString('base64') } };
  } catch {
    return null;
  }
}

/** Map an HTTP status to a normalized adapter reason. NOTE: 403 is NOT "no key" — Gemini
 *  returns it for billing-not-enabled / API-not-enabled / region, so a valid key can 403. */
function reasonFor(status: number): GenErrorReason {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'no_key';
  if (status === 400 || status === 403) return 'bad_request';
  if (status >= 500) return 'transport';
  return 'unknown';
}

class GeminiExecutor implements ImageExecutor {
  readonly provider = 'gemini' as const;

  isConfigured(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  /** One generation call → one image (or an error reason). */
  private async one(req: GenRequest, key: string): Promise<{ image?: GenImage; error?: GenErrorReason }> {
    const apiModel = API_MODEL[req.modelId] ?? 'gemini-3.1-flash-image';

    // Gemini's object/character/style pools are SEMANTIC — the API takes one list of inline images
    // and the model learns each one's job from the prompt. So the planner's roles become a legend.
    const parts: Array<{ text: string } | InlinePart> = [
      { text: req.prompt + referenceLegend(req.slotted, req.references) },
    ];
    for (const ref of req.references ?? []) {
      const p = await referencePart(ref);
      if (p) parts.push(p);
    }

    let res: Response;
    try {
      res = await fetch(ENDPOINT(apiModel), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        // responseModalities IMAGE is explicit robustness — don't rely on the model defaulting.
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'] } }),
      });
    } catch {
      return { error: 'transport' };
    }

    if (!res.ok) {
      // Surface the provider's real error message (a valid key can 403 on billing/region) so it's
      // not silently mislabeled.
      const detail = await res.text().catch(() => '');
      if (detail) console.warn(`[gemini] ${res.status}: ${detail.slice(0, 300)}`);
      return { error: reasonFor(res.status) };
    }

    const data = (await res.json().catch(() => null)) as
      | {
          candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }; finishReason?: string }>;
          promptFeedback?: { blockReason?: string };
        }
      | null;

    if (data?.promptFeedback?.blockReason) return { error: 'moderated' };

    const cand = data?.candidates?.[0];
    if (cand?.finishReason && /SAFETY|PROHIBITED|BLOCK/i.test(cand.finishReason)) {
      return { error: 'moderated' };
    }

    const imgPart = cand?.content?.parts?.find((p) => p.inlineData?.data);
    if (!imgPart?.inlineData?.data) {
      // A response with no image and no block reason is a real outcome — usually a transient
      // no-candidate return. Say WHAT came back instead of a bare 'unknown': an unexplained failure
      // sends you hunting for an adapter bug that is not there (it cost a diagnosis cycle already).
      const why = cand?.finishReason
        ? `finishReason=${cand.finishReason}`
        : data?.candidates?.length
          ? 'a candidate with no image part'
          : 'no candidates returned';
      console.warn(`[gemini] ${apiModel}: ${why} — retryable.`);
      return { error: 'unknown' };
    }

    const mime = imgPart.inlineData.mimeType || 'image/png';
    return { image: { url: `data:${mime};base64,${imgPart.inlineData.data}` } };
  }

  async *generate(req: GenRequest): AsyncIterable<GenEvent> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      yield { type: 'error', reason: 'no_key' };
      return;
    }

    const n = Math.max(1, req.n);
    // Fire all calls in parallel; yield each tile in COMPLETION order.
    const tagged = Array.from({ length: n }, (_, i) => this.one(req, key).then((r) => ({ i, r })));
    const pending = new Map(tagged.map((p, i) => [i, p]));

    const images: GenImage[] = [];
    let firstError: GenErrorReason | undefined;
    let index = 0;

    while (pending.size > 0) {
      const { i, r } = await Promise.race(pending.values());
      pending.delete(i);
      if (r.image) {
        images.push(r.image);
        yield { type: 'tile', image: r.image, index: index++ };
      } else if (r.error && !firstError) {
        firstError = r.error;
      }
    }

    if (images.length === 0) {
      yield { type: 'error', reason: firstError ?? 'unknown' };
      return;
    }
    yield { type: 'done', images, costUsd: Number(((COST_FOR[req.modelId] ?? DEFAULT_COST) * images.length).toFixed(3)) };
  }
}

registerExecutor(new GeminiExecutor());

export { GeminiExecutor };
