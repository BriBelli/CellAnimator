/**
 * Recraft adapter — the vector / SVG / brand specialist (Recraft V4.1).
 *
 * Implements the ImageExecutor seam over Recraft's images API (raw fetch; reads RECRAFT_API_KEY).
 * One image per call → N images = N parallel calls, each tile streamed on completion. Output is a
 * hosted URL.
 *
 * MODEL PER CAPABILITY: unlike every other provider here, Recraft ships raster and VECTOR as separate
 * model ids rather than a parameter — so a request that needs SVG must be sent to `recraftv4_1_vector`
 * or it silently comes back as raster. That's why this adapter reads `req.needs`.
 *
 * Verified 2026-08-28 against the V4.1 API reference. Previously pinned to `recraftv3` (Oct 2024)
 * while V4.1 had been the API's DEFAULT since May 2026 — we were opting IN to a two-generation-old
 * model on every call.
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

/** registry id → Recraft's raster model. `recraft-v3` stays mapped to the SUCCESSOR so a persisted
 *  pick from before the upgrade still renders (and renders better) rather than 400-ing. */
const API_MODEL: Record<string, string> = {
  'recraft-v4.1': 'recraftv4_1',
  'recraft-v3': 'recraftv4_1',
};
/** The vector twin of each raster model — chosen when the request actually needs SVG. */
const VECTOR_MODEL: Record<string, string> = { recraftv4_1: 'recraftv4_1_vector' };

/** Per-image price by variant (registry carries the band; this is the adapter's own report). */
const COST_BY_MODEL: Record<string, number> = { recraftv4_1: 0.035, recraftv4_1_vector: 0.08 };

/** Recraft accepts `size` as "WxH" OR "w:h", and auto-selects from the prompt when omitted — so our
 *  ratios pass straight through and an unknown one becomes the model's own sensible choice rather
 *  than a wrong hardcoded box. */
const sizeFor = (ar?: string): string | undefined => (ar && /^\d+:\d+$/.test(ar) ? ar : undefined);

class RecraftExecutor implements ImageExecutor {
  readonly provider = 'recraft' as const;

  isConfigured(): boolean {
    return !!process.env.RECRAFT_API_KEY;
  }

  private async one(req: GenRequest, key: string): Promise<{ image?: GenImage; error?: GenErrorReason }> {
    const raster = API_MODEL[req.modelId] ?? 'recraftv4_1';
    // Vector is a MODEL, not a flag: without this an SVG request quietly returns a raster PNG.
    const model = req.needs?.includes('vector') ? (VECTOR_MODEL[raster] ?? raster) : raster;
    const size = sizeFor(req.aspectRatio);
    let res: Response;
    try {
      res = await fetch('https://external.api.recraft.ai/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: req.prompt, model, ...(size ? { size } : {}) }),
      });
    } catch {
      return { error: 'transport' };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (detail) console.warn(`[recraft] ${res.status}: ${detail.slice(0, 300)}`);
      return { error: reasonForStatus(res.status) };
    }
    const data = (await res.json().catch(() => null)) as { data?: Array<{ url?: string; b64_json?: string }> } | null;
    const d = data?.data?.[0];
    const url = d?.url ?? (d?.b64_json ? `data:image/png;base64,${d.b64_json}` : null);
    return url ? { image: { url } } : { error: 'unknown' };
  }

  async *generate(req: GenRequest): AsyncIterable<GenEvent> {
    const key = process.env.RECRAFT_API_KEY;
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
    // Vector costs more than raster — report what this run actually used, not a flat average.
    const variant = req.needs?.includes('vector') ? 'recraftv4_1_vector' : 'recraftv4_1';
    yield { type: 'done', images, costUsd: Number(((COST_BY_MODEL[variant] ?? 0.035) * images.length).toFixed(3)) };
  }
}

registerExecutor(new RecraftExecutor());

export { RecraftExecutor };
