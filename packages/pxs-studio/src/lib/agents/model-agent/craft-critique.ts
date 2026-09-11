/**
 * CRAFT CRITIQUE — the real prompt score, and the one that has to show its work.
 *
 * The structure floor (lib/prompt-score.ts) can only prove a prompt is COMPLETE. Whether it is GOOD
 * is a question about one specific model's craft: does it phrase things the way Nano Banana's guide
 * teaches (materiality, positive framing, quoted text)? Does it index-address FLUX's references?
 * Does it exceed Ideogram's word budget? Nobody can answer that from a word count — and until now
 * nothing in the system tried; the ring just showed 90% because the boxes had text in them.
 *
 * So this judges the ASSEMBLED prompt against the target model's distilled DOCTRINE (its own
 * published guide, ingested in full — see doctrine.ts), and returns:
 *   · a score it must justify,
 *   · findings, each naming the part, the issue, a concrete FIX, and the doctrine line it comes from,
 *   · what's genuinely working (so the user learns the model, not just obeys a number).
 *
 * Honesty rules, enforced in code below:
 *   · NO DOCTRINE → NO CRAFT SCORE. Without the model's guide this would be generic prompt-advice
 *     dressed as model expertise — exactly the fake the Prompt Guide was accused of being. It
 *     returns `unavailable` and the UI shows structure only. Silence beats invented authority.
 *   · Findings without a fix are dropped: a critique the user can't act on is noise.
 *   · The score is clamped by the findings — you cannot be told "94" alongside three blocking
 *     problems (see reconcile()).
 */

import Anthropic from '@anthropic-ai/sdk';
import { AGENT_MODELS } from '../model-config';
import type { ModelDoctrine } from './doctrine';
import type { PromptFormula } from '../../engine/model-registry';
import { parseJsonResponse, responseText } from './json-response';

const MODEL = AGENT_MODELS.imageAgent;

export type FindingSeverity = 'blocking' | 'weak' | 'polish';

export interface CraftFinding {
  /** The formula part this is about ('' when it's about the prompt as a whole). */
  partId: string;
  severity: FindingSeverity;
  /** What is wrong, in one concrete sentence. */
  issue: string;
  /** What to do instead — actionable, specific to this prompt. */
  fix: string;
  /** The doctrine principle/anti-pattern this is grounded in — the receipt. */
  groundedIn: string;
}

export interface CraftCritique {
  available: true;
  modelId: string;
  modelLabel: string;
  /** 0–100 — the earned score. Only this axis can exceed the structure cap. */
  score: number;
  /** One line on where the prompt stands for THIS model. */
  verdict: string;
  findings: CraftFinding[];
  /** What the prompt already does well by this model's own doctrine. */
  strengths: string[];
  /** Provenance — the docs the doctrine was distilled from. */
  sources: { url: string; kind: string }[];
  doctrineConfidence: 'low' | 'medium' | 'high';
}

export interface CraftUnavailable {
  available: false;
  /** Why there is no craft score — shown plainly rather than faked. */
  reason: 'no_doctrine' | 'empty_prompt' | 'failed';
  modelId: string;
  modelLabel: string;
}

export type CraftResult = CraftCritique | CraftUnavailable;

const SYSTEM = `You are the Prompt Guide's craft judge for ONE specific image model. You are given that model's DOCTRINE — its formula, the principles its own documentation says it rewards, and the anti-patterns its documentation warns against — plus the user's current prompt broken into parts.

Judge the prompt AS THIS MODEL'S DOCTRINE DEFINES GOOD. Not generic prompt advice: every judgement must trace to a doctrine line you were given. If the doctrine doesn't cover something, don't invent a rule for it.

Scoring (be a demanding professional, not a cheerleader):
- 90-100: would be hard to improve for this model; follows its formula and principles closely.
- 75-89: solid, with specific improvements available.
- 50-74: workable but missing craft this model rewards, or violating something it punishes.
- 25-49: thin or generic — this model will fill the gaps itself, and the result will be luck.
- 0-24: barely a brief.
A prompt that merely FILLS every part is NOT automatically good — filled-but-vague is 40s territory. Do not inflate. Most first drafts are 40-70.

findings: the specific things to change, most important first.
- severity: "blocking" (violates an anti-pattern / will visibly hurt the render), "weak" (misses craft this model rewards), "polish" (a refinement).
- issue: one concrete sentence about THIS prompt — quote the offending words.
- fix: exactly what to write instead. Concrete, usable, specific to this prompt. Never "add more detail".
- groundedIn: the doctrine principle or anti-pattern it comes from, quoted or closely paraphrased.
- partId: the id of the part it concerns, or "" for the prompt as a whole.
Every finding MUST have a real fix. Return at most 6.

strengths: up to 3 things the prompt genuinely already does well BY THIS DOCTRINE. Empty array if there are none — do not manufacture encouragement.

verdict: one plain sentence on where this prompt stands for this model.

Respond with ONLY a JSON object, no prose:
{"score":<0-100>,"verdict":"...","findings":[{"partId":"...","severity":"blocking|weak|polish","issue":"...","fix":"...","groundedIn":"..."}],"strengths":["..."]}`;

export interface CritiqueInput {
  modelId: string;
  modelLabel: string;
  formula: PromptFormula;
  parts: { id: string; label: string; value: string }[];
  doctrine?: ModelDoctrine | null;
}

/**
 * Reconcile the model's self-reported score with its own findings. An LLM asked for a number will
 * drift optimistic; the findings are the harder evidence. A blocking finding caps the score at 74
 * (it cannot be "solid" while violating the model's documented rules); two or more cap it at 59.
 * This is what stops the ring from ever again reading 90 while the critique lists real problems.
 */
export function reconcile(score: number, findings: CraftFinding[]): number {
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const weak = findings.filter((f) => f.severity === 'weak').length;
  let capped = Math.max(0, Math.min(100, Math.round(score)));
  if (blocking >= 2) capped = Math.min(capped, 59);
  else if (blocking === 1) capped = Math.min(capped, 74);
  if (blocking === 0 && weak >= 3) capped = Math.min(capped, 79);
  return capped;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function parseFindings(v: unknown): CraftFinding[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .map((raw) => raw as Record<string, unknown>)
    .flatMap((f) => {
      const issue = str(f?.issue);
      const fix = str(f?.fix);
      // A finding without an actionable fix is noise — drop it rather than show a shrug.
      if (!issue || !fix) return [];
      const severity: FindingSeverity =
        f?.severity === 'blocking' ? 'blocking' : f?.severity === 'polish' ? 'polish' : 'weak';
      return [{ partId: str(f?.partId), severity, issue, fix, groundedIn: str(f?.groundedIn) }];
    })
    .slice(0, 6);
}

/**
 * Judge a prompt against its target model's doctrine. Never throws — any failure returns an honest
 * `unavailable`, because a broken judge must degrade to "no craft score", never to a made-up one.
 */
export async function critiquePrompt(
  input: CritiqueInput,
  opts: { client?: Anthropic } = {},
): Promise<CraftResult> {
  const { modelId, modelLabel, doctrine } = input;
  const assembled = input.parts.map((p) => p.value?.trim()).filter(Boolean).join(', ');
  if (!assembled) return { available: false, reason: 'empty_prompt', modelId, modelLabel };

  // The honesty gate: no distilled doctrine → no craft claim. The system says "not yet", and the
  // doctrine pass fills it in on its next cycle.
  if (!doctrine || (doctrine.principles.length === 0 && doctrine.antiPatterns.length === 0)) {
    return { available: false, reason: 'no_doctrine', modelId, modelLabel };
  }

  const doctrineBlock = [
    `MODEL: ${modelLabel}`,
    doctrine.formula
      ? `ITS FORMULA: ${doctrine.formula.parts.map((p) => `${p.label} (${p.guidance})`).join(' | ')}${doctrine.formula.assembly ? `\nASSEMBLY: ${doctrine.formula.assembly}` : ''}`
      : `ITS FORMULA: ${input.formula.parts.map((p) => `${p.label} (${p.guidance})`).join(' | ')}`,
    doctrine.principles.length ? `IT REWARDS:\n${doctrine.principles.map((p) => `- ${p}`).join('\n')}` : '',
    doctrine.antiPatterns.length ? `IT PUNISHES:\n${doctrine.antiPatterns.map((p) => `- ${p}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const promptBlock = input.parts
    .map((p) => `- ${p.label} (id: ${p.id}): ${p.value?.trim() || '(empty)'}`)
    .join('\n');

  try {
    const client = opts.client ?? new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      // Room for 6 findings (issue + fix + grounding each) plus the verdict, with thinking on.
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${doctrineBlock}\n\nTHE USER'S PROMPT, BY PART:\n${promptBlock}\n\nASSEMBLED:\n${assembled}`,
        },
      ],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const parsed = parseJsonResponse(responseText(msg));
    if (!parsed) return { available: false, reason: 'failed', modelId, modelLabel };

    const findings = parseFindings(parsed.findings);
    return {
      available: true,
      modelId,
      modelLabel,
      score: reconcile(typeof parsed.score === 'number' ? parsed.score : 0, findings),
      verdict: str(parsed.verdict),
      findings,
      strengths: Array.isArray(parsed.strengths)
        ? (parsed.strengths as unknown[]).map(str).filter(Boolean).slice(0, 3)
        : [],
      sources: doctrine.sources ?? [],
      doctrineConfidence: doctrine.confidence,
    };
  } catch (err) {
    console.warn(`[craft-critique] ${modelId} failed:`, err);
    return { available: false, reason: 'failed', modelId, modelLabel };
  }
}
