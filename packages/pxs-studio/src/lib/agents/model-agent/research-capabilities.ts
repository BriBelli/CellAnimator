/**
 * Grounded capability research — the core of a REAL Model agent. For one model it: (1) searches the web
 * for its capability docs AND its quality signals (Tavily, two angles), (2) hands the FETCHED text to
 * the research brain (Fable), which extracts ONLY what the sources state — ref limits, file-size caps,
 * editing, features, and the RANKING AXES (9-axis strengths / tier / bestFor) — never from memory,
 * (3) returns the facts + PROVENANCE (the source URLs) + a confidence. Medium/high-confidence results
 * replace the seed; low-confidence stays "unverified" (honest, never faked).
 *
 * The ranking axes living HERE is the photolif cure: model selection reads strengths the agent
 * researched from live benchmarks/reviews, not a hand-typed opinion that fossilizes. This is what ends
 * the "I explain Grok's limits to you by hand" cycle: the agent reads the docs itself.
 */

import Anthropic from '@anthropic-ai/sdk';
import { tavilySearch, tavilyConfigured, type WebResult } from './tavily';
import { AGENT_MODELS } from '../model-config';
import { parseJsonResponse, responseText, wasTruncated } from './json-response';
import type { ModelStrengths, InputSlot, SlotRole } from '../../engine/model-registry';

const MODEL = AGENT_MODELS.research;

export interface CapabilityResearch {
  modelId: string;
  /** Extracted ONLY when the sources state it (else undefined — omitted, not guessed). */
  maxReferenceImages?: number;
  /** Typed per-role pools when the sources state them (Gemini-3-style, legacy shape). */
  referenceLimits?: { object: number; character: number; style: number };
  /** The model's REAL input channels, when the docs describe them (see InputSlot). */
  inputSlots?: InputSlot[];
  supportsEditing?: boolean;
  capabilities?: string[];
  aspectRatios?: string[];
  /** The RANKING AXES, researched from quality sources (benchmarks/arena/reviews) — the autonomous
   *  replacement for hand-typed scores. All 9 axes 0-5, or absent when the signal is thin. */
  strengths?: ModelStrengths;
  /** 1 budget · 2 mid · 3 flagship, from how the sources position the model. */
  tier?: 1 | 2 | 3;
  /** Short intents the sources say this model is a genuinely strong pick for. */
  bestFor?: string[];
  notes?: string;
  confidence: 'high' | 'medium' | 'low';
  /** Provenance — the sources the facts came from. Empty = nothing found (unverified). */
  sources: { url: string; title: string }[];
}

const SYSTEM = `You are the Model agent's capability researcher. You are given SEARCH RESULTS (title, url, extracted text) about ONE image-generation model. Extract ONLY the capability facts the SOURCES actually state — NEVER from your own memory, NEVER a guess. If a fact is not supported by the sources, OMIT it (null / leave the array empty).

Extract when stated:
- maxReferenceImages: max reference/source/input images the model's generation or edit API accepts, TOTAL across all roles (integer). If the docs state NO count limit (only a file-SIZE limit), OMIT it and put the size cap in notes — never invent a number.
- referenceLimits: ONLY when the sources describe SEPARATE per-role reference pools (e.g. Gemini-3-style object/character/style caps): {"object":<int>,"character":<int>,"style":<int>} (0 for a role with no pool). Omit entirely for a flat pool.
- inputSlots: the model's REAL input channels, one entry per distinct parameter the docs describe for passing images: [{"param":"<the provider's own parameter name>","role":"general|character|style|object|subject|mask|sketch","label":"<short human label>","max":<int or null when the docs describe the slot but publish no count>,"notes":"<how the model TREATS these — index-addressable, applied to the first image only, produces a reusable id, etc.>","conflictsWith":["<other params that cannot be combined>"],"constraints":"<size/format limits as stated>"}]. Use "general" when references are ONE undifferentiated pool. Omit the field entirely if the docs don't describe how images are passed. NEVER invent a param name or a count.
- supportsEditing: whether it has an edit / img2img / reference path (boolean).
- capabilities: any of ["text_in_image","editing","multi_reference","photorealism","vector","high_resolution","fast","cheap"] the sources support.
- aspectRatios: ratios like "16:9" if the sources list them.
- strengths: the model's craft profile as ALL NINE axes, each an integer 0-5: {"photorealism","prompt_adherence","editing","style_versatility","text_rendering","speed","resolution","consistency","multimodal"}. Ground every score in what the QUALITY SIGNALS sources actually report (benchmark placements, arena rankings, reviews, provider claims corroborated elsewhere). OMIT the whole object if the quality sources are too thin to score honestly — a guessed profile is worse than none.
- tier: 1 (budget/fast), 2 (mid), or 3 (flagship), from how the sources position the model in its provider's lineup and the market.
- bestFor: 3-6 SHORT intents the sources genuinely support (e.g. "typography", "photoreal hero", "character consistency") — never generic filler.
- notes: ONE line of the key constraints (e.g. "no count limit; <=20 MiB per image; edits accepts up to 3 source images").
- confidence: "high" if official/provider docs agree, "medium" if only secondary sources, "low" if thin or conflicting.

Respond with ONLY a JSON object, no prose:
{"maxReferenceImages":<int|null>,"referenceLimits":{"object":<int>,"character":<int>,"style":<int>}|null,"inputSlots":[{"param":"...","role":"...","label":"...","max":<int|null>,"notes":"...","conflictsWith":[...],"constraints":"..."}]|null,"supportsEditing":<bool|null>,"capabilities":[...],"aspectRatios":[...],"strengths":{"photorealism":<0-5>,...all nine...}|null,"tier":<1|2|3|null>,"bestFor":[...],"notes":"<one line>","confidence":"high|medium|low"}`;

function isRoleLimits(v: unknown): v is { object: number; character: number; style: number } {
  return (
    !!v &&
    typeof v === 'object' &&
    ['object', 'character', 'style'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number')
  );
}

const SLOT_ROLES: SlotRole[] = ['general', 'character', 'style', 'object', 'subject', 'mask', 'sketch'];

/** Validate researched slots: a real param name + a known role, counts sane. Malformed entries are
 *  dropped (never coerced into a guess); an all-malformed list yields undefined. */
function parseSlots(v: unknown): InputSlot[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const slots: InputSlot[] = [];
  for (const raw of v.slice(0, 8)) {
    const r = raw as Record<string, unknown>;
    if (typeof r?.param !== 'string' || !r.param.trim()) continue;
    if (typeof r?.role !== 'string' || !SLOT_ROLES.includes(r.role as SlotRole)) continue;
    const max = typeof r.max === 'number' && Number.isFinite(r.max) && r.max >= 0 ? Math.min(64, Math.round(r.max)) : undefined;
    slots.push({
      param: r.param.trim(),
      role: r.role as SlotRole,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : r.param.trim(),
      ...(max !== undefined ? { max } : {}),
      ...(typeof r.notes === 'string' && r.notes.trim() ? { notes: r.notes.trim() } : {}),
      ...(Array.isArray(r.conflictsWith)
        ? { conflictsWith: (r.conflictsWith as unknown[]).filter((c): c is string => typeof c === 'string' && !!c.trim()) }
        : {}),
      ...(typeof r.constraints === 'string' && r.constraints.trim() ? { constraints: r.constraints.trim() } : {}),
    });
  }
  return slots.length > 0 ? slots : undefined;
}

const STRENGTH_AXES: (keyof ModelStrengths)[] = [
  'photorealism', 'prompt_adherence', 'editing', 'style_versatility', 'text_rendering',
  'speed', 'resolution', 'consistency', 'multimodal',
];

/** All nine axes numeric → a clamped 0-5 profile; anything partial/malformed → undefined (no guesses). */
function parseStrengths(v: unknown): ModelStrengths | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const rec = v as Record<string, unknown>;
  if (!STRENGTH_AXES.every((k) => typeof rec[k] === 'number' && Number.isFinite(rec[k] as number))) return undefined;
  const out = {} as ModelStrengths;
  for (const k of STRENGTH_AXES) out[k] = Math.min(5, Math.max(0, Math.round(rec[k] as number)));
  return out;
}

export async function researchModelCapabilities(
  model: { id: string; label: string; provider: string; docsUrl?: string },
  opts: { client?: Anthropic } = {},
): Promise<CapabilityResearch> {
  const base: CapabilityResearch = { modelId: model.id, confidence: 'low', sources: [] };
  if (!tavilyConfigured()) return base;

  // Two angles: the CAPABILITY docs (hard limits) and the QUALITY signals (benchmarks/rankings/reviews
  // — what grounds the strength axes). One investigation, one extraction.
  const capQuery = `${model.label} (${model.provider}) image generation API: maximum reference / input images, file size limits, editing / image-to-image support, supported aspect ratios`;
  const qualQuery = `${model.label} image model quality benchmark arena ranking review strengths weaknesses`;
  const [capResults, qualResults] = await Promise.all([
    tavilySearch(capQuery, { maxResults: 6 }),
    tavilySearch(qualQuery, { maxResults: 5 }),
  ]);
  const results: WebResult[] = [...capResults, ...qualResults];
  if (results.length === 0) return base;

  const client = opts.client ?? new Anthropic();
  const section = (rs: WebResult[], off: number) =>
    rs.map((r, i) => `[${off + i + 1}] ${r.title}\nURL: ${r.url}\n${r.content.slice(0, 1500)}`).join('\n\n');
  const corpus = `CAPABILITY DOCS:\n${section(capResults, 0)}\n\nQUALITY SIGNALS:\n${section(qualResults, capResults.length)}`;

  const sources = results.map((r) => ({ url: r.url, title: r.title }));
  try {
    const msg = await client.messages.create({
      model: MODEL,
      // Sized for the FULL schema (9 strength axes + input slots + capabilities + aspect ratios)
      // with thinking on. It was 1024 — enough for the original small schema, and after the schema
      // grew every single extraction failed for an hour before anyone noticed. Budget follows schema.
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `MODEL: ${model.label} (${model.provider})\n\nSEARCH RESULTS:\n${corpus}` }],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const parsed = parseJsonResponse(responseText(msg));
    if (!parsed) {
      console.warn(`[research] ${model.id}: no parseable JSON in the response — leaving the record unverified.`);
      return { ...base, sources };
    }
    // A cut-off answer is INCOMPLETE, not a result: cap confidence so the record stays due for a
    // re-run instead of being persisted as though it were fully researched.
    const truncated = wasTruncated(msg);
    if (truncated) console.warn(`[research] ${model.id}: response hit the token ceiling — treating as low confidence.`);

    return {
      modelId: model.id,
      maxReferenceImages: typeof parsed.maxReferenceImages === 'number' ? parsed.maxReferenceImages : undefined,
      referenceLimits: isRoleLimits(parsed.referenceLimits) ? parsed.referenceLimits : undefined,
      inputSlots: parseSlots(parsed.inputSlots),
      supportsEditing: typeof parsed.supportsEditing === 'boolean' ? parsed.supportsEditing : undefined,
      capabilities: Array.isArray(parsed.capabilities) ? (parsed.capabilities as string[]) : undefined,
      aspectRatios: Array.isArray(parsed.aspectRatios) ? (parsed.aspectRatios as string[]) : undefined,
      strengths: parseStrengths(parsed.strengths),
      tier: parsed.tier === 1 || parsed.tier === 2 || parsed.tier === 3 ? parsed.tier : undefined,
      bestFor: Array.isArray(parsed.bestFor)
        ? (parsed.bestFor as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0).slice(0, 6)
        : undefined,
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
      confidence: truncated
        ? 'low'
        : ['high', 'medium', 'low'].includes(parsed.confidence as string)
          ? (parsed.confidence as 'high' | 'medium' | 'low')
          : 'low',
      sources,
    };
  } catch (err) {
    console.warn('[research] extraction failed:', err);
    return { ...base, sources };
  }
}
