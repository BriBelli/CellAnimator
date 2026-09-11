import { getDb } from '../../../lib/db';
import { checkCap, recordUsage } from '../../../lib/db/usage';
import { runVideoAgent, type VideoAgentEvent } from '../../../lib/agents/video-agent';
import { DEV_USER_ID, type Interaction, type Thread } from '../../../lib/db/models';

export const runtime = 'nodejs';
/** Video renders are 75-120s per model and a fan runs them concurrently. */
export const maxDuration = 600;

const newId = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * POST /api/video-agent — the Video workspace's own endpoint.
 *
 * Until now the Video nav routed to `runImageAgent` wearing a video badge: the doctrine, formulas and
 * task vocabulary built for video were read by nothing, and a shot was planned as though it were a
 * picture. This is the seam that ends that.
 *
 * Two legs, mirroring the image route: a CONSULTATION plans the shot and streams back a builder
 * block; a RENDER dispatches through the video coordinator and streams the job lifecycle (queued →
 * generating → clip), because a 100-second render with no signal is indistinguishable from a hang.
 *
 * Spend is gated BEFORE any work: the user's remaining budget is the ceiling handed to the agent, and
 * a render that would exceed it is refused whole rather than quietly shrunk.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    thread_id?: string;
    user_id?: string;
    /** Present → RENDER now (the user committed from the builder). */
    render_prompt?: string;
    shot?: {
      durationSec?: number;
      resolution?: string;
      aspectRatio?: string;
      audio?: boolean;
      models?: string[];
      fanModels?: number;
      perModel?: number;
    };
  };

  const prompt = (body.prompt ?? '').trim();
  const renderPrompt = (body.render_prompt ?? '').trim();
  const goal = renderPrompt || prompt;
  const userId = (body.user_id ?? '').trim() || DEV_USER_ID;
  const encoder = new TextEncoder();

  if (!goal) {
    return Response.json({ error: 'A prompt is required.' }, { status: 400 });
  }

  const db = await getDb();

  // ── SPEND GATE ────────────────────────────────────────────────────────────────────────────────
  // Video is ~50x an image per render, so this is checked before anything is planned, and the
  // REMAINING budget becomes the agent's ceiling rather than a fixed guess.
  let remainingUsd: number | undefined;
  try {
    const cap = await checkCap(db, userId);
    remainingUsd = cap.remaining_usd;
    if (!cap.allowed) {
      const blocked = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              JSON.stringify({
                type: 'gen_error',
                message: `Budget reached — $${cap.spent_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)} spent. Raise your budget to keep generating.`,
              }) + '\n',
            ),
          );
          c.close();
        },
      });
      return new Response(blocked, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
  } catch (err) {
    console.warn('[video-agent] cap check failed, continuing:', err);
  }

  // Ensure a thread so the work is never orphaned.
  const now = Date.now();
  let threadId = (body.thread_id ?? '').trim();
  try {
    const existing = threadId ? await db.get('thread', threadId) : null;
    if (!existing) {
      threadId = threadId || newId('thread');
      await db.put({
        id: threadId,
        user_id: userId,
        category: 'thread',
        status: 'active',
        created_at: now,
        updated_at: now,
        title: goal.slice(0, 40),
      } as Thread);
    }
  } catch (err) {
    console.warn('[video-agent] thread ensure failed:', err);
    threadId = threadId || newId('thread');
  }

  const interactionId = newId('interaction');

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      let agentText = '';
      let inTok = 0;
      let outTok = 0;
      let genCost = 0;
      let block: unknown = null;

      try {
        for await (const ev of runVideoAgent(
          { goal, subject: goal, budgetUsd: remainingUsd },
          { userMessage: prompt, renderPrompt: renderPrompt || undefined, shot: body.shot },
        ) as AsyncGenerator<VideoAgentEvent>) {
          if (ev.type === 'agent_text') agentText += ev.delta;
          else if (ev.type === 'agent_usage') {
            inTok += ev.inputTokens;
            outTok += ev.outputTokens;
          } else if (ev.type === 'agent_a2ui') block = ev.block;
          else if (ev.type === 'gen_done') genCost += ev.costUsd;
          send(ev);
        }
      } catch (err) {
        send({ type: 'gen_error', message: err instanceof Error ? err.message : 'The video agent failed.' });
      }

      // Persist + meter. Generation spend counts toward the cap exactly like image spend, so a video
      // run cannot slip past a budget that images respect.
      try {
        await db.put({
          id: interactionId,
          user_id: userId,
          category: 'interaction',
          status: 'active',
          created_at: now,
          updated_at: Date.now(),
          thread_id: threadId,
          model: 'video-agent',
          prompt: { text: goal },
          response: { text: agentText, tokens_used: outTok, a2ui: block, a2ui_version: 1 },
        } as unknown as Interaction);
        await recordUsage(db, {
          user_id: userId,
          interaction_id: interactionId,
          input_tokens: inTok,
          output_tokens: outTok,
          gen_cost_usd: genCost,
        });
        await db.update('thread', threadId, {});
      } catch (err) {
        console.warn('[video-agent] persist failed:', err);
      }

      send({ type: 'done', thread_id: threadId });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
