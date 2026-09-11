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

/**
 * Ideogram v3 aspect strings. The v3 API takes "WxH" — the ASPECT_W_H enum here was the v1/v2 form
 * and v3 rejects it outright (400: "'ASPECT_1_1' is not one of [...]"), so EVERY Ideogram render
 * failed the moment an aspect ratio was set. Verified against the live API 2026-08-27; the full
 * accepted set is below, so we no longer silently drop ratios Ideogram actually supports.
 */
const ASPECT: Record<string, string> = {
  '1:1': '1x1',
  '16:9': '16x9',
  '9:16': '9x16',
  '3:2': '3x2',
  '2:3': '2x3',
  '4:3': '4x3',
  '3:4': '3x4',
  '4:5': '4x5',
  '5:4': '5x4',
  '16:10': '16x10',
  '10:16': '10x16',
  '2:1': '2x1',
  '1:2': '1x2',
  '3:1': '3x1',
  '1:3': '1x3',
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
    // References → their REAL channels. Ideogram keeps style and character references separate and
    // uses them differently: a face in `style_reference_images` conditions the palette, not the
    // person. The planner already decided which is which (typed slots, researched from the docs) —
    // honour it. Falls back to style refs only when nothing was routed, preserving old behaviour.
    const slotted = req.slotted?.length
      ? req.slotted
      : (req.references ?? []).map((url) => ({ url, param: 'style_reference_images', role: 'style' as const }));
    for (const ref of slotted) {
      const blob = await fetchAsBlob(ref.url);
      if (!blob) continue;
      const param = ref.param === 'character_reference_images' ? 'character_reference_images' : 'style_reference_images';
      form.append(param, blob, `${param}.png`);
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
