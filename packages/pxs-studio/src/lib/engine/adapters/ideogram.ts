/**
 * Ideogram adapter — Ideogram 3.0 (ideogram-v3).
 *
 * Strong typography / in-image text + stylistic range. Ideogram's v3 API is multipart form-data:
 * POST /v1/ideogram-v3/generate with `prompt`, `aspect_ratio`, `rendering_speed`, `num_images`, and
 * optional `style_reference_images` (references). Auth via the `Api-Key` header. Reads IDEOGRAM_API_KEY.
 * Endpoint/fields are current-as-seeded; a rejected request surfaces the provider's real message.
 */

import {
  registerExecutor,
  type GenEvent,
  type GenImage,
  type GenRequest,
  type ImageExecutor,
} from '../executor';
import { fetchAsBlob, reasonForStatus } from './_util';

/** Ideogram aspect strings (their enum uses ASPECT_W_H). */
const ASPECT: Record<string, string> = {
  '1:1': 'ASPECT_1_1',
  '16:9': 'ASPECT_16_9',
  '9:16': 'ASPECT_9_16',
  '3:2': 'ASPECT_3_2',
  '2:3': 'ASPECT_2_3',
};
const COST_PER_IMAGE = 0.06;

class IdeogramExecutor implements ImageExecutor {
  readonly provider = 'ideogram' as const;

  isConfigured(): boolean {
    return !!process.env.IDEOGRAM_API_KEY;
  }

  async *generate(req: GenRequest): AsyncIterable<GenEvent> {
    const key = process.env.IDEOGRAM_API_KEY;
    if (!key) {
      yield { type: 'error', reason: 'no_key' };
      return;
    }

    const form = new FormData();
    form.append('prompt', req.prompt);
    form.append('num_images', String(Math.max(1, req.n)));
    form.append('rendering_speed', 'DEFAULT');
    if (req.aspectRatio && ASPECT[req.aspectRatio]) form.append('aspect_ratio', ASPECT[req.aspectRatio]);
    // References → style reference images (Ideogram conditions on them).
    for (const ref of req.references ?? []) {
      const blob = await fetchAsBlob(ref);
      if (blob) form.append('style_reference_images', blob, 'ref.png');
    }

    let res: Response;
    try {
      res = await fetch('https://api.ideogram.ai/v1/ideogram-v3/generate', {
        method: 'POST',
        headers: { 'Api-Key': key },
        body: form,
      });
    } catch {
      yield { type: 'error', reason: 'transport' };
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (detail) console.warn(`[ideogram] ${res.status}: ${detail.slice(0, 300)}`);
      yield { type: 'error', reason: reasonForStatus(res.status), detail: detail.slice(0, 200) || undefined };
      return;
    }
    const data = (await res.json().catch(() => null)) as { data?: Array<{ url?: string }> } | null;
    const images: GenImage[] = [];
    let index = 0;
    for (const d of data?.data ?? []) {
      if (d.url) {
        const image = { url: d.url };
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

registerExecutor(new IdeogramExecutor());

export { IdeogramExecutor };
