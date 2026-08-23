/**
 * Prove the FAN-OUT VISIBILITY spine end-to-end with ZERO spend.
 *
 * Drives the REAL coordinator + the REAL fan recorder with STUB provider adapters, so the whole
 * event path (coordinator lifecycle → fan_model events → the persisted summary) is exercised
 * without calling a provider. The scenario is the one the plan's smoke test describes:
 *
 *   • one model delivers everything          → done
 *   • one model delivers PART, then errors   → failed, but its tiles stand
 *   • one model fails outright (no key path) → failed with an honest reason
 *
 * What this CAN'T prove: that a real provider adapter behaves like the stub. The live 3×3 smoke
 * test (which costs money) is still the last mile.
 *
 * Run: npx tsx scripts/prove-fanout.ts
 */

// Fake keys BEFORE the registry/adapters load — Gate 1 drops any model whose env key is absent.
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.REPLICATE_API_TOKEN ||= 'test-key';
process.env.GEMINI_API_KEY ||= 'test-key';

import { coordinateImage } from '../src/lib/engine/coordinator';
import { registerExecutor, type GenEvent, type ImageExecutor } from '../src/lib/engine/executor';
import type { ImageProvider } from '../src/lib/engine/model-registry';
import { createFanRecorder, type ImageAgentEvent } from '../src/lib/agents/image-agent';
import type { RoutingRequest } from '../src/lib/engine/routing';

/** A stub adapter with a scripted outcome — registered OVER the real one for this run. */
function stub(provider: ImageProvider, plan: { tiles: number; failAfter?: boolean; reason?: string }): ImageExecutor {
  return {
    provider,
    isConfigured: () => true,
    async *generate(req): AsyncIterable<GenEvent> {
      const images = [];
      for (let i = 0; i < Math.min(plan.tiles, req.n); i++) {
        await new Promise((r) => setTimeout(r, 10));
        const image = { url: `https://stub.test/${provider}-${i}.png` };
        images.push(image);
        yield { type: 'tile', image, index: i };
      }
      if (plan.failAfter) {
        yield { type: 'error', reason: (plan.reason as GenEvent extends { reason: infer R } ? R : never) ?? 'timeout' };
        return;
      }
      yield { type: 'done', images, costUsd: 0.01 * images.length };
    },
  };
}

/* The three outcomes, one per provider. */
registerExecutor(stub('openai', { tiles: 3 }));                                        // full success
registerExecutor(stub('replicate', { tiles: 1, failAfter: true, reason: 'timeout' })); // partial → failed
registerExecutor(stub('gemini', { tiles: 0, failAfter: true, reason: 'moderated' }));  // outright failure

/** Mirror of the agent's streamFan translation, so we assert on the events the CLIENT receives. */
async function* clientEvents(req: RoutingRequest): AsyncIterable<ImageAgentEvent> {
  let scoreByModel: Record<string, number> = {};
  let cost = 0;
  for await (const ev of coordinateImage(req, { maxCostUsd: 5 })) {
    if (ev.type === 'routed') {
      scoreByModel = Object.fromEntries(ev.decision.fanout.map((r) => [r.modelId, r.score ?? 0]));
      yield { type: 'gen_plan', models: ev.models };
    } else if (ev.type === 'model_start') {
      yield { type: 'fan_model', modelId: ev.modelId, state: 'running' };
    } else if (ev.type === 'tile') {
      yield { type: 'image', url: ev.tile.image.url, modelId: ev.tile.modelId, modelLabel: ev.tile.modelLabel, index: ev.totalSoFar - 1, score: scoreByModel[ev.tile.modelId] };
    } else if (ev.type === 'model_done') {
      yield { type: 'fan_model', modelId: ev.modelId, state: 'done', delivered: ev.delivered, ms: ev.ms };
    } else if (ev.type === 'model_error') {
      yield { type: 'fan_model', modelId: ev.modelId, state: 'failed', reason: ev.reason };
    } else if (ev.type === 'notice') {
      yield { type: 'gen_notice', message: ev.message };
    } else if (ev.type === 'error') {
      yield { type: 'gen_error', message: ev.message };
    } else if (ev.type === 'done') {
      cost = ev.costUsd;
    }
  }
  yield { type: 'gen_done', costUsd: cost };
}

const failures: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures.push(name);
}

async function main() {
  const req: RoutingRequest = {
    intent: 'a rain-soaked neon portrait at dusk',
    needs: [],
    count: 9,
    // Manual pick = deterministic routing (no LLM call, no spend).
    models: ['gpt-image-1', 'flux-1.1-pro', 'nano-banana'],
    perModel: 3,
  };

  const recorder = createFanRecorder();
  const seen: ImageAgentEvent[] = [];
  for await (const ev of clientEvents(req)) {
    recorder.observe(ev);
    seen.push(ev);
  }

  const plan = seen.find((e) => e.type === 'gen_plan');
  const images = seen.filter((e) => e.type === 'image');
  const fanEvents = seen.filter((e) => e.type === 'fan_model');
  const genErrors = seen.filter((e) => e.type === 'gen_error');
  const notices = seen.filter((e) => e.type === 'gen_notice');
  const summary = recorder.summary();

  console.log('\n■ The fan the client saw');
  check('gen_plan arrives with all 3 models', plan?.type === 'gen_plan' && plan.models.length === 3, `${plan?.type === 'gen_plan' ? plan.models.length : 0} models`);
  check('every planned model carries an id + why', plan?.type === 'gen_plan' && plan.models.every((m) => !!m.modelId && !!m.why));
  check('each model announced running', fanEvents.filter((e) => e.type === 'fan_model' && e.state === 'running').length === 3);

  console.log('\n■ A failed model does NOT fail the turn (the bug this started with)');
  check('no turn-level gen_error', genErrors.length === 0, genErrors.length ? String((genErrors[0] as { message: string }).message) : 'none');
  check('the healthy model still delivered 3 tiles', images.filter((e) => e.type === 'image' && e.modelId === 'gpt-image-1').length === 3);
  check('the partial model kept the tile it landed', images.filter((e) => e.type === 'image' && e.modelId === 'flux-1.1-pro').length === 1);
  check('best-effort notice raised for the shortfall', notices.length === 1, notices.length ? String((notices[0] as { message: string }).message) : 'none');

  console.log('\n■ The persisted record (what a reload repaints from)');
  for (const row of summary) {
    console.log(`   → ${row.label.padEnd(30)} ${row.state.padEnd(6)} ${row.delivered}/${row.n}${row.reason ? `  (${row.reason})` : ''}`);
  }
  check('summary has one row per planned model', summary.length === 3);
  check('the healthy model is done 3/3', summary.some((r) => r.model_id === 'gpt-image-1' && r.state === 'done' && r.delivered === 3));
  check('the partial model is failed 1/3 w/ reason', summary.some((r) => r.model_id === 'flux-1.1-pro' && r.state === 'failed' && r.delivered === 1 && r.reason === 'timeout'));
  check('the dead model is failed 0/3 w/ reason', summary.some((r) => r.model_id === 'nano-banana' && r.state === 'failed' && r.delivered === 0 && r.reason === 'moderated'));

  const delivered = summary.reduce((s, r) => s + r.delivered, 0);
  const planned = summary.reduce((s, r) => s + r.n, 0);
  console.log(`\n  Tally: ${delivered}/${planned} delivered · ${summary.filter((r) => r.state === 'failed').length} models failed`);

  console.log(failures.length === 0 ? '\n✓ spine verified\n' : `\n✗ ${failures.length} check(s) failed: ${failures.join(', ')}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
