/**
 * PILOT / continuous A/B — Fable vs Opus on the IMAGE AGENT's CRAFT, across MANY classes. Text-only.
 *
 * The craft that matters is the GUIDED/consultation leg: the image agent breaks a brief into the builder
 * FORMULA (Subject/Action/Context/Composition/Style), each with a value, a `recommend`, and chips. That's
 * where a stronger brain shows — richer, more domain-specific direction. This runs the EXACT consultation
 * call (real IMAGE_AGENT_SYSTEM + skills + PLAN_TOOL) through both models on several classes so we can
 * confirm Fable's edge GENERALIZES (and catch any class where it regresses, e.g. under-tagging needs).
 *
 * Add a brief to BRIEFS to extend the sweep. Usage:
 *   node --env-file=.env.local --import tsx scripts/pilot-image-brain.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { IMAGE_AGENT_SYSTEM, PLAN_TOOL } from '../src/lib/agents/image-agent';
import { imageAgentSkills } from '../src/lib/agents/skills';

const BRIEFS: { klass: string; goal: string; subject: string }[] = [
  { klass: 'character-sheet', subject: 'young athletic man',
    goal: 'a photoreal character reference sheet of a young athletic man — front, side, and back full-body views, consistent identity' },
  { klass: 'vector-logo', subject: "coffee roastery 'Ember'",
    goal: "a minimalist vector logo mark for a coffee roastery called 'Ember' — single flat scalable mark, no photorealism" },
  { klass: 'product-shot', subject: 'wireless headphones',
    goal: 'a photoreal studio product shot of matte-black over-ear wireless headphones on a seamless background' },
  { klass: 'cinematic-scene', subject: 'neon Tokyo alley',
    goal: 'a cinematic wide establishing shot of a rain-soaked neon Tokyo alley at night, moody and atmospheric' },
];

const MODELS = ['claude-opus-4-8', 'claude-fable-5'];

interface Part { id?: string; label?: string; value?: string; recommend?: string; chips?: string[] }

function userContent(brief: { goal: string; subject: string }) {
  return (
    `BRIEF (verified — start at Decide):\n${JSON.stringify({ ...brief, medium: 'image' })}\n\n` +
    `This is the CONSULTATION (guided) leg: do NOT render. In plan_render, fill \`parts\` (the image ` +
    `FORMULA — Subject/Action/Context/Composition/Style, each with guidance + a value pre-filled from ` +
    `the brief + a rich \`recommend\` + 3–5 chips) plus prompt + needs.`
  );
}

async function craft(model: string, brief: { goal: string; subject: string }) {
  const client = new Anthropic();
  const t0 = Date.now();
  const msg = await client.messages.create({
    model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: IMAGE_AGENT_SYSTEM + imageAgentSkills(),
    tools: [PLAN_TOOL],
    messages: [{ role: 'user', content: userContent(brief) }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const ms = Date.now() - t0;
  if ((msg as { stop_reason?: string }).stop_reason === 'refusal') return { model, ms, refused: true as const };
  const blocks = (msg.content ?? []) as Array<{ type: string; name?: string; input?: unknown }>;
  const plan = (blocks.find((b) => b.type === 'tool_use' && b.name === 'plan_render')?.input ?? {}) as {
    needs?: string[]; parts?: Part[];
  };
  const u = (msg as { usage?: { output_tokens?: number } }).usage;
  return { model, ms, out: u?.output_tokens ?? 0, plan };
}

async function main() {
  for (const brief of BRIEFS) {
    console.log(`\n\n████ CLASS: ${brief.klass} ████  (${brief.goal})`);
    for (const model of MODELS) {
      try {
        const r = await craft(model, brief);
        if ('refused' in r) { console.log(`\n  ${model}: ⚠ REFUSED`); continue; }
        console.log(`\n  ── ${model}  (${(r.ms / 1000).toFixed(1)}s · ${r.out} out-tok) · needs: ${(r.plan.needs ?? []).join(', ') || '(none)'}`);
        for (const p of r.plan.parts ?? []) {
          console.log(`     ${(p.label ?? p.id ?? '?').padEnd(16)} ${p.recommend ?? '(none)'}`);
        }
      } catch (err) {
        console.log(`\n  ${model}: ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log(`\n\nJudge per class: whose RECOMMENDS are more specific/expert — and did either under-tag needs?\n`);
}

void main();
