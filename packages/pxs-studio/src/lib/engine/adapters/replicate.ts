/**
 * Replicate adapter — the access layer for Flux (direct BFL is dropped; Flux runs here) and specialty
 * models. Implements the ImageExecutor seam over Replicate's predictions API (raw fetch; reads
 * REPLICATE_API_TOKEN).
 *
 * Uses `Prefer: wait` so a create returns the finished prediction in one round-trip (Flux is seconds);
 * if it hasn't settled we poll the prediction a few times. N images = N parallel predictions, each tile
 * streamed on completion. Output is a hosted URL (or array) — surfaced as-is.
 *
 * Model paths are current-as-seeded; confirmed live in the phase-two doc-lookup pass.
 */

import {
  registerExecutor,
  type GenEvent,
  type GenImage,
  type GenErrorReason,
  type GenRequest,
  type ImageExecutor,
} from '../executor';
import { reasonForStatus } from './_util';

/** registry modelId → Replicate "owner/model". */
const MODEL_PATH: Record<string, string> = {
  'flux-2-pro': 'black-forest-labs/flux-2-pro',
  'flux-2-dev': 'black-forest-labs/flux-2-dev',
};

/** Rough per-image estimate (registry carries the real band). */
const COST_PER_IMAGE = 0.04;

interface Prediction {
  status?: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
}

function firstUrl(output: Prediction['output']): string | null {
  if (!output) return null;
  if (typeof output === 'string') return output;
  const hit = output.find((o) => typeof o === 'string');
  return hit ?? null;
}

class ReplicateExecutor implements ImageExecutor {
  readonly provider = 'replicate' as const;

  isConfigured(): boolean {
    return !!process.env.REPLICATE_API_TOKEN;
  }

  /** One prediction → one image (or an error reason). */
  private async one(req: GenRequest, key: string): Promise<{ image?: GenImage; error?: GenErrorReason }> {
    const path = MODEL_PATH[req.modelId];
    if (!path) return { error: 'bad_request' };

    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    // FLUX.2 multi-reference: input_image (first) + input_image_2..input_image_9 (up to 8 refs total).
    if (req.references && req.references.length > 0) {
      input.input_image = req.references[0];
      for (let i = 1; i < Math.min(req.references.length, 9); i++) {
        input[`input_image_${i + 1}`] = req.references[i];
      }
    }

    let res: Response;
    try {
      res = await fetch(`https://api.replicate.com/v1/models/${path}/predictions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'wait',
        },
        body: JSON.stringify({ input }),
      });
    } catch {
      return { error: 'transport' };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (detail) console.warn(`[replicate] ${res.status}: ${detail.slice(0, 300)}`);
      return { error: reasonForStatus(res.status) };
    }

    let pred = (await res.json().catch(() => null)) as Prediction | null;
    // If Prefer:wait timed out before completion, poll a few times.
    for (let i = 0; i < 8 && pred && (pred.status === 'starting' || pred.status === 'processing'); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const getUrl = pred.urls?.get;
      if (!getUrl) break;
      const p = await fetch(getUrl, { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
      if (!p || !p.ok) break;
      pred = (await p.json().catch(() => null)) as Prediction | null;
    }

    if (!pred || pred.status === 'failed' || pred.status === 'canceled') {
      return { error: pred?.error ? 'bad_request' : 'unknown' };
    }
    const url = firstUrl(pred.output);
    return url ? { image: { url } } : { error: 'unknown' };
  }

  async *generate(req: GenRequest): AsyncIterable<GenEvent> {
    const key = process.env.REPLICATE_API_TOKEN;
    if (!key) {
      yield { type: 'error', reason: 'no_key' };
      return;
    }

    const n = Math.max(1, req.n);
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
    yield { type: 'done', images, costUsd: Number((COST_PER_IMAGE * images.length).toFixed(3)) };
  }
}

registerExecutor(new ReplicateExecutor());

export { ReplicateExecutor };
