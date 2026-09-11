/**
 * Shared adapter helpers — reference fetching + a common HTTP→reason mapping. Kept tiny; adapters
 * stay otherwise self-contained (each owns its provider's request shape).
 */

import type { GenErrorReason } from '../executor';

/** Fetch a reference (data: or http[s]) into a Blob for multipart upload, or null on failure. */
export async function fetchAsBlob(ref: string): Promise<Blob | null> {
  try {
    if (ref.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(ref);
      if (!m) return null;
      return new Blob([Buffer.from(m[2], 'base64')], { type: m[1] });
    }
    const res = await fetch(ref);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/** The common HTTP-status → normalized reason mapping. Adapters override where a provider differs
 *  (e.g. Gemini's 403 = billing, not auth). */
export function reasonForStatus(status: number): GenErrorReason {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'no_key';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'transport';
  return 'unknown';
}

/**
 * A REFERENCE LEGEND for models whose input is one flat pool.
 *
 * Only some providers expose typed parameters (Ideogram's character vs style refs). The rest —
 * Gemini, FLUX, OpenAI — take an undifferentiated list, and the ONLY way to tell them what each
 * image is for is to say so in the prompt. FLUX is explicitly index-addressable ("the person from
 * image 1"); Gemini's guide teaches naming what each reference contributes. Without this the model
 * has to guess, and a character reference gets treated as a mood board.
 *
 * Returns '' when there is nothing worth saying (no references, or none carry a specific role) so a
 * plain prompt is never padded with boilerplate.
 */
export function referenceLegend(
  slotted: { url: string; role: string }[] | undefined,
  refs: string[] | undefined,
): string {
  const list = slotted?.length ? slotted : (refs ?? []).map((url) => ({ url, role: 'general' }));
  if (list.length === 0) return '';
  if (list.every((r) => r.role === 'general' || r.role === 'subject')) return '';

  const WORDS: Record<string, string> = {
    character: 'the character to keep consistent',
    style: 'the style/aesthetic to apply (not the subject)',
    object: 'an object to reproduce faithfully',
    subject: 'the base image being edited',
    sketch: 'the sketch/layout to render from',
    general: 'a reference',
  };
  const lines = list.map((r, i) => `Image ${i + 1}: ${WORDS[r.role] ?? WORDS.general}.`);
  return `\n\nReference images — ${lines.join(' ')}`;
}
