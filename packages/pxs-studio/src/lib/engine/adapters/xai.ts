/**
 * xAI adapter — Grok image generation (grok-2-image).
 *
 * The public xAI images API is OpenAI-compatible and TEXT-TO-IMAGE: POST /v1/images/generations with a
 * prompt; it does NOT take image references (Grok Imagine's reference feature is a separate surface).
 * So this adapter ignores `references` — the registry marks grok maxReferenceImages:0, so Gate 1 keeps
 * it out of reference fans anyway. Reads XAI_API_KEY. Endpoint/model confirmed against xAI's docs.
 */

import {
  registerExecutor,
  type GenEvent,
  type GenImage,
  type GenRequest,
  type ImageExecutor,
} from '../executor';
import { reasonForStatus } from './_util';

const API_MODEL: Record<string, string> = { 'grok-2-image': 'grok-2-image' };
const COST_PER_IMAGE = 0.05;

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
    const model = API_MODEL[req.modelId] ?? 'grok-2-image';
    const n = Math.max(1, req.n);

    let res: Response;
    try {
      res = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: req.prompt, n, response_format: 'url' }),
      });
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
