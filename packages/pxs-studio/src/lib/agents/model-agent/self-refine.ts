/**
 * SELF-REFINEMENT — the agent applies the model's own doctrine to its own draft, BEFORE the user
 * sees it.
 *
 * The gap this closes: we built a doctrine-grounded judge and then only let the USER invoke it. So
 * the agent would write iteration-zero, the critique would sit behind a button, and a prompt that
 * violated the model's documented rules shipped to the builder looking finished. The craft was in
 * the system but never applied by default — the user had to know to ask for it.
 *
 * Now: draft → critique against that model's doctrine → apply only the fixes that clearly improve
 * it → hand over a stronger starting point. The user still owns every field; this raises where the
 * conversation STARTS, it doesn't take the pen away.
 *
 * Guardrails, because an auto-editor that overwrites the user is worse than none:
 *   · Only parts the critique actually flagged are touched. Everything else is left verbatim.
 *   · The user's OWN words are never replaced — a part is only refined when its current value came
 *     from the agent's draft (iteration zero), never after a human has typed in it.
 *   · A blocked/failed refine is a no-op that returns the draft untouched. Never a dead end.
 *   · Every change is reported, so the Guide can say WHAT it improved and WHY (with the receipt).
 */

import Anthropic from '@anthropic-ai/sdk';
import { AGENT_MODELS } from '../model-config';
import { critiquePrompt, type CraftFinding } from './craft-critique';
import { parseJsonResponse, responseText } from './json-response';
import type { ModelDoctrine } from './doctrine';
import type { PromptFormula } from '../../engine/model-registry';

const MODEL = AGENT_MODELS.imageAgent;

export interface RefinablePart {
  id: string;
  label: string;
  guidance: string;
  value: string;
}

export interface RefinedPart {
  id: string;
  /** The improved value. */
  value: string;
  /** Why it changed — the doctrine line behind it, for the Guide to show. */
  because: string;
}

export interface SelfRefineResult {
  /** Applied edits, keyed by part id. Empty when nothing needed changing. */
  edits: RefinedPart[];
  /** The pre-refinement craft score, when a critique was possible. */
  scoreBefore?: number;
  /** One line the Guide can surface about what was tightened. */
  summary?: string;
}

const SYSTEM = `You are refining an image prompt you just drafted, using the target model's OWN documented doctrine and a critique of your draft.

Apply the critique's fixes to the affected parts. Rules:
- Rewrite ONLY the parts named in the findings. Return nothing for any part you are not improving.
- Return each refined part's COMPLETE new value, not a fragment or a diff.
- Stay faithful to the user's intent and subject. You are sharpening HOW it is described for this model — never changing WHAT they asked for. Do not add subjects, objects, or story that the user did not ask for.
- Write in the register this model's doctrine rewards (its phrasing, its vocabulary, its length budget).
- If a finding cannot be fixed without inventing content the user never specified, SKIP it. An honest thin part beats a rich invented one.

Respond with ONLY a JSON object, no prose:
{"edits":[{"id":"<part id>","value":"<complete improved value>","because":"<the doctrine reason, one short clause>"}],"summary":"<one short sentence on what you tightened>"}`;

export interface SelfRefineInput {
  modelId: string;
  modelLabel: string;
  formula: PromptFormula;
  parts: RefinablePart[];
  doctrine?: ModelDoctrine | null;
  /** Part ids the USER has edited — never refined, never overwritten. */
  userOwnedPartIds?: string[];
}

/**
 * Critique the draft and apply the fixes worth applying. Never throws: any failure returns no edits,
 * leaving the draft exactly as written.
 */
export async function selfRefine(
  input: SelfRefineInput,
  opts: { client?: Anthropic } = {},
): Promise<SelfRefineResult> {
  const { modelId, modelLabel, formula, doctrine } = input;
  const none: SelfRefineResult = { edits: [] };
  // No doctrine → no model-specific standard to refine against. Generic "improvement" here would be
  // the same hollow advice the craft score refuses to give.
  if (!doctrine) return none;

  const critique = await critiquePrompt({ modelId, modelLabel, formula, parts: input.parts, doctrine }, opts);
  if (!critique.available) return none;

  const userOwned = new Set(input.userOwnedPartIds ?? []);
  // Worth acting on: a real fix, on a part the user hasn't taken over. 'polish' is left for the human —
  // auto-applying cosmetic rewrites churns the draft for no gain.
  const actionable = critique.findings.filter(
    (f: CraftFinding) => f.severity !== 'polish' && f.fix && (!f.partId || !userOwned.has(f.partId)),
  );
  if (actionable.length === 0) return { edits: [], scoreBefore: critique.score };

  const doctrineBlock = [
    doctrine.principles.length ? `IT REWARDS:\n${doctrine.principles.slice(0, 8).map((p) => `- ${p}`).join('\n')}` : '',
    doctrine.antiPatterns.length ? `IT PUNISHES:\n${doctrine.antiPatterns.slice(0, 6).map((p) => `- ${p}`).join('\n')}` : '',
    doctrine.formula?.assembly ? `ASSEMBLY: ${doctrine.formula.assembly}` : '',
  ].filter(Boolean).join('\n\n');

  const partsBlock = input.parts
    .map((p) => `- ${p.label} (id: ${p.id})${userOwned.has(p.id) ? ' [USER-WRITTEN — do not change]' : ''}: ${p.value?.trim() || '(empty)'}`)
    .join('\n');

  const findingsBlock = actionable
    .map((f) => `- [${f.severity}] ${f.partId || 'overall'}: ${f.issue}\n  FIX: ${f.fix}\n  PER THE DOCS: ${f.groundedIn}`)
    .join('\n');

  try {
    const client = opts.client ?? new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `TARGET MODEL: ${modelLabel}\n\n${doctrineBlock}\n\nTHE DRAFT:\n${partsBlock}\n\nCRITIQUE TO APPLY:\n${findingsBlock}`,
        },
      ],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const parsed = parseJsonResponse(responseText(msg));
    if (!parsed) return { edits: [], scoreBefore: critique.score };

    const byId = new Map(input.parts.map((p) => [p.id, p]));
    const edits: RefinedPart[] = (Array.isArray(parsed.edits) ? (parsed.edits as unknown[]) : [])
      .map((e) => e as Record<string, unknown>)
      .flatMap((e) => {
        const id = typeof e?.id === 'string' ? e.id.trim() : '';
        const value = typeof e?.value === 'string' ? e.value.trim() : '';
        // Guard every rule in code, not just in the prompt: a real part, not user-owned, actually changed.
        if (!id || !value || !byId.has(id) || userOwned.has(id)) return [];
        if (value === (byId.get(id)!.value ?? '').trim()) return [];
        return [{ id, value, because: typeof e?.because === 'string' ? e.because.trim() : '' }];
      })
      .slice(0, 8);

    return {
      edits,
      scoreBefore: critique.score,
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined,
    };
  } catch (err) {
    console.warn(`[self-refine] ${modelId} failed:`, err);
    return { edits: [], scoreBefore: critique.score };
  }
}
