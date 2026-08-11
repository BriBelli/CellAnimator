/**
 * Reference aspect-fit — THE GenAI trick (Brian / Photolift / Tao-Prompts-in-Photoshop): to condition a
 * 16:9 render on a portrait reference, the reference must SIT INSIDE a 16:9 frame (centered, padded), or
 * the model warps it, ignores it, or just CLONES it back. So before generation we letterbox every
 * reference onto the target aspect: `contain` the source on a transparent canvas of the render's aspect.
 *
 * Server-side (sharp). Never dead-ends a render — any failure returns the original reference untouched.
 */

import sharp from 'sharp';

/** Parse "W:H" (e.g. "16:9") → [w, h], or null if malformed. */
function parseAspect(a: string): [number, number] | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(a);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : null;
}

/** Load a reference (data: or http[s]) → Buffer, or null. */
async function loadRef(ref: string): Promise<Buffer | null> {
  try {
    if (ref.startsWith('data:')) {
      const i = ref.indexOf(',');
      return i >= 0 ? Buffer.from(ref.slice(i + 1), 'base64') : null;
    }
    const res = await fetch(ref);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Letterbox ONE reference onto the target aspect. Returns a PNG data URL (transparent padding), or the
 * original string on any failure. No-op if the source already matches the aspect within a small epsilon.
 */
export async function fitReferenceToAspect(ref: string, aspect: string): Promise<string> {
  const ar = parseAspect(aspect);
  if (!ar) return ref;
  const buf = await loadRef(ref);
  if (!buf) return ref;
  try {
    const meta = await sharp(buf).metadata();
    const srcW = meta.width ?? 1024;
    const srcH = meta.height ?? 1024;
    const [aw, ah] = ar;
    // Already the right aspect (±1%) → leave it (avoid a needless re-encode).
    if (Math.abs(srcW / srcH - aw / ah) < 0.01) return ref;
    // Target canvas at the aspect, long edge = the source's long edge (no upscaling of the subject).
    const srcLong = Math.max(srcW, srcH);
    const tw = aw >= ah ? srcLong : Math.round((srcLong * aw) / ah);
    const th = aw >= ah ? Math.round((srcLong * ah) / aw) : srcLong;
    const out = await sharp(buf)
      .resize(tw, th, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return `data:image/png;base64,${out.toString('base64')}`;
  } catch {
    return ref;
  }
}

/** Letterbox ALL references onto the aspect (parallel). No refs / no aspect → returned unchanged. */
export async function fitReferencesToAspect(
  refs: string[] | undefined,
  aspect: string | undefined,
): Promise<string[] | undefined> {
  if (!refs || refs.length === 0 || !aspect) return refs;
  return Promise.all(refs.map((r) => fitReferenceToAspect(r, aspect)));
}
