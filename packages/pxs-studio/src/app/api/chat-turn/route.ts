import Anthropic from '@anthropic-ai/sdk';
import {
  OPERATOR_SYSTEM,
  DECIDE_TOOL,
  parseClassifyResult,
  STUB_SUGGESTIONS,
} from '../../../lib/chat-classify';
import { runImageAgent, type FanConfigInput } from '../../../lib/agents/image-agent';
import { operatorSkills } from '../../../lib/agents/skills';
import type { EpistemicFrame } from '../../../lib/agents/epistemic-frame';
import {
  A2UI_VERSION,
  checkCap,
  costUsd,
  createLivingContext,
  DEV_USER_ID,
  getDb,
  recordUsage,
  type Asset,
  type Interaction,
  type Thread,
  draftBirthFields,
  promoteThreadForAsset,
} from '../../../lib/db';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * THE OPERATOR TURN — the front-door OODA loop.
 *
 * Mirrors api/generate-art's SSE structure (nodejs runtime, NDJSON ReadableStream, env-key check).
 * ONE Operator call per turn (claude-opus-4-8, adaptive thinking + the `decide` tool):
 *   1) stream the hospitable OPENER as text, and in the SAME call the model emits its OODA verdict
 *      as the `decide` tool call (Observe → Orient on the deliverable → Decide ONE sized action) —
 *      so the opener reflects the decision. No separate classify pass.
 *   2) ACT on the verdict. The Operator has NO generation path — it never renders; it hands off:
 *        transfer  → emit {transfer,frame} (nav flip) + run the IMAGE AGENT, which does ALL
 *                    generation. depth 'quick' → agent renders immediately; 'guided' → consult-first.
 *        propose   → emit an A2UI options block of workflow paths (no spend)
 *        ask       → emit the A2UI question block (never prose)
 *        reply     → contextual quick-pick suggestions
 *      then persist + `done`.
 *
 * The Operator chooses the medium itself — no tool/medium picker. STUB_SUGGESTIONS is the fallback
 * if the verdict is missing/invalid.
 *
 * SPEND: metered end-to-end — the ONE Operator call's tokens + realized image cost ALL hit
 * recordUsage, gated against the user's remaining hard cap. `remainingUsd` is reduced by the
 * Operator call's cost BEFORE image generation (per-turn tightening; see below).
 *
 * Event contract (NDJSON, one per line): status · step(reading/choosing) · text · transfer ·
 * gen_start · image · gen_done · gen_error · a2ui · suggestions · done | error.
 */

const MODEL = 'claude-opus-4-8';

interface HistoryMsg {
  role: 'user' | 'assistant';
  content: string;
}

type Send = (obj: unknown) => void;

/** Generate an addressable id for a persisted record. */
function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * transfer.to matrix — which specialist the nav flips to (the Operator's call, from medium + section).
 * A video scene from the Chat section still routes to the IMAGE agent first (it needs reference
 * images). Only the Video section with a video medium goes to the Video agent (not built yet).
 *   chat/image · any → image   |   image · any → image   |   video · video → video   |   video · image → image
 */
function transferTarget(medium: 'image' | 'video', section: string): 'image' | 'video' {
  return section === 'video' && medium === 'video' ? 'video' : 'image';
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY is not set. Add it to packages/pxs-studio/.env.local' },
      { status: 500 }
    );
  }

  let body: {
    prompt?: string;
    history?: HistoryMsg[];
    thread_id?: string;
    user_id?: string;
    section?: string;
    references?: string[];
    reference_asset_ids?: (string | null)[];
    fan?: FanConfigInput;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt = (body.prompt ?? '').trim();
  // The entry nav SECTION sets the Operator's prior (chat = broad · image/video = assume medium).
  const section = ((body.section ?? 'chat').trim() || 'chat').toLowerCase();
  if (!prompt) return Response.json({ error: 'prompt is required' }, { status: 400 });

  // ── PR-3 persistence wiring (memory-first / DB-async; never breaks the stream) ──
  const userId = (body.user_id ?? '').trim() || DEV_USER_ID;
  const db = await getDb();
  const living = createLivingContext(db);

  // Carry prior turns so follow-ups are coherent. Keep only valid alternating text turns.
  const history: HistoryMsg[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (m): m is HistoryMsg =>
            !!m &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content.trim().length > 0
        )
        .slice(-20)
    : [];

  // ── HARD SPEND GATE ──────────────────────────────────────────────────────────
  // Check the user's running total vs their hard cap BEFORE any model call. If they're
  // over, emit an error and close the stream WITHOUT spending a token. This is the gate.
  // `remainingUsd` is threaded into image generation so a single turn can't blow the cap.
  let remainingUsd = 2.0; // conservative per-request default if the cap check can't run
  try {
    const cap = await checkCap(db, userId);
    remainingUsd = cap.remaining_usd;
    if (!cap.allowed) {
      const encoder = new TextEncoder();
      const blocked = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: 'error', message: 'Usage cap reached' }) + '\n')
          );
          controller.close();
        },
      });
      return new Response(blocked, {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  } catch (err) {
    // Cap check failure must not block chat (persistence is best-effort) — log + continue.
    console.warn('[chat-turn] cap check failed, continuing:', err);
  }

  // Ensure a Thread exists (create if missing/not found; title = first ~40 chars of the prompt),
  // then insert the Interaction as `active` via the living-context append (memory-first, async).
  const now = Date.now();
  let threadId = (body.thread_id ?? '').trim();
  try {
    const existing = threadId ? await db.get('thread', threadId) : null;
    if (!existing) {
      threadId = threadId || newId('thread');
      const thread: Thread = {
        id: threadId,
        user_id: userId,
        category: 'thread',
        status: 'active',
        created_at: now,
        updated_at: now,
        title: prompt.slice(0, 40),
        // Born a DRAFT — persists so work is never lost, but ephemeral until it produces an asset.
        ...draftBirthFields(now),
      };
      await db.put(thread);
    }
  } catch (err) {
    console.warn('[chat-turn] thread ensure failed:', err);
    threadId = threadId || newId('thread');
  }

  const interactionId = newId('interaction');
  const interaction: Interaction = {
    id: interactionId,
    user_id: userId,
    category: 'interaction',
    status: 'active',
    created_at: now,
    updated_at: now,
    thread_id: threadId,
    model: MODEL,
    prompt: { text: prompt },
    response: { text: '', tokens_used: 0, a2ui: null, a2ui_version: A2UI_VERSION },
  };
  // Memory-first append — don't block the stream on the DB write.
  living.append(interaction);

  // The user's attached references at the FRONT DOOR — the Operator carries everything the user brought.
  // Persist each NEW upload as an ephemeral upload asset on this turn (source 'upload'), so it rides
  // along when the Operator transfers to the specialist AND rehydrates as the turn's userImages on
  // reload. @-mentioned refs (already saved assets → have an id) are skipped: link, don't duplicate.
  // Uploads do NOT promote the draft (only a GENERATED asset does — matches the image-agent path).
  const references = Array.isArray(body.references)
    ? body.references.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [];
  const referenceAssetIds = Array.isArray(body.reference_asset_ids) ? body.reference_asset_ids : [];
  for (let i = 0; i < references.length; i++) {
    if (referenceAssetIds[i]) continue; // existing saved asset — no duplicate row
    await db
      .put<Asset>({
        id: newId('asset'),
        user_id: userId,
        category: 'asset',
        status: 'active',
        created_at: now,
        updated_at: now,
        kind: 'image',
        source: 'upload',
        retention: 'ephemeral',
        thread_id: threadId,
        interaction_id: interactionId,
        url: references[i],
        index: i,
      })
      .catch(() => {});
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send: Send = (obj) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));

      // NOTE: the Operator has NO generation path of its own — there is deliberately no runImageGen
      // here. Generation happens ONLY inside the image agent, which the Operator hands a scoped frame
      // to via `transfer`. The Operator cannot hold the generate trigger (not even for "a quick one").

      // Accumulate the assistant text + the a2ui snapshot so we can persist after `done`.
      let assistantText = '';
      // Guard so the first text delta marks the 'reading' step done exactly once.
      let firstToken = false;

      try {
        // 1) Loading/thinking status — emitted immediately so the UI can show a spinner.
        send({ type: 'status', phase: 'thinking', message: 'Thinking…' });
        // Honest phase 1: reading/generating — starts now, completes on the first text delta.
        send({ type: 'step', id: 'reading', label: 'Reading your request…', status: 'start' });

        // 2) ONE Operator call: stream the hospitable OPENER (text), then the model calls the
        //    `decide` tool with its OODA verdict — so the opener reflects the decision (Orient +
        //    Decide + speak in one pass). No separate classify call.
        const messages: Anthropic.MessageParam[] = [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content: prompt },
        ];

        // `as any` at the call site (the SDK's request types lag adaptive thinking).
        // Thin role prompt + the ONLY relevant skill shards for this turn (Context Sharding —
        // the Operator's craft is loaded on Orient, not baked into one bloated prompt).
        const operatorSystem =
          `${OPERATOR_SYSTEM}\n\nEntry section: "${section}".` +
          operatorSkills({ section, text: prompt });
        const params = {
          model: MODEL,
          max_tokens: 2048,
          thinking: { type: 'adaptive', display: 'summarized' },
          system: operatorSystem,
          tools: [DECIDE_TOOL],
          messages,
        };
        const llmStream = client.messages.stream(params as any);

        for await (const event of llmStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text
          ) {
            if (!firstToken) {
              firstToken = true;
              send({ type: 'step', id: 'reading', status: 'done' });
            }
            assistantText += event.delta.text;
            send({ type: 'text', delta: event.delta.text });
          }
        }
        const finalMessage = await llmStream.finalMessage();
        // Close the reading step even if the model went straight to the tool call (no opener text).
        if (!firstToken) send({ type: 'step', id: 'reading', status: 'done' });

        // Per-turn cap tightening: subtract THIS Operator call's cost from the remaining budget
        // BEFORE any image generation, so Opus + images can't stack past the cap within one turn.
        remainingUsd = Math.max(
          0,
          remainingUsd - costUsd(finalMessage?.usage?.input_tokens ?? 0, finalMessage?.usage?.output_tokens ?? 0)
        );

        // Phase 2: the Operator's verdict = the `decide` tool call it just emitted.
        send({ type: 'step', id: 'choosing', label: 'Choosing your next steps…', status: 'start' });

        let suggestionsToSend: string[] = STUB_SUGGESTIONS;
        // The A2UI block actually emitted (persisted for truthful hydrate). Question | options | null.
        let emittedBlock:
          | { kind: 'question'; label: string; placeholder?: string; chips?: string[] }
          | { kind: 'options'; title: string; select: 'single'; options: { id: string; label: string; detail?: string }[] }
          | { kind: 'references'; modelLabel: string; maxReferences: number; supports: string[]; recommend: string[]; note?: string }
          | { kind: 'builder'; surface?: 'canvas'; title: string; media: 'image' | 'video' | 'pixel' | 'anim'; parts: { id: string; label: string; guidance: string; value: string; recommend?: string; chips: string[]; weight?: number }[]; modelId?: string; assembly?: string; model?: { label: string; maxReferences: number; supports: string[] } }
          | null = null;
        let didRespond = false;
        let genCostTotal = 0; // realized image spend, metered against the cap
        let agentInTok = 0; // the Image agent's own brain tokens (transfer path), metered too
        let agentOutTok = 0;
        // Generated tiles from a 'quick' transfer render — persisted as assets (Slice 1).
        const generatedImages: { url: string; modelLabel: string; index: number }[] = [];

        try {
          // The verdict is the `decide` tool call from the ONE Operator stream above.
          const toolUse = ((finalMessage?.content ?? []) as Array<{ type: string; name?: string; input?: unknown }>)
            .find((b) => b.type === 'tool_use' && b.name === 'decide');
          if (!toolUse) throw new Error('Operator emitted no decide verdict');
          const result = parseClassifyResult(JSON.stringify(toolUse.input ?? {}));
          send({ type: 'step', id: 'choosing', status: 'done' });

          // INTENT-DRIVEN TRANSFER (never auto-render): setting the medium to Image/Video means "take me
          // to the specialist for this" — so we ALWAYS transfer to it, but land GUIDED: the specialist
          // opens the Prompt Builder in the IDE, confirms the prompt + references WITH the user, and does
          // NOT spend on a render. Rendering is an explicit act in the workspace (the Render button, or an
          // explicit "generate these" follow-up). Brian's line: "I wouldn't expect images generated there
          // [the chat] — the image model should work with me unless I literally say create me these."
          if ((section === 'image' || section === 'video') && prompt.trim().length > 0) {
            result.action = 'transfer';
            result.frame = {
              goal: result.frame?.goal || prompt.slice(0, 200),
              subject: result.frame?.subject,
              medium: section === 'video' ? 'video' : 'image',
              depth: 'guided',
            };
          }

          if (result.action === 'propose' && result.proposal) {
            // PROPOSE: oriented, but a real fork in HOW to do it well → present WORKFLOW PATHS as an
            // A2UI options block. SPENDS NOTHING. The user's pick returns as their next turn, which
            // the Operator then sizes into a transfer. This is the anti-"blowing your load" valve.
            didRespond = true;
            emittedBlock = {
              kind: 'options',
              title: result.proposal.title,
              select: 'single',
              options: result.proposal.options,
            };
            send({ type: 'a2ui', block: emittedBlock });
          } else if (result.action === 'transfer' && result.frame) {
            // TRANSFER: the Operator hands an Epistemic Frame ONLY (no image specs) to the IMAGE
            // AGENT, which owns the prompt + routing and does ALL generation. Nav flips per the
            // transfer.to matrix. `depth` is the Operator's scope hint:
            //   • 'quick'  → the user wants it fast (incl. "any / I don't care") → pass their message
            //     as the agent's instruction so it renders IMMEDIATELY (followUp leg), deciding open
            //     details itself. Still the AGENT generating — the Operator never does.
            //   • 'guided'/unset → consult-first: the agent recommends references, renders on commit.
            didRespond = true;
            const medium = result.frame.medium ?? 'image';
            const to = transferTarget(medium, section);
            const frame: EpistemicFrame = {
              goal: result.frame.goal,
              subject: result.frame.subject,
              medium,
              section,
              budgetUsd: remainingUsd,
              count: 2,
            };
            // Send a trimmed frame to the client (no budget); nav flips to `to`.
            send({ type: 'transfer', to, frame: { goal: frame.goal, subject: frame.subject, medium } });
            // Carry the front-door REFERENCES + the picker's fan CONFIG into the specialist — without
            // these the agent generated blind (ignoring the user's photo + model/aspect choices), which
            // is exactly why results looked nothing like the reference. `quick` renders now; `guided`
            // opens the builder — both get the refs + config.
            const agentTurn = {
              userMessage: result.frame.depth === 'quick' ? prompt : undefined,
              references: references.length > 0 ? references : undefined,
              fan: body.fan,
            };
            for await (const ev of runImageAgent(frame, agentTurn)) {
              if (ev.type === 'agent_usage') {
                agentInTok += ev.inputTokens;
                agentOutTok += ev.outputTokens;
              } else if (ev.type === 'gen_done') {
                genCostTotal = ev.costUsd;
                send(ev);
              } else if (ev.type === 'agent_a2ui') {
                // The Image agent's grounded reference recommendation (Model-agent capability truth).
                // Forward as an a2ui block + persist it so a reload rehydrates the recommendation.
                emittedBlock = ev.block;
                send({ type: 'a2ui', block: ev.block });
              } else if (ev.type === 'gen_notice') {
                send({ type: 'notice', message: ev.message });
              } else if (ev.type === 'image') {
                generatedImages.push({ url: ev.url, modelLabel: ev.modelLabel, index: ev.index });
                send(ev);
              } else {
                send(ev); // agent_start · agent_text · step · gen_error
              }
            }
          } else if (result.action === 'ask' && result.question) {
            // ASK — render the Operator's OWN question (only when it genuinely can't tell the
            // deliverable). NO code gate forces a staged question; if the verdict has no valid
            // question it falls through to reply. The CONTEXT (Operator prompt) drives the decision.
            didRespond = true;
            emittedBlock = { kind: 'question', label: result.question.label, placeholder: result.question.placeholder, chips: result.question.chips };
            send({ type: 'a2ui', block: emittedBlock });
          } else {
            // REPLY — the Operator's suggestions (or stubs). The route EXECUTES the verdict; it never
            // injects a staged question of its own.
            didRespond = true;
            suggestionsToSend = result.suggestions.length > 0 ? result.suggestions : STUB_SUGGESTIONS;
            send({ type: 'suggestions', items: suggestionsToSend });
          }
        } catch (verdictErr) {
          // No/invalid verdict → the streamed opener stands as a plain reply; add stub quick-picks.
          console.warn('[chat-turn] no/invalid Operator verdict, falling back:', verdictErr);
          send({ type: 'step', id: 'choosing', status: 'done' });
          if (!didRespond) send({ type: 'suggestions', items: STUB_SUGGESTIONS });
        }

        // ── PERSIST THE COMPLETED TURN (best-effort; never breaks the stream) ──
        // Update the interaction's response + record usage. Any failure only warns.
        try {
          const usage = finalMessage?.usage;
          const inputTokens = usage?.input_tokens ?? 0;
          // TODO: adaptive thinking may split output across fields; input/output_tokens is the
          // best available signal from the current SDK. Estimate 0 if usage is absent.
          const outputTokens = usage?.output_tokens ?? 0;

          // Attribute tokens to their side of the exchange: INPUT tokens belong to the prompt,
          // OUTPUT tokens to the response. recordUsage still meters both (no double-count).
          await db.update('interaction', interactionId, {
            prompt: { text: prompt, tokens: inputTokens },
            response: {
              text: assistantText,
              tokens_used: outputTokens,
              // Persist the A2UI block actually emitted (the question/builder, or null).
              a2ui: emittedBlock,
              a2ui_version: A2UI_VERSION,
            },
          } as Partial<Interaction>);
          // Meter EVERYTHING this turn spent: the Operator call + the Image agent's brain (transfer
          // path) + the realized image-generation cost — so the hard cap gates real spend.
          await recordUsage(db, {
            user_id: userId,
            interaction_id: interactionId,
            input_tokens: inputTokens + agentInTok,
            output_tokens: outputTokens + agentOutTok,
            gen_cost_usd: genCostTotal,
          });
          // Bump the thread's updated_at so the project rises to the top of the Projects list.
          await db.update('thread', threadId, {});
          // Persist any 'quick'-transfer generated tiles as in-state GENERATED assets (Slice 1/2) → reload.
          const share = generatedImages.length > 0 ? genCostTotal / generatedImages.length : 0;
          for (const img of generatedImages) {
            const asset: Asset = {
              id: newId('asset'),
              user_id: userId,
              category: 'asset',
              status: 'active',
              created_at: now,
              updated_at: now,
              kind: 'image',
              source: 'generated',
              retention: 'ephemeral',
              thread_id: threadId,
              interaction_id: interactionId,
              url: img.url,
              model_label: img.modelLabel || undefined,
              index: img.index,
              prompt,
              gen_cost_usd: share || undefined,
            };
            await db.put(asset);
          }
          // First asset promotes the draft project → saved (auto, no save button; §4).
          if (generatedImages.length > 0) await promoteThreadForAsset(db, threadId, now);
        } catch (err) {
          console.warn('[chat-turn] persist/usage failed (stream unaffected):', err);
        }

        // Emit the addressable ids so the client can edit/delete the turn later.
        send({ type: 'done', thread_id: threadId, interaction_id: interactionId });
        controller.close();
      } catch (err) {
        const message =
          err instanceof Anthropic.APIError
            ? `Claude API error ${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Unknown error';
        send({ type: 'error', message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
