/**
 * xAI adapter — Grok Imagine image generation (grok-imagine-image-2.0, shipped 2026-08-07).
 *
 * OpenAI-compatible. Text-to-image via POST /v1/images/generations; with references, POST
 * /v1/images/edits (multipart) — xAI's Imagine API accepts up to 3 source/reference images to
 * character-match / compose (1K/2K output). Reads XAI_API_KEY.
 */

import {
  registerExecutor,
  type GenEvent,
  type GenImage,
  type GenRequest,
  type ImageExecutor,
} from '../executor';
import { reasonForStatus, referenceLegend } from './_util';

const API_MODEL: Record<string, string> = { 'grok-imagine-image-2.0': 'grok-imagine-image-2.0', 'grok-2-image': 'grok-2-image' };
const COST_PER_IMAGE = 0.05;
/** xAI's Imagine edit endpoint accepts up to 3 source images (docs, verified 2026-08-29). */
const MAX_EDIT_IMAGES = 3;

class XaiExecutor implements ImageExecutor {
  readonly provider = 'xai' as const;

  isConfigured(): boolean {
    return !!process.env.XAI_API_KEY;
  }

  async *generate(req: GenRequest): AsyncIterable<GenEvent> {
    const key = process.env.XAI_API_KEY;
    if (!key) {
      yield { type: 'error', reason: 'no_key' };
      return;
    }
    const model = API_MODEL[req.modelId] ?? 'grok-imagine-image-2.0';
    const n = Math.max(1, req.n);
    const refs = req.references ?? [];

    let res: Response;
    try {
      if (refs.length > 0) {
        // Reference / character-match → images/edits. This endpoint takes JSON, NOT multipart: the
        // adapter used to POST a FormData body and every reference render died on
        // `415 Expected request with Content-Type: application/json` while text-only worked.
        // Shape verified live 2026-08-29: `images` is an ARRAY of {url, type:'image_url'} objects
        // (`image` takes exactly one; an array of bare strings is rejected). URLs may be https or
        // data: URIs, so browser uploads pass straight through. Capped at the documented 3.
        const images = refs.slice(0, MAX_EDIT_IMAGES).map((url) => ({ url, type: 'image_url' as const }));
        res = await fetch('https://api.x.ai/v1/images/edits', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: req.prompt + referenceLegend(req.slotted, req.references),
            images,
          }),
        });
      } else {
        res = await fetch('https://api.x.ai/v1/images/generations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: req.prompt, n, response_format: 'url' }),
        });
      }
    } catch {
      yield { type: 'error', reason: 'transport' };
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (detail) console.warn(`[xai] ${res.status}: ${detail.slice(0, 300)}`);
      yield { type: 'error', reason: reasonForStatus(res.status), detail: detail.slice(0, 200) || undefined };
      return;
    }
    const data = (await res.json().catch(() => null)) as { data?: Array<{ url?: string; b64_json?: string }> } | null;
    const images: GenImage[] = [];
    let index = 0;
    for (const d of data?.data ?? []) {
      const url = d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : null);
      if (url) {
        const image = { url };
        images.push(image);
        yield { type: 'tile', image, index: index++ };
      }
    }
    if (images.length === 0) {
      yield { type: 'error', reason: 'unknown' };
      return;
    }
    yield { type: 'done', images, costUsd: Number((COST_PER_IMAGE * images.length).toFixed(3)) };
  }
}

registerExecutor(new XaiExecutor());

export { XaiExecutor };
