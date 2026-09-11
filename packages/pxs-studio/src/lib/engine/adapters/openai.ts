/**
 * OpenAI adapter — GPT Image 1.5 (OpenAI's current image flagship, Dec 2025).
 *
 * Implements the ImageExecutor seam over OpenAI's Images API (raw fetch, server-side; reads
 * OPENAI_API_KEY). Two paths: text→image via /v1/images/generations, and edit / multi-reference via
 * /v1/images/edits (multipart, up to several input images — gpt-image-1's editing strength). gpt-image-1
 * returns base64 (no hosted URL), which we inline as a data URL. Native batch via `n`.
 *
 * NOTE: model + endpoint strings are current-as-seeded; if OpenAI revises them it's a one-line change,
 * and the error path surfaces the provider's real message. (This is exactly the canonical-source concern
 * — confirmed live in the phase-two doc-lookup pass.)
 */

import {
  registerExecutor,
  type GenEvent,
  type GenImage,
  type GenRequest,
  type ImageExecutor,
} from '../executor';
import { fetchAsBlob, reasonForStatus, referenceLegend } from './_util';

const API_MODEL: Record<string, string> = { 'gpt-image-1.5': 'gpt-image-1.5', 'gpt-image-1': 'gpt-image-1' };

/** Map our aspect ratios onto the gpt-image family's supported sizes; 'auto' when unspecified/unknown. */
const SIZE_FOR: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '3:2': '1536x1024',
  '9:16': '1024x1536',
  '2:3': '1024x1536',
};
const sizeFor = (ar?: string): string => (ar && SIZE_FOR[ar]) || 'auto';

/** Mid-band per-image estimate (the registry carries the real cost band; this is the adapter fallback). */
const COST_PER_IMAGE = 0.08;

class OpenAIExecutor implements ImageExecutor {
  readonly provider = 'openai' as const;

  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async *generate(req: GenRequest): AsyncIterable<GenEvent> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      yield { type: 'error', reason: 'no_key' };
      return;
    }

    const model = API_MODEL[req.modelId] ?? 'gpt-image-1.5';
    const n = Math.max(1, req.n);
    const size = sizeFor(req.aspectRatio);

    let res: Response;
    try {
      if (req.references && req.references.length > 0) {
        // Edit / multi-reference → multipart /images/edits.
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', req.prompt + referenceLegend(req.slotted, req.references));
        form.append('n', String(n));
        if (size !== 'auto') form.append('size', size);
        // The field is `image`, REPEATED — not `image[]`. The bracket form is a PHP/Rails
        // convention OpenAI does not parse, so every reference render came back
        // "Missing required parameter: 'image'" while text-only worked fine.
        // Verified 2026-08-29 against the live API.
        let idx = 0;
        for (const ref of req.references) {
          const blob = await fetchAsBlob(ref);
          if (blob) form.append('image', blob, `ref-${idx++}.png`);
        }
        res = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });
      } else {
        res = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: req.prompt, n, ...(size !== 'auto' ? { size } : {}) }),
        });
      }
    } catch {
      yield { type: 'error', reason: 'transport' };
      return;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (detail) console.warn(`[openai] ${res.status}: ${detail.slice(0, 300)}`);
      yield { type: 'error', reason: reasonForStatus(res.status), detail: detail.slice(0, 200) || undefined };
      return;
    }

    const data = (await res.json().catch(() => null)) as { data?: Array<{ b64_json?: string; url?: string }> } | null;
    const images: GenImage[] = [];
    let index = 0;
    for (const d of data?.data ?? []) {
      const url = d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url;
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

registerExecutor(new OpenAIExecutor());

export { OpenAIExecutor };
