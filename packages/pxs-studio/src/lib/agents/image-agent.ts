/**
 * The IMAGE AGENT — the image-workflow specialist.
 *
 * The Operator TRANSFERS an Epistemic Frame here (state-injection: verified brief → start at
 * DECIDE, don't re-Orient). The Image agent OWNS all image specs: it crafts the model-ready prompt
 * and derives the RoutingRequest (needs / aspectRatio / count / references), then invokes the
 * coordinator (which consults the Model agent for selection) and streams the render.
 *
 * The Operator hands the FRAME ONLY — no prompt, no routing specs. Dispatch (the small/quick path)
 * does NOT come here; it stays Operator-inline.
 */

import Anthropic from '@anthropic-ai/sdk';
import { coordinateImage } from '../engine/coordinator';
import { type Capability, type PromptFormula } from '../engine/model-registry';
import type { RoutingRequest } from '../engine/routing';
import { describeModelCapabilitiesOrDefault, type ModelCapabilityFacts } from './model-agent';
import { imageAgentSkills } from './skills';
import { assertFrameBudget, type EpistemicFrame } from './epistemic-frame';

/** THE FAN-OUT DEFAULT (Brian): every render fans across the top-N models — auto-picked by fit + provider
 *  diversity — one image each. Fan-out is the DEFAULT (single is the N=1 case); this is decision closure
 *  (see GPT vs Gemini vs Flux at once, commit without regret). Tunable; Slice 4's per-turn config
 *  overrides per render, and the frame's $-budget still hard-caps the worst case. */
const FANOUT_DEFAULT_MODELS = 3;
const FANOUT_DEFAULT_PER_MODEL = 1;

const MODEL = 'claude-opus-4-8';

/** The capability tags Gate 1 understands (filter the agent's `needs` to these). */
const VALID_CAPS: readonly Capability[] = [
  'text_in_image', 'editing', 'multi_reference', 'photorealism', 'vector', 'high_resolution', 'fast', 'cheap',
];

const IMAGE_AGENT_SYSTEM = `You are the IMAGE AGENT — a specialist that turns a handed-off creative brief into a concrete image render plan. You have ALREADY been oriented: the brief is VERIFIED, do not re-question it — start at DECIDE.

Respond in TWO parts, in order:
1) a SHORT opener as plain text — one calm sentence, no fluff, no exclamation. Match it to the leg: on a CONSULTATION hand-off, invite the user to set up the pass (specs + references) and NEVER claim you're rendering; on a GENERATION turn, note what you're rendering.
2) call the \`plan_render\` tool with your render plan.

You OWN the image specs (the Operator handed only the brief):
- prompt: a rich, model-ready image prompt built from the brief (subject, style, scene, lighting, composition).
- needs: capability tags the model MUST have, chosen from: text_in_image, editing, multi_reference, photorealism, vector, high_resolution, fast, cheap. Only include what the brief truly requires (e.g. a photoreal brief → ["photorealism"]).
- aspectRatio: optional (e.g. "16:9" for a video-scene frame).
- count: how many takes (default 2).
- referenceRecommendation: 1–3 SHORT reference TYPES to attach for a precise result, tailored to the brief (e.g. "A character reference to keep the Camaro consistent", "A style reference for the era", "Start & end frames"). The exact reference COUNT the chosen model accepts is a fact supplied to you — never invent it.
- parts: on a CONSULTATION (guided) leg, break the brief into the image FORMULA — Subject, Action, Context, Composition, Style. This is ITERATION ZERO of the user's prompt, so be faithful to what they ACTUALLY said. For each part give: id (lowercase), label, a one-line guidance (what the part is for), and:
  • value = ONLY what the USER actually specified, decomposed into this part (e.g. "I want a car" → Subject value "a car"; Action/Context/etc. value ""). EMPTY if they didn't mention it. NEVER invent, expand, or put words in their mouth — that's what \`recommend\` is for.
  • recommend = YOUR suggested improvement for this part, rich and specific (e.g. Subject recommend "A modern sports car with glossy metallic paint and brushed-metal trim"). It shows as the field placeholder — a recommendation, not their words.
  • chips = 3–5 SUGGESTED quick-adds tailored to THIS subject (e.g. Style: "golden hour", "kodachrome", "grainy 35mm") — the user taps to APPEND; never a fixed menu.
The user shapes this in the Prompt Builder before rendering; it starts graded LOW (their bare prompt) and climbs as they fill it.`;

const PLAN_TOOL = {
  name: 'plan_render',
  description: 'The concrete render plan derived from the brief.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      needs: { type: 'array', items: { type: 'string' } },
      aspectRatio: { type: 'string' },
      count: { type: 'number' },
      referenceRecommendation: { type: 'array', items: { type: 'string' } },
      // The prompt FORMULA broken into parts — the structured consult the center Prompt Builder
      // renders. On a GUIDED consult, fill these: pre-fill each value from the brief, add one-line
      // guidance + 3–5 SUGGESTED anchor chips per part (the user taps or free-types more).
      parts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, // subject | action | context | composition | style
            label: { type: 'string' },
            guidance: { type: 'string' },
            value: { type: 'string' }, // ONLY what the user actually said (empty if unmentioned)
            recommend: { type: 'string' }, // your suggested improvement (becomes the placeholder)
            chips: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'label', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
} as const;

/** THE COUPLING — how the agent responds when the user is shaping the prompt WITH it in the Builder.
 *  Instead of always rendering, it decides: edit specific parts, render, or just answer. */
const WORKSPACE_ACTION_TOOL = {
  name: 'workspace_action',
  description: 'Decide how to respond to the user shaping the prompt with you: edit specific parts, render, or answer.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['edit', 'render', 'answer', 'rebuild'] },
      edits: {
        type: 'array',
        description: "When action='edit': the parts to change, each with its FULL new value (rewrite the whole value, not a fragment).",
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, // subject | action | context | composition | style
            value: { type: 'string' },
          },
          required: ['id', 'value'],
          additionalProperties: false,
        },
      },
      subject: {
        type: 'string',
        description: "When action='rebuild': the NEW subject the user pivoted to (a short noun phrase, e.g. 'a car').",
      },
      parts: {
        type: 'array',
        description:
          "When action='rebuild': fresh iteration-zero parts for the NEW subject — the same formula parts (subject/action/context/composition/style). Each: id, value (ONLY the user's actual words for the new subject, empty if unspecified — never invent), recommend (your suggestion → shown as placeholder), chips (3–5).",
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
            recommend: { type: 'string' },
            chips: { type: 'array', items: { type: 'string' } },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

const COLLABORATE_SYSTEM = `\n\nWORKSPACE COLLABORATION: the user is shaping their image PROMPT with you in the Prompt Builder; you can see the current parts + values. Respond in TWO parts: (1) ONE short spoken sentence confirming what you did (no fluff); (2) call \`workspace_action\`:
- "edit" — they asked to change/improve/add to the prompt ("make it night", "stronger context", "add motion blur", "use the placeholders"). Return \`edits\`: only the parts to change, each with its FULL new value (rewrite the whole part). Do NOT render.
- "render" — they EXPLICITLY asked to generate ("render it", "generate", "go", "make it now").
- "answer" — a question or advice ("which lens?", "what's weak?"). Just answer in the spoken part; no edits, no render.
- "rebuild" — they PIVOTED to a DIFFERENT subject entirely (was a jet, now "a car"), or want something the current parts can't represent. Provide the new \`subject\` and fresh \`parts\` (all formula parts, iteration zero: \`value\` = ONLY their actual words for the new subject, a \`recommend\`, and 3–5 \`chips\`). This RESETS the whole Prompt Guide to the new subject. Do NOT render.
Choosing edit vs rebuild: the SAME subject being tuned → edit; a genuinely NEW subject → rebuild.
Only render when they clearly ask to. Editing, answering, or rebuilding NEVER renders. Honor their intent; don't render unless asked.`;

/** The grounded reference-recommendation the agent surfaces (mirrors A2UIReferencesBlock). */
export interface ReferencesRecommendation {
  kind: 'references';
  /** Routes to the workspace Prompt Guide panel (slots-not-screens), not the chat scroll. */
  surface?: 'chat' | 'controls';
  modelLabel: string;
  maxReferences: number;
  supports: string[];
  recommend: string[];
  note?: string;
}

/** One formula part in the builder block (mirrors the store's BuilderPart). */
export interface ImageBuilderPart {
  id: string;
  label: string;
  guidance: string;
  /** ONLY what the user actually specified (iteration zero) — empty if unmentioned; never invented. */
  value: string;
  /** The agent's suggested improvement — rendered as the placeholder (a recommendation). */
  recommend?: string;
  chips: string[];
  /** Weight in the target model's formula — drives the honest score. */
  weight?: number;
}

/** The STRUCTURED CONSULT the guided leg surfaces (mirrors A2UIBuilderBlock, PR-10a) — the center
 *  Prompt Builder. Replaces the prose consult + the standalone references card: the agent breaks the
 *  brief into the formula and folds in the model's reference facts; the user shapes it and hits Render. */
export interface ImageBuilderBlock {
  kind: 'builder';
  surface?: 'canvas';
  title: string;
  media: 'image' | 'video' | 'pixel' | 'anim';
  parts: ImageBuilderPart[];
  /** The target model driving the formula (its parts/weights are ITS documented shape). */
  modelId?: string;
  /** How this model wants the prompt assembled (order/format) — surfaced in the Guide. */
  assembly?: string;
  model?: { label: string; maxReferences: number; supports: string[] };
}

/** Events the Image agent streams (the route forwards / meters these). */
export type ImageAgentEvent =
  | { type: 'agent_start' }
  /** Honest workflow milestone for the thinking reel (Focus/Stack). start pushes/activates a step
   *  keyed by id; done flips it done. `detail` is thought-mode sub-text. */
  | { type: 'step'; id: string; label?: string; status: 'start' | 'done'; detail?: string }
  | { type: 'agent_text'; delta: string }
  | { type: 'agent_usage'; inputTokens: number; outputTokens: number }
  | { type: 'agent_a2ui'; block: ReferencesRecommendation | ImageBuilderBlock }
  /** THE COUPLING: the agent edited a Build part from a natural-language instruction (no render). */
  | { type: 'part_edit'; id: string; value: string }
  | { type: 'gen_start' }
  /** The fan PLAN — the models about to render (label + how many each), emitted the instant routing
   *  resolves so the stage can show ALL N loaders at once (you see every model is cooking, not one). */
  | { type: 'gen_plan'; models: { label: string; n: number }[] }
  | { type: 'image'; url: string; modelLabel: string; index: number; score?: number }
  | { type: 'gen_error'; message: string }
  /** A gentle non-blocking heads-up (best-effort shortfall) — forwarded from the coordinator. */
  | { type: 'gen_notice'; message: string }
  | { type: 'gen_done'; costUsd: number };

/** Build the grounded capability highlights list from the Model agent's facts. Typed per-role
 *  limits (Gemini-3-style) render as "up to 6 object · 5 character · 3 style"; otherwise the flat pool. */
function capabilityHighlights(f: ModelCapabilityFacts): string[] {
  const rl = f.referenceLimits;
  const refLine = rl
    ? `Up to ${rl.object} object${rl.character ? ` · ${rl.character} character` : ''}${rl.style ? ` · ${rl.style} style` : ''} references`
    : `Holds up to ${f.maxReferenceImages} reference image${f.maxReferenceImages === 1 ? '' : 's'}`;
  const out: string[] = [refLine];
  if (f.styleTransfer) out.push('Style-transfer variants');
  if (f.multiReference) out.push('Multi-image compositing');
  if (f.supportsEditing) out.push('Editing / inpaint');
  return out;
}

/** Index the agent's plan_render `parts` content by id → { value, recommend, chips }. The agent
 *  supplies the CONTENT (the user's actual value + a recommendation + chips); the model's FORMULA
 *  supplies the structure (see below). */
function agentContentById(raw: unknown): Map<string, { value: string; recommend: string; chips: string[] }> {
  const m = new Map<string, { value: string; recommend: string; chips: string[] }>();
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (!p || typeof p !== 'object') continue;
      const o = p as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id) continue;
      m.set(id, {
        value: typeof o.value === 'string' ? o.value.trim() : '',
        recommend: typeof o.recommend === 'string' ? o.recommend.trim() : '',
        chips: Array.isArray(o.chips)
          ? o.chips.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim()).slice(0, 6)
          : [],
      });
    }
  }
  return m;
}

/** MODEL-DRIVEN builder parts: the STRUCTURE (which parts, labels, guidance, weight, order) comes
 *  from the target model's FORMULA; the CONTENT comes from the agent, matched by id — `value` is the
 *  user's ACTUAL words (iteration zero), `recommend` is the agent's suggestion (the placeholder). */
function buildFormulaParts(formula: PromptFormula, raw: unknown, frame: EpistemicFrame): ImageBuilderPart[] {
  const content = agentContentById(raw);
  const subject = (frame.subject || frame.goal || '').trim();
  return formula.parts.map((fp) => {
    const c = content.get(fp.id);
    // Seed Subject from the brief ONLY if the agent didn't decompose the user's words itself.
    let value = c?.value ?? '';
    if (!value && fp.id === 'subject') value = subject;
    return {
      id: fp.id,
      label: fp.label,
      guidance: fp.guidance,
      value,
      recommend: c?.recommend || undefined,
      chips: c?.chips ?? [],
      weight: fp.weight,
    };
  });
}

/** A follow-up turn INSIDE the Image workspace (Option A — the workspace talks straight to the
 *  Image agent, no Operator re-diagnosis). Absent on the first leg (the transfer). */
export interface ImageAgentTurn {
  /** The user's workspace instruction (e.g. "make it dusk", "wider shot", "more variations"). */
  userMessage?: string;
  /** Prior workspace turns for coherence. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Reference images (data/https URLs) the user attached this turn — override the frame's. */
  references?: string[];
  /** The CURRENT Build state (parts + their live values). Present → COLLABORATION mode: the agent
   *  decides edit / render / answer instead of always rendering (the coupling). */
  builder?: { parts: { id: string; label: string; value: string }[] };
  /** The fan-out config from the picker/composer (which models, how many, images each, aspect). Absent
   *  → the auto default (top-N by fit). Overrides FANOUT_DEFAULT_* + the aspect for THIS render. */
  fan?: FanConfigInput;
}

/** The fan-out controls the picker sends (all optional — absent fields fall back to the auto default). */
export interface FanConfigInput {
  mode?: 'auto' | 'manual';
  models?: string[];
  fanModels?: number;
  perModel?: number;
  aspect?: string;
}

/**
 * Run the Image agent's leg. On the FIRST leg (a transfer) pass just the frame — it renders an
 * anchor + a grounded reference recommendation. On a workspace FOLLOW-UP pass the frame + `turn`
 * (the user's instruction + attached references) and it iterates directly. Never throws — failures
 * surface as gen_error.
 */
export async function* runImageAgent(frame: EpistemicFrame, turn: ImageAgentTurn = {}): AsyncIterable<ImageAgentEvent> {
  assertFrameBudget(frame);
  yield { type: 'agent_start' };

  const instruction = typeof turn.userMessage === 'string' ? turn.userMessage.trim() : '';

  // Fan-out controls from the picker (else the auto default). Manual mode → `models` drives the fan;
  // auto → top-N by fit. `aspect` sets the render AND the reference aspect-fit target for this render.
  const fanCfg = turn.fan;
  const manualModels = fanCfg?.mode === 'manual' && fanCfg.models && fanCfg.models.length > 0 ? fanCfg.models : undefined;
  const fanModelsN = manualModels ? undefined : Math.max(1, fanCfg?.fanModels ?? FANOUT_DEFAULT_MODELS);
  const perModelN = Math.max(1, fanCfg?.perModel ?? FANOUT_DEFAULT_PER_MODEL);
  const fanAspect = fanCfg?.aspect;
  const refCount = turn.references?.length ?? 0;
  // RENDER vs COLLABORATE: a render leg needs an EXPLICIT instruction (the Render button sends the
  // assembled prompt; a "generate these" follow-up sends text). Attaching references ALONE is NOT a
  // render command — it's material to shape in the builder. This is the line Brian drew: a describe-
  // prompt with a photo lands in the IDE to be confirmed, never auto-rendered. (refCount still tells the
  // consult leg to plan around the references + skip the "attach one" recommendation.)
  const followUp = instruction.length > 0;

  // 0) THE COUPLING — if the message arrives WITH the current Build state, the user is shaping the
  //    prompt WITH the agent. Decide edit / render / answer instead of always rendering.
  const builderParts = turn.builder?.parts ?? [];
  if (followUp && builderParts.length > 0) {
    let decision: { action?: unknown; edits?: unknown; subject?: unknown; parts?: unknown } = {};
    yield { type: 'step', id: 'reading', label: 'Reading your prompt…', status: 'start' };
    try {
      const client = new Anthropic();
      const partsDump = builderParts.map((p) => `- ${p.label} (${p.id}): ${p.value?.trim() || '(empty)'}`).join('\n');
      const userContent = `Current prompt parts:\n${partsDump}\n\nUser: ${instruction || '(only attached references)'}`;
      const params = {
        model: MODEL,
        max_tokens: 1000,
        thinking: { type: 'adaptive', display: 'summarized' },
        system: IMAGE_AGENT_SYSTEM + COLLABORATE_SYSTEM + imageAgentSkills(),
        tools: [WORKSPACE_ACTION_TOOL],
        messages: [
          ...(turn.history ?? []).map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content: userContent },
        ],
      };
      const stream = client.messages.stream(params as any);
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
          yield { type: 'agent_text', delta: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      yield {
        type: 'agent_usage',
        inputTokens: (final as { usage?: { input_tokens?: number } })?.usage?.input_tokens ?? 0,
        outputTokens: (final as { usage?: { output_tokens?: number } })?.usage?.output_tokens ?? 0,
      };
      const tool = ((final?.content ?? []) as Array<{ type: string; name?: string; input?: unknown }>)
        .find((b) => b.type === 'tool_use' && b.name === 'workspace_action');
      decision = (tool?.input as typeof decision) ?? {};
    } catch (err) {
      yield { type: 'gen_error', message: err instanceof Error ? err.message : 'Image agent failed' };
      yield { type: 'gen_done', costUsd: 0 };
      return;
    }

    yield { type: 'step', id: 'reading', status: 'done' };
    const act =
      decision.action === 'edit' || decision.action === 'render' || decision.action === 'answer' || decision.action === 'rebuild'
        ? decision.action
        : 'answer';

    if (act === 'rebuild') {
      yield { type: 'step', id: 'rebuilding', label: 'Rebuilding for the new subject…', status: 'start' };
      // PIVOT: the user changed to a new subject. Emit a FRESH builder block (new formula parts,
      // chips, recommendations) for the new subject — a new block arrives on this turn, so the
      // workspace re-points to it and the store re-seeds the shared values to iteration zero. This
      // is the clean reset: the whole Prompt Guide (not just Subject) becomes the new subject.
      const newSubject =
        typeof decision.subject === 'string' && decision.subject.trim() ? decision.subject.trim() : instruction || frame.goal;
      const req: RoutingRequest = {
        intent: newSubject,
        needs: [],
        count: frame.count,
        references: frame.assetRefs,
        budgetUsd: frame.budgetUsd,
      };
      // Never-null: a router hang must not strip the reference support from the rebuilt guide.
      yield { type: 'step', id: 'grounding', label: 'Grounding model support…', status: 'start' };
      const facts = await describeModelCapabilitiesOrDefault(req);
      yield { type: 'step', id: 'grounding', status: 'done' };
      yield { type: 'step', id: 'rebuilding', status: 'done' };
      const formula = facts.formula;
      const rebuiltFrame: EpistemicFrame = { ...frame, subject: newSubject, goal: newSubject };
      const parts = buildFormulaParts(formula, decision.parts, rebuiltFrame);
      yield {
        type: 'agent_a2ui',
        block: {
          kind: 'builder',
          surface: 'canvas',
          title: `Prompt guide · ${newSubject}`,
          media: frame.medium === 'video' ? 'video' : 'image',
          parts,
          modelId: facts.modelId,
          assembly: formula.assembly,
          model: { label: facts.modelLabel, maxReferences: facts.maxReferenceImages, supports: capabilityHighlights(facts) },
        },
      };
      yield { type: 'gen_done', costUsd: 0 };
      return;
    }

    if (act === 'edit') {
      // Apply the agent's targeted part edits (valid ids only) — they land in the shared state and
      // animate the Build panel. No render.
      yield { type: 'step', id: 'editing', label: 'Applying your edits…', status: 'start' };
      const validIds = new Set(builderParts.map((p) => p.id));
      const edits = Array.isArray(decision.edits) ? decision.edits : [];
      for (const e of edits) {
        if (!e || typeof e !== 'object') continue;
        const o = e as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        const value = typeof o.value === 'string' ? o.value.trim() : '';
        if (id && validIds.has(id) && value) yield { type: 'part_edit', id, value };
      }
      yield { type: 'step', id: 'editing', status: 'done' };
      yield { type: 'gen_done', costUsd: 0 };
      return;
    }
    if (act === 'answer') {
      yield { type: 'gen_done', costUsd: 0 };
      return;
    }

    // act === 'render' — generate from the CURRENT shaped values (the assembled prompt).
    const assembled = builderParts.map((p) => p.value?.trim()).filter(Boolean).join(', ');
    const req: RoutingRequest = {
      intent: assembled || frame.goal,
      needs: [], // reference capacity is handled by Gate 1 (req.references), not a blanket multi_reference tag
      count: frame.count,
      fanModels: fanModelsN,
      perModel: perModelN,
      models: manualModels,
      aspectRatio: fanAspect,
      references: turn.references && turn.references.length > 0 ? turn.references : frame.assetRefs,
      budgetUsd: frame.budgetUsd,
    };
    yield { type: 'step', id: 'selecting', label: 'Selecting the model…', status: 'start' };
    yield { type: 'step', id: 'selecting', status: 'done' };
    yield { type: 'gen_start' };
    let cost = 0;
    let scoreByModel: Record<string, number> = {};
    for await (const ev of coordinateImage(req, { maxCostUsd: frame.budgetUsd })) {
      if (ev.type === 'routed') {
        scoreByModel = Object.fromEntries(ev.decision.fanout.map((r) => [r.modelId, r.score ?? 0]));
        yield { type: 'gen_plan', models: ev.models };
      } else if (ev.type === 'tile') {
        yield { type: 'image', url: ev.tile.image.url, modelLabel: ev.tile.modelLabel, index: ev.totalSoFar - 1, score: scoreByModel[ev.tile.modelId] };
      } else if (ev.type === 'done') {
        cost = ev.costUsd;
      } else if (ev.type === 'notice') {
        yield { type: 'gen_notice', message: ev.message };
      } else if (ev.type === 'error' || ev.type === 'model_error') {
        yield { type: 'gen_error', message: 'message' in ev ? ev.message : `model error: ${ev.reason}` };
      }
    }
    yield { type: 'gen_done', costUsd: cost };
    return;
  }

  // 1) The Image agent's brain: brief (+ any follow-up) → render plan (opener text + plan_render
  //    tool call). Its craft (plan-then-generate, reference workflows, prompt formulas) is skills.
  // A consult leg (the transfer landing) shows "Shaping the five parts…" in the reel; a render leg
  // is "Composing your render…" — the workspace's honest milestone (it used to just shimmer here).
  yield {
    type: 'step',
    id: 'shaping',
    label: followUp ? 'Composing your render…' : 'Shaping the five prompt parts…',
    status: 'start',
  };
  let plan: { prompt?: unknown; needs?: unknown; aspectRatio?: unknown; count?: unknown; referenceRecommendation?: unknown; parts?: unknown } = {};
  try {
    const client = new Anthropic();
    let userContent: string;
    if (!followUp) {
      userContent =
        `BRIEF (verified — start at Decide):\n${JSON.stringify(frame)}\n\n` +
        `This is the CONSULTATION (guided) leg: do NOT render — no images are generated now. Your opener is ONE ` +
        `calm sentence (e.g. "Let's shape this — I've laid out the five parts in the Prompt Builder on the ` +
        `right; tune them and hit Render when it feels right"). Refer to the Prompt Builder, never "below". Never ` +
        `claiming you're rendering and NOT a long list of specs (the parts ARE the specs). In plan_render, fill ` +
        `\`parts\` (the image FORMULA — Subject/Action/Context/Composition/Style, each with guidance + a value ` +
        `pre-filled from the brief + 3–5 suggested chips) plus prompt + needs so the reference facts are grounded. ` +
        `The user shapes the parts in the Prompt Builder and commits later.`;
    } else {
      const parts = [
        `BRIEF (verified):\n${JSON.stringify(frame)}`,
        `This is a RENDER turn — you ARE generating now. Your opener is ONE short sentence noting what you're rendering (e.g. "Rendering your Camaro now."). Do NOT ask the user to "set up the pass", "shape the parts", or attach references — that already happened; just render.`,
      ];
      if (instruction) parts.push(`The user shaped this in the Prompt Builder — render EXACTLY this, it is the final prompt:\n${instruction}`);
      if (refCount > 0)
        parts.push(
          `The user attached ${refCount} reference image${refCount === 1 ? '' : 's'} — plan to USE them (compose/edit from them; keep the subject consistent). Do NOT add "multi_reference" to needs — reference capacity is handled downstream.`
        );
      userContent = parts.join('\n\n');
    }
    const params = {
      model: MODEL,
      max_tokens: 1200,
      thinking: { type: 'adaptive', display: 'summarized' },
      system: IMAGE_AGENT_SYSTEM + imageAgentSkills(),
      tools: [PLAN_TOOL],
      messages: [
        ...(turn.history ?? []).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: userContent },
      ],
    };
    const stream = client.messages.stream(params as any);
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
        yield { type: 'agent_text', delta: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield {
      type: 'agent_usage',
      inputTokens: (final as { usage?: { input_tokens?: number } })?.usage?.input_tokens ?? 0,
      outputTokens: (final as { usage?: { output_tokens?: number } })?.usage?.output_tokens ?? 0,
    };
    const tool = ((final?.content ?? []) as Array<{ type: string; name?: string; input?: unknown }>)
      .find((b) => b.type === 'tool_use' && b.name === 'plan_render');
    plan = (tool?.input as typeof plan) ?? {};
  } catch (err) {
    yield { type: 'gen_error', message: err instanceof Error ? err.message : 'Image agent failed to plan' };
    yield { type: 'gen_done', costUsd: 0 };
    return;
  }
  yield { type: 'step', id: 'shaping', status: 'done' };

  // 2) Derive the RoutingRequest — the Image agent OWNS these specs; Gate 1 activates from them.
  const needs = Array.isArray(plan.needs)
    ? (plan.needs.filter((n): n is Capability => typeof n === 'string' && (VALID_CAPS as readonly string[]).includes(n)))
    : [];
  // Reference capacity is enforced by Gate 1 from req.references (a model just needs to ACCEPT that
  // many), so we do NOT force a blanket 'multi_reference' need — that wrongly benched ref-capable
  // models (Flux etc.). The plan's own needs (photoreal/text/…) still apply.
  const req: RoutingRequest = {
    intent: typeof plan.prompt === 'string' && plan.prompt.trim() ? plan.prompt.trim() : frame.goal,
    needs,
    aspectRatio: fanAspect ?? (typeof plan.aspectRatio === 'string' ? plan.aspectRatio : undefined),
    count: typeof plan.count === 'number' && plan.count > 0 ? Math.min(8, Math.floor(plan.count)) : frame.count,
    fanModels: fanModelsN,
    perModel: perModelN,
    models: manualModels,
    references: turn.references && turn.references.length > 0 ? turn.references : frame.assetRefs,
    budgetUsd: frame.budgetUsd,
  };

  // 2b) Consult the MODEL AGENT for the capability TRUTH of the model that will serve this request
  //     (reference count, style transfer, editing) and surface a grounded reference recommendation.
  //     This is the "attach up to N — and here's support you didn't know about" moment; it never
  //     invents a limit. Best-effort — a lookup miss just skips the recommendation, never blocks gen.
  //     Only on the FIRST leg (the transfer) — don't repeat the recommendation on every follow-up.
  if (!followUp) {
    // The STRUCTURED CONSULT (PR-10a/c): the builder's STRUCTURE comes from the TARGET model's
    // documented FORMULA (parts/labels/guidance/weight/order — via the Model agent), and the CONTENT
    // (values + suggested chips) from the agent, matched by id. Different model → different parts.
    // Never-null: a router hang must not drop the guide or strip its reference support (issue: the
    // References field silently degraded to a bare "Attach references"). Falls back to the default
    // image model's facts so "attach up to N" + supports are ALWAYS present.
    yield { type: 'step', id: 'grounding', label: 'Grounding model support…', status: 'start' };
    const facts = await describeModelCapabilitiesOrDefault(req);
    yield { type: 'step', id: 'grounding', status: 'done' };
    const formula = facts.formula;
    const parts = buildFormulaParts(formula, plan.parts, frame);
    const subject = (frame.subject || frame.goal || 'the subject').trim();
    yield {
      type: 'agent_a2ui',
      block: {
        kind: 'builder',
        surface: 'canvas',
        title: `Prompt guide · ${subject}`,
        media: frame.medium === 'video' ? 'video' : 'image',
        parts,
        modelId: facts.modelId,
        assembly: formula.assembly,
        model: { label: facts.modelLabel, maxReferences: facts.maxReferenceImages, supports: capabilityHighlights(facts) },
      },
    };
  }

  // REFERENCE-FIRST: a GUIDED hand-off's first leg is a CONSULTATION — never spend on a render. The
  // user commits later (attaches refs / says generate) in the workspace, which routes to
  // /api/image-agent as a follow-up (followUp === true) and generates then. A 'quick' transfer skips
  // this by arriving WITH an instruction (followUp === true from the start), so it renders now.
  if (!followUp) {
    yield { type: 'gen_done', costUsd: 0 };
    return;
  }

  // 3) Generate — coordinateImage consults the Model agent for selection, then dispatches. Only
  //    NOW does the "Generating…" state turn on (gen_start) — the consult leg above never reaches here.
  yield { type: 'step', id: 'selecting', label: 'Selecting the model…', status: 'start' };
  yield { type: 'step', id: 'selecting', status: 'done' };
  yield { type: 'gen_start' };
  let cost = 0;
  let scoreByModel: Record<string, number> = {};
  for await (const ev of coordinateImage(req, { maxCostUsd: frame.budgetUsd })) {
    if (ev.type === 'routed') {
      scoreByModel = Object.fromEntries(ev.decision.fanout.map((r) => [r.modelId, r.score ?? 0]));
    } else if (ev.type === 'tile') {
      yield { type: 'image', url: ev.tile.image.url, modelLabel: ev.tile.modelLabel, index: ev.totalSoFar - 1, score: scoreByModel[ev.tile.modelId] };
    } else if (ev.type === 'done') {
      cost = ev.costUsd;
    } else if (ev.type === 'notice') {
      yield { type: 'gen_notice', message: ev.message };
    } else if (ev.type === 'error' || ev.type === 'model_error') {
      yield { type: 'gen_error', message: 'message' in ev ? ev.message : `model error: ${ev.reason}` };
    }
  }
  yield { type: 'gen_done', costUsd: cost };
}
