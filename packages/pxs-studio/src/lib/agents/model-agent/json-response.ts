/**
 * ONE JSON reader for every agent call — because three of them hand-rolled `JSON.parse(slice)` and
 * all three broke the same way in production.
 *
 * What actually went wrong (dev log, 2026-08-25): the research extractor ran for an hour failing on
 * EVERY model with a different error each time — `Unexpected end of JSON input`, ```` ```json ````
 * fences, and raw prose fragments. Three causes behind one symptom:
 *   1. TOKEN STARVATION — thinking is on, so a budget sized for the old small schema left nothing
 *      for the answer. The reply was cut mid-object, or never got past thinking at all.
 *   2. MARKDOWN FENCES — "respond with ONLY JSON" is a request, not a guarantee.
 *   3. NO SALVAGE — one malformed character threw away an entire paid call (web fetches included).
 *
 * So parsing is now defensive by default AND truncation is reported, never swallowed: a caller that
 * gets `truncated: true` must treat the result as incomplete (mark it low-confidence, re-run later)
 * rather than storing a half-answer that looks whole.
 */

/** Concatenate the text blocks of an Anthropic response (ignoring thinking blocks). */
export function responseText(msg: unknown): string {
  const content = ((msg as { content?: Array<{ type: string; text?: string }> })?.content ?? []);
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

/** Did the model run out of budget mid-answer? */
export function wasTruncated(msg: unknown): boolean {
  return (msg as { stop_reason?: string })?.stop_reason === 'max_tokens';
}

/**
 * Parse a model's JSON answer, tolerating markdown fences and salvaging a truncated object by
 * closing whatever was left open at the last complete element. Returns null when there is genuinely
 * no object to recover — callers must handle that as a failed call, not an empty result.
 */
export function parseJsonResponse(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip a markdown fence if the model wrapped its answer despite being asked not to.
  const text = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

  const start = text.indexOf('{');
  if (start < 0) return null;
  const body = text.slice(start);

  const end = body.lastIndexOf('}');
  if (end > 0) {
    try {
      return JSON.parse(body.slice(0, end + 1)) as Record<string, unknown>;
    } catch {
      /* fall through to repair */
    }
  }

  // Repair: cut back to the last element boundary that is OUTSIDE a string, then close what's open.
  let inStr = false;
  let escaped = false;
  let lastSafe = -1;
  const depth: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') depth.pop();
    else if (c === ',' && depth.length > 0) lastSafe = i;
  }
  if (lastSafe < 0) return null;

  let repaired = body.slice(0, lastSafe);
  const open: string[] = [];
  inStr = false; escaped = false;
  for (let i = 0; i < repaired.length; i++) {
    const c = repaired[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') open.push('}');
    else if (c === '[') open.push(']');
    else if (c === '}' || c === ']') open.pop();
  }
  repaired += open.reverse().join('');
  try {
    return JSON.parse(repaired) as Record<string, unknown>;
  } catch {
    return null;
  }
}
