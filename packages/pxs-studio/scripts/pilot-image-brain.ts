/**
 * PILOT — Fable vs Opus on the IMAGE AGENT's CRAFT, one fixed brief. Text-only, no image spend.
 *
 * The craft that matters is the GUIDED/consultation leg: the image agent breaks the brief into the
 * builder FORMULA (Subject/Action/Context/Composition/Style), each with a pre-filled value, a suggested
 * `recommend`, and 3–5 tailored `chips`. That's where a stronger brain shows — richer, more specific
 * recommends and sharper chips. This runs the EXACT consultation call (real IMAGE_AGENT_SYSTEM + skills
 * + PLAN_TOOL) through both models and prints the parts side by side to judge.
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

// Faithful to the image-agent's CONSULTATION (guided) leg — the parts craft, not a render.
const USER =
  `BRIEF (verified — start at Decide):\n${JSON.stringify(BRIEF)}\n\n` +
  `This is the CONSULTATION (guided) leg: do NOT render. In plan_render, fill \`parts\` (the image ` +
  `FORMULA — Subject/Action/Context/Composition/Style, each with guidance + a value pre-filled from the ` +
  `brief + a rich \`recommend\` + 3–5 suggested chips) plus prompt + needs. The user shapes the parts in ` +
  `the Prompt Builder and commits later.`;

interface Part { id?: string; label?: string; value?: string; recommend?: string; chips?: string[] }

async function craft(model: string) {
  const client = new Anthropic();
  const t0 = Date.now();
  const msg = await client.messages.create({
    model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' }, // Fable = thinking always-on; adaptive is valid on both
    system: IMAGE_AGENT_SYSTEM + imageAgentSkills(),
    tools: [PLAN_TOOL],
    messages: [{ role: 'user', content: USER }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const ms = Date.now() - t0;
  if ((msg as { stop_reason?: string }).stop_reason === 'refusal') return { model, ms, refused: true as const };
  const blocks = (msg.content ?? []) as Array<{ type: string; name?: string; input?: unknown }>;
  const plan = (blocks.find((b) => b.type === 'tool_use' && b.name === 'plan_render')?.input ?? {}) as {
    prompt?: string; needs?: string[]; parts?: Part[];
  };
  const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return { model, ms, plan, tokens: `${u?.input_tokens ?? '?'}→${u?.output_tokens ?? '?'}` };
}

function show(parts: Part[] = []) {
  for (const p of parts) {
    console.log(`  ▸ ${(p.label ?? p.id ?? '?').toUpperCase()}`);
    if (p.value) console.log(`      value:     ${p.value}`);
    console.log(`      recommend: ${p.recommend ?? '(none)'}`);
    console.log(`      chips:     ${(p.chips ?? []).join(' · ') || '(none)'}`);
  }
}

async function main() {
  console.log(`\nBRIEF: ${BRIEF.goal}\n${'═'.repeat(92)}`);
  for (const model of ['claude-opus-4-8', 'claude-fable-5']) {
    try {
      const r = await craft(model);
      if ('refused' in r) { console.log(`\n■ ${model}   ⚠ REFUSED`); continue; }
      console.log(`\n■ ${model}   ${(r.ms / 1000).toFixed(1)}s · ${r.tokens} tok · needs: ${(r.plan.needs ?? []).join(', ') || '(none)'}`);
      show(r.plan.parts);
    } catch (err) {
      console.log(`\n■ ${model}   ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${'═'.repeat(92)}\nJudge: whose RECOMMENDS + CHIPS are richer/more specific? That's whether Fable earns the opt-up.\n`);
}

void main();
