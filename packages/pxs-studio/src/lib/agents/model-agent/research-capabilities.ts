/**
 * Grounded capability research — the core of a REAL Model agent. For one model it: (1) searches the web
 * for its capability docs (Tavily), (2) hands the FETCHED text to Claude, which extracts ONLY what the
 * sources state — ref limits, file-size caps, editing, features — never from memory, (3) returns the
 * facts + PROVENANCE (the source URLs) + a confidence. High-confidence results replace the hand-typed
 * registry guesses; low-confidence stays "unverified" (honest, never faked).
 *
 * This is what ends the "I explain Grok's limits to you by hand" cycle: the agent reads the docs itself.
 */

import Anthropic from '@anthropic-ai/sdk';
import { tavilySearch, tavilyConfigured, type WebResult } from './tavily';

const MODEL = 'claude-opus-4-8';

export interface CapabilityResearch {
  modelId: string;
  /** Extracted ONLY when the sources state it (else undefined — omitted, not guessed). */
  maxReferenceImages?: number;
  supportsEditing?: boolean;
  capabilities?: string[];
  aspectRatios?: string[];
  notes?: string;
  confidence: 'high' | 'medium' | 'low';
  /** Provenance — the sources the facts came from. Empty = nothing found (unverified). */
  sources: { url: string; title: string }[];
}

const SYSTEM = `You are the Model agent's capability researcher. You are given SEARCH RESULTS (title, url, extracted text) about ONE image-generation model. Extract ONLY the capability facts the SOURCES actually state — NEVER from your own memory, NEVER a guess. If a fact is not supported by the sources, OMIT it (null / leave the array empty).

Extract when stated:
- maxReferenceImages: max reference/source/input images the model's generation or edit API accepts (integer). If the docs say there is NO count limit (only a file-SIZE limit), use 8.
- supportsEditing: whether it has an edit / img2img / reference path (boolean).
- capabilities: any of ["text_in_image","editing","multi_reference","photorealism","vector","high_resolution","fast","cheap"] the sources support.
- aspectRatios: ratios like "16:9" if the sources list them.
- notes: ONE line of the key constraints (e.g. "no count limit; <=20 MiB per image; edits accepts up to 3 source images").
- confidence: "high" if official/provider docs agree, "medium" if only secondary sources, "low" if thin or conflicting.

Respond with ONLY a JSON object, no prose:
{"maxReferenceImages":<int|null>,"supportsEditing":<bool|null>,"capabilities":[...],"aspectRatios":[...],"notes":"<one line>","confidence":"high|medium|low"}`;

export async function researchModelCapabilities(
  model: { id: string; label: string; provider: string; docsUrl?: string },
  opts: { client?: Anthropic } = {},
): Promise<CapabilityResearch> {
  const base: CapabilityResearch = { modelId: model.id, confidence: 'low', sources: [] };
  if (!tavilyConfigured()) return base;

  const query = `${model.label} (${model.provider}) image generation API: maximum reference / input images, file size limits, editing / image-to-image support, supported aspect ratios`;
  const results: WebResult[] = await tavilySearch(query, { maxResults: 6 });
  if (results.length === 0) return base;

  const client = opts.client ?? new Anthropic();
  const corpus = results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content.slice(0, 1500)}`)
    .join('\n\n');

  const sources = results.map((r) => ({ url: r.url, title: r.title }));
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `MODEL: ${model.label} (${model.provider})\n\nSEARCH RESULTS:\n${corpus}` }],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const text = ((msg.content ?? []) as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text) as Record<string, unknown>;

    return {
      modelId: model.id,
      maxReferenceImages: typeof parsed.maxReferenceImages === 'number' ? parsed.maxReferenceImages : undefined,
      supportsEditing: typeof parsed.supportsEditing === 'boolean' ? parsed.supportsEditing : undefined,
      capabilities: Array.isArray(parsed.capabilities) ? (parsed.capabilities as string[]) : undefined,
      aspectRatios: Array.isArray(parsed.aspectRatios) ? (parsed.aspectRatios as string[]) : undefined,
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence as string) ? (parsed.confidence as 'high' | 'medium' | 'low') : 'low',
      sources,
    };
  } catch (err) {
    console.warn('[research] extraction failed:', err);
    return { ...base, sources };
  }
}
