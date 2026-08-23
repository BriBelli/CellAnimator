/**
 * PILOT — Fable vs Opus on the IMAGE AGENT's prompt craft, one fixed brief. Text-only, no image spend.
 *
 * Runs the EXACT image-agent render-leg call (real IMAGE_AGENT_SYSTEM + skills + PLAN_TOOL) through both
 * models and prints the crafted prompt + needs side by side, so we can judge whether Fable's prompt is
 * actually better before paying to render or exposing it as an opt-up.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/pilot-image-brain.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { IMAGE_AGENT_SYSTEM, PLAN_TOOL } from '../src/lib/agents/image-agent';
import { imageAgentSkills } from '../src/lib/agents/skills';

const BRIEF = {
  goal: 'a photoreal character reference sheet of a young athletic man — front, side, and back full-body views, consistent identity',
  subject: 'young athletic man',
  medium: 'image',
};

// Faithful to the image-agent's render leg (no instruction / refs — a clean from-brief craft).
const USER = [
  `BRIEF (verified):\n${JSON.stringify(BRIEF)}`,
  `This is a RENDER turn — you ARE generating now. Craft the model-ready prompt for this brief.`,
].join('\n\n');

async function craft(model: string) {
  const client = new Anthropic();
  const t0 = Date.now();
  const msg = await client.messages.create({
    model,
    max_tokens: 3000,
    thinking: { type: 'adaptive' }, // Fable = thinking always-on; adaptive is valid on both
    system: IMAGE_AGENT_SYSTEM + imageAgentSkills(),
    tools: [PLAN_TOOL],
    messages: [{ role: 'user', content: USER }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const ms = Date.now() - t0;
  if ((msg as { stop_reason?: string }).stop_reason === 'refusal') return { model, ms, refused: true };
  const blocks = (msg.content ?? []) as Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  const opener = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  const plan = (blocks.find((b) => b.type === 'tool_use' && b.name === 'plan_render')?.input ?? {}) as {
    prompt?: string; needs?: string[]; aspectRatio?: string; count?: number;
  };
  const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return { model, ms, opener, plan, tokens: `${u?.input_tokens ?? '?'}→${u?.output_tokens ?? '?'}` };
}

async function main() {
  console.log(`\nBRIEF: ${BRIEF.goal}\n${'═'.repeat(90)}`);
  for (const model of ['claude-opus-4-8', 'claude-fable-5']) {
    try {
      const r = await craft(model);
      console.log(`\n■ ${model}   ${'refused' in r ? '⚠ REFUSED' : `${(r.ms / 1000).toFixed(1)}s · ${r.tokens} tok`}`);
      if ('refused' in r) continue;
      console.log(`  needs: ${(r.plan.needs ?? []).join(', ') || '(none)'}${r.plan.aspectRatio ? ` · aspect ${r.plan.aspectRatio}` : ''}${r.plan.count ? ` · count ${r.plan.count}` : ''}`);
      console.log(`  opener: ${r.opener}`);
      console.log(`  PROMPT:\n    ${(r.plan.prompt ?? '(none)').replace(/\n/g, '\n    ')}`);
    } catch (err) {
      console.log(`\n■ ${model}   ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${'═'.repeat(90)}\nJudge: which PROMPT would you rather render? That's whether Fable earns the opt-up here.\n`);
}

void main();
