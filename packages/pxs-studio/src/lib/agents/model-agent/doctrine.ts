/**
 * PROMPT DOCTRINE distillation — the knowledge layer above the numbers, and the fix for the shallow
 * Prompt Guide. The problem it solves (Brian's, verbatim): every model has SEPARATE documentation
 * that "works totally different" — an API reference (limits/params) AND a prompting guide (how to
 * actually talk to it) — and professionals burn hours crawling both because they keep changing. This
 * pass reads them so no one else has to:
 *
 *   1. FETCH the model's PINNED official docs in FULL (tavilyExtract — whole documents, because
 *      doctrine cannot be distilled from 1500-char search snippets; that's why the Guide felt fake).
 *   2. DISTILL with the research brain (Fable): the model's REAL prompt formula (parts/order/weights
 *      as ITS guide teaches), principles, anti-patterns, task patterns, and a guide digest — ONLY
 *      what the documents state, never LLM memory, with the source URL per claim category.
 *   3. HASH the corpus — an unchanged doc set skips re-distillation entirely (daily due-checks stay
 *      ~free; LLM spend happens only when a provider actually edits their docs).
 *
 * The doctrine is what the Prompt Guide surfaces, what the builder's per-model formula comes from,
 * and what the honest craft score judges against — all with provenance ("per Google's guide, …").
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { tavilyExtract, tavilySearch, tavilyConfigured } from './tavily';
import { parseJsonResponse, responseText, wasTruncated } from './json-response';
import { AGENT_MODELS } from '../model-config';
import type { ImageModel, ModelDoc, PromptFormula, PromptFormulaPart } from '../../engine/model-registry';
import { normalizeTask, taskVocabularyPrompt, type ImageTask, type TaskSupport } from '../../engine/task-vocabulary';
import { normalizeVideoTask, videoVocabularyPrompt, type VideoTask } from '../../engine/video-vocabulary';

const MODEL = AGENT_MODELS.research;

/** One worked pattern for a concrete TASK — the FEATURE layer and the Guide's examples in one.
 *  `task` is enum-locked to Pixcel's controlled vocabulary (task-vocabulary.ts): whatever the
 *  provider calls the feature, it lands on our noun or it's dropped. */
export interface DoctrineTaskPattern {
  /** Enum-locked to the vocabulary for this model's MODALITY (image or video). */
  task: ImageTask | VideoTask;
  /** native = a documented feature of the model; technique = a recipe over its inputs. */
  support: Exclude<TaskSupport, 'unsupported'>;
  /** How the model's own docs say to do this task (compressed, concrete). */
  pattern: string;
}

/** A model's distilled prompt doctrine — everything the Guide/builder/score need, grounded. */
export interface ModelDoctrine {
  modelId: string;
  /** Which vocabulary + craft lens this doctrine was distilled under. Absent = 'image' (the records
   *  written before video existed), so old doctrines keep reading correctly. */
  modality?: 'image' | 'video';
  /** The model's REAL formula, as ITS OWN guide teaches it (parts, order, weights from emphasis). */
  formula?: PromptFormula;
  /** What the docs say the model rewards — short, actionable lines. */
  principles: string[];
  /** What the docs warn against (negatives, over-stuffing, wrong syntax, …). */
  antiPatterns: string[];
  /** Worked per-task prompting patterns found in the docs. */
  taskPatterns: DoctrineTaskPattern[];
  /** A compact markdown digest of the guide for panel display + agent context injection. */
  guide: string;
  confidence: 'low' | 'medium' | 'high';
  /** The docs actually ingested (provenance). */
  sources: { url: string; kind: string }[];
}

/** Video prompting is a different craft: a shot has duration, camera movement, physics and often
 *  synced audio. Asking the image questions of a video guide yields image answers. */
const VIDEO_EXTRA = `
This model generates VIDEO. Attend to what only motion has:
- The formula parts should cover the SHOT: subject, action/beat, camera (framing AND movement), motion/physics and pace, setting, lighting/mood — and audio direction when the model generates sound.
- principles/antiPatterns must include what the guide says about MOTION and CAMERA specifically (how to describe a move, how much action fits the clip length, whether to describe cuts), and about AUDIO/dialogue when supported.
- notes should capture duration limits, shot counts, and whether audio is generated in the same pass.`;

function systemFor(modality: 'image' | 'video'): string {
  const vocabulary = modality === 'video' ? videoVocabularyPrompt() : taskVocabularyPrompt();
  return SYSTEM.replace('__TASK_VOCABULARY__', vocabulary).replace(
    '__MODALITY_NOTE__',
    modality === 'video' ? VIDEO_EXTRA : '',
  );
}

const SYSTEM = `You are the Model agent's doctrine distiller. You are given the FULL TEXT of one image-generation model's OFFICIAL documentation (its API reference and/or prompting guide). Distill the model's PROMPT DOCTRINE — extract ONLY what these documents actually teach; NEVER supplement from your own memory. If the documents don't support a field, leave it empty.

Extract:
- formula: the ordered COMPONENTS OF A PROMPT this model's guide teaches a user to write — the slots someone fills in to compose one prompt. Each part: {"id":"<kebab-slug>","label":"<short>","guidance":"<one actionable line from the docs>","weight":<1-3, from the emphasis the docs place on it>}.
  · Use the DOCUMENT'S OWN framework and its names. If the guide states a formula like "Subject + Action + Location + Composition + Style", return exactly those five, in that order.
  · These are PROMPT SLOTS, never documentation section headings. "Core principles", "Best practices", "Length decision", "Getting started" are SECTIONS of the guide — never parts. A valid part is a thing the user describes in their prompt (subject, lighting, camera, setting, style, typography…).
  · If the guide teaches no explicit slot structure, return null. Null is the honest answer; invented parts are not.
  Include "assembly": one line on how the guide says to assemble it (flowing natural language vs structured, ordering, length budget).
- principles: 5-10 SHORT actionable lines the docs say this model rewards (phrasing style, specificity, camera/lighting vocabulary, iteration technique). Each must trace to the documents.
- antiPatterns: 3-8 SHORT lines the docs warn against (e.g. negative phrasing, keyword soup, exceeding a word budget).
- taskPatterns: for each TASK from the CONTROLLED VOCABULARY below that these documents show the model doing, one entry: {"task":"<exact slug from the vocabulary>","support":"native|technique","pattern":"<compressed concrete how-to from the docs>"}.
  · TRANSLATE the provider's own feature naming onto our vocabulary — a doc section called "Story-to-Comic Strip" is "storyboard-panels"; "Ingredient mix-and-match" is "scene-composite". NEVER invent a slug outside the list; if a documented feature maps to nothing in the list, OMIT it.
  · support "native" = the docs present it as a capability/feature of the model. support "technique" = the docs achieve it by a recipe over the model's inputs (multi-step, reference-slot trickery, prompt scaffolding).
  · Only include a task the DOCUMENTS actually evidence. Omission is the honest answer — a missing task is read as unsupported.

CONTROLLED TASK VOCABULARY (use these slugs EXACTLY):
__TASK_VOCABULARY__
- guide: a compact markdown digest (300-600 words) of the doctrine a professional would want at their elbow: the formula, the strongest principles, the traps. Written from the docs, quotable.
- confidence: "high" if a real prompting guide was among the documents, "medium" if only API-reference-grade material, "low" if the text was thin/off-topic.

Respond with ONLY a JSON object, no prose:
{"formula":{"parts":[{"id":"...","label":"...","guidance":"...","weight":2}],"assembly":"..."}|null,"principles":[...],"antiPatterns":[...],"taskPatterns":[{"task":"...","support":"native|technique","pattern":"..."}],"guide":"<markdown>","confidence":"high|medium|low"}
__MODALITY_NOTE__`;

/**
 * The DISTILLER VERSION. Bump it whenever the extraction prompt or parsing changes in a way that
 * would produce a better doctrine from the SAME documents.
 *
 * Why it's part of the hash: the change gate skips re-distillation when a provider's docs are
 * unchanged — which is what keeps the daily pass ~free. But it also meant an improvement to the
 * distiller could never reach the models already distilled: they'd sit on their old (worse) doctrine
 * forever, because the docs hadn't moved. Versioning the gate means fixing the distiller re-distills
 * everything exactly once, then goes quiet again.
 *
 * v2 — parts were coming back as documentation SECTION HEADINGS ("Core principles", "Length
 *      decision") instead of prompt slots; tightened the formula instruction + raised the token
 *      ceiling so the richest guides stop truncating.
 * v3 — per-doc read budget was cutting pages mid-navigation (OpenAI's guides start with ~16k of
 *      chrome), so the distiller never reached the content.
 */
export const DOCTRINE_VERSION = 'v3';

/** Deterministic corpus hash — the change gate. Versioned (see DOCTRINE_VERSION). */
export function corpusHash(text: string): string {
  return createHash('sha256').update(`${DOCTRINE_VERSION}\n${text}`).digest('hex').slice(0, 24);
}

/**
 * Per-doc char budget. Generous on purpose: it was 16k, and both OpenAI pages came back at EXACTLY
 * 16k — cut mid-navigation, so the distiller was reading site chrome instead of the guide and
 * produced an empty doctrine. Real prompting guides run 30-60k characters; a doc read that stops
 * before the content starts is worse than useless, because it looks like a successful read.
 * Two docs at this size is still a modest fraction of the model's context.
 */
const PER_DOC_CHARS = 60_000;

export interface FetchedDoc {
  doc: ModelDoc;
  content: string;
  /** True when this doc was DISCOVERED by search rather than pinned — secondary grounding, so the
   *  doctrine's confidence is capped at 'medium' (a community guide is not the provider's word). */
  discovered?: boolean;
}

/**
 * Fetch the model's grounding documents in full: PINNED official docs first (the deterministic
 * floor), then — only when no prompting guide is pinned — a DISCOVERED one via search.
 *
 * Why the fallback: some providers publish no official prompting guide at all (xAI, verified
 * 2026-08-24 — only community guides exist). Leaving those models blind would make the Guide fake
 * for them, which is the very disease we're curing; but promoting a community page to the pinned
 * floor would be dishonest. So it's grounded, marked `discovered`, and confidence-capped downstream.
 * Pinning is a floor, never a ceiling. Exposed for the refresh layer (it hashes before distilling).
 */
export async function fetchPinnedDocs(model: ImageModel): Promise<FetchedDoc[]> {
  if (!tavilyConfigured()) return [];
  const docs = (model.docs ?? []).filter((d) => d.kind === 'prompting_guide' || d.kind === 'api_reference' || d.kind === 'model_card');

  const pinned: FetchedDoc[] = [];
  if (docs.length > 0) {
    const pages = await tavilyExtract(docs.map((d) => d.url));
    const byUrl = new Map(pages.map((p) => [p.url, p.content]));
    pinned.push(
      ...docs
        .map((doc) => ({ doc, content: (byUrl.get(doc.url) ?? '').slice(0, PER_DOC_CHARS) }))
        .filter((f) => f.content.length > 200), // a stub/error page grounds nothing
    );
  }

  const hasGuide = pinned.some((f) => f.doc.kind === 'prompting_guide');
  if (hasGuide) return pinned;

  // No pinned guide → hunt for one. Top result only; grounded but explicitly secondary.
  const hits = await tavilySearch(`${model.label} prompting guide: prompt structure, best practices, examples`, { maxResults: 3 });
  const candidate = hits.find((h) => h.url && !docs.some((d) => d.url === h.url));
  if (!candidate) return pinned;
  const [page] = await tavilyExtract([candidate.url]);
  if (!page || page.content.length < 200) return pinned;
  return [
    ...pinned,
    {
      doc: { kind: 'prompting_guide', url: page.url, verifiedAt: '' },
      content: page.content.slice(0, PER_DOC_CHARS),
      discovered: true,
    },
  ];
}

function parseParts(v: unknown): PromptFormulaPart[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) return null;
  const parts: PromptFormulaPart[] = [];
  for (const raw of v) {
    const r = raw as Record<string, unknown>;
    if (typeof r?.id !== 'string' || typeof r?.label !== 'string' || typeof r?.guidance !== 'string') return null;
    const w = typeof r.weight === 'number' && Number.isFinite(r.weight) ? Math.min(3, Math.max(1, r.weight)) : 1;
    parts.push({ id: r.id, label: r.label, guidance: r.guidance, weight: w });
  }
  return parts;
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max) : [];

/**
 * Distill one model's doctrine from already-fetched docs. Pure over its inputs apart from the LLM
 * call (client injectable for tests). Returns null when the corpus can't support a doctrine.
 */
export async function distillDoctrine(
  model: ImageModel,
  fetched: FetchedDoc[],
  opts: { client?: Anthropic; modality?: 'image' | 'video' } = {},
): Promise<ModelDoctrine | null> {
  const modality = opts.modality ?? 'image';
  if (fetched.length === 0) return null;
  const corpus = fetched
    .map((f) => `=== ${f.doc.kind.toUpperCase()}${f.discovered ? ' (UNOFFICIAL/COMMUNITY SOURCE)' : ''} (${f.doc.url}) ===\n${f.content}`)
    .join('\n\n');

  const client = opts.client ?? new Anthropic();
  const sources = fetched.map((f) => ({ url: f.doc.url, kind: f.discovered ? `${f.doc.kind} (discovered)` : f.doc.kind }));
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: systemFor(modality),
      messages: [{ role: 'user', content: `MODEL: ${model.label} (${model.provider})\n\nOFFICIAL DOCUMENTS:\n${corpus}` }],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const text = ((msg.content ?? []) as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    // TRUNCATION IS A FAILURE, NOT A RESULT. The budget above is sized so this shouldn't happen; if
    // the provider ships a guide big enough to overflow it anyway, we must NOT quietly store a
    // half-doctrine that looks whole. So: salvage what was read (a full document read is expensive),
    // but say so loudly and mark it LOW confidence — which makes the daily pass treat it as unfinished
    // and re-distill it, and stops the craft judge from ever citing it as authoritative.
    const truncated = wasTruncated(msg);
    if (truncated) {
      console.warn(
        `[doctrine] ${model.id}: response hit the token ceiling — the distillation is INCOMPLETE. ` +
          `Salvaging what parsed and marking it low-confidence so the next pass re-runs it.`,
      );
    }

    const parsed = parseJsonResponse(responseText(msg));
    if (!parsed) throw new Error('no parseable JSON object in the response');

    const f = parsed.formula as Record<string, unknown> | null | undefined;
    const parts = f ? parseParts(f.parts) : null;
    // Enum-lock the task slugs: anything outside our vocabulary is DROPPED, never coined.
    const seenTasks = new Set<ImageTask | VideoTask>();
    const taskPatterns: DoctrineTaskPattern[] = Array.isArray(parsed.taskPatterns)
      ? (parsed.taskPatterns as unknown[])
          .map((t) => t as Record<string, unknown>)
          .flatMap((t) => {
            if (typeof t?.task !== 'string' || typeof t?.pattern !== 'string') return [];
            const task = modality === 'video' ? normalizeVideoTask(t.task) : normalizeTask(t.task);
            if (!task || seenTasks.has(task)) return [];
            seenTasks.add(task);
            const support = t.support === 'technique' ? 'technique' : 'native';
            return [{ task, support, pattern: (t.pattern as string).trim() } as DoctrineTaskPattern];
          })
          .slice(0, 24)
      : [];

    // Honesty cap: a doctrine grounded only in DISCOVERED (community) material can never be 'high'
    // — that rank is reserved for the provider's own published guide.
    const officialGuide = fetched.some((f) => f.doc.kind === 'prompting_guide' && !f.discovered);
    const rawConfidence = parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low';
    const confidence: 'low' | 'medium' | 'high' = truncated
      ? 'low' // incomplete by definition — never presented as finished work
      : rawConfidence === 'high' && !officialGuide
        ? 'medium'
        : rawConfidence;

    return {
      modelId: model.id,
      modality,
      formula: parts
        ? { parts, assembly: typeof f?.assembly === 'string' ? f.assembly : undefined }
        : undefined,
      principles: strings(parsed.principles, 10),
      antiPatterns: strings(parsed.antiPatterns, 8),
      taskPatterns,
      guide: typeof parsed.guide === 'string' ? parsed.guide : '',
      confidence,
      sources,
    };
  } catch (err) {
    console.warn(`[doctrine] distillation failed for ${model.id}:`, err);
    return null;
  }
}

/** Internals exposed for unit tests only. */
export const __testing = { parseLoose: parseJsonResponse };
