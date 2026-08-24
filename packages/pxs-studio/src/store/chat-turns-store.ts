'use client';

import { create } from 'zustand';
import { DEV_USER_ID } from '../lib/db/models';
import type { Asset, Interaction } from '../lib/db/models';
import type { ThinkingStep } from '../components/chat/ThinkingIndicator';
import type { Source } from '../components/chat/SourcesRow';

/** localStorage key holding the active thread id so a reload can restore the conversation. */
export const THREAD_STORAGE_KEY = 'pxs-chat-thread';

/** localStorage key for the fan-out picker config, so the user's models/count/images/aspect choices
 *  survive a reload (they were resetting to the default every refresh — the '1/ea' bug). */
const FAN_CONFIG_KEY = 'pxs-fan-config';
const FAN_CONFIG_DEFAULT: FanConfig = { mode: 'auto', models: [], fanModels: 3, perModel: 1 };

function loadFanConfig(): FanConfig {
  if (typeof window === 'undefined') return { ...FAN_CONFIG_DEFAULT };
  try {
    const raw = window.localStorage.getItem(FAN_CONFIG_KEY);
    if (!raw) return { ...FAN_CONFIG_DEFAULT };
    const p = JSON.parse(raw) as Partial<FanConfig>;
    return {
      mode: p.mode === 'manual' ? 'manual' : 'auto',
      models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string') : [],
      fanModels: typeof p.fanModels === 'number' ? Math.max(1, p.fanModels) : 3,
      perModel: typeof p.perModel === 'number' ? Math.max(1, p.perModel) : 1,
      aspect: typeof p.aspect === 'string' ? p.aspect : undefined,
    };
  } catch { return { ...FAN_CONFIG_DEFAULT }; }
}

function saveFanConfig(cfg: FanConfig): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(FAN_CONFIG_KEY, JSON.stringify(cfg)); } catch { /* quota/private mode — non-fatal */ }
}

/**
 * THE CHAT TURNS STORE — the Operator front door's view-model.
 *
 * `send(prompt)` POSTs to /api/chat-turn (with the entry `section`), reads the NDJSON stream
 * (reader.read() + TextDecoder + '\n'-split + JSON.parse), and reduces the events into a ChatTurn
 * view-model. It holds an ARRAY of turns so the conversation is continuous — each `send` appends a
 * new turn (carrying prior turns as history). The Operator never generates; it TRANSFERS to the
 * image agent, whose tiles stream in as `image` events; a `transfer` flips `activeMedium` (the nav).
 */

/**
 * SLOTS-NOT-SCREENS. Every A2UI block carries an optional `surface` naming the dumb code-owned
 * region it belongs in: 'chat' → inline in the conversation scroll; 'controls' → lifted to the
 * workspace's dedicated Prompt Guide panel (persistent, out of the scroll). The agent owns the
 * tag; the code owns the regions and routes by it. Absent → derived by kind (see `a2uiSurface`).
 */
export type A2UISurface = 'chat' | 'controls' | 'canvas';

/** A stacked options block (radio/checkbox). */
export interface A2UIOptionsBlock {
  kind: 'options';
  /** Region this block routes to. Defaults to 'chat' (a conversational choice). */
  surface?: A2UISurface;
  title: string;
  /** 'single' → stacked radio group (pick one, submits on select); 'multiple' → stacked
   *  checkboxes + a Continue button. Defaults to 'single' when absent. */
  select?: 'single' | 'multiple';
  /** Each option is a WORKFLOW PATH (from a `propose` verdict), not a tool/model name. `detail`
   *  is a one-line description shown under the label. */
  options: { id: string; label: string; detail?: string }[];
}

/** An agent QUESTION — the ONLY way an agent asks for more. A formatted question with its own
 *  freeform text-area field (the composer stays the user's own prompt line), plus optional
 *  tappable quick-pick chips. Answering it (typing + submit, or a chip) continues the turn. */
export interface A2UIQuestionBlock {
  kind: 'question';
  /** Region this block routes to. Defaults to 'chat' (a conversational ask). */
  surface?: A2UISurface;
  /** The question, e.g. "Which era and scene are you picturing?" */
  label: string;
  /** Text-area placeholder, e.g. "Describe the vibe…" */
  placeholder?: string;
  /** Optional quick-pick answers the user can tap instead of typing. */
  chips?: string[];
}

/** A reference-recommendation block — the Image agent's grounded capability response: what the
 *  chosen model actually supports (from the Model agent) + which references to attach next. */
export interface A2UIReferencesBlock {
  kind: 'references';
  /** Region this block routes to. Defaults to 'controls' — the Prompt Guide, not the chat scroll. */
  surface?: A2UISurface;
  /** The model whose limits these are (e.g. "Nano Banana (Gemini 2.5 Flash Image)"). */
  modelLabel: string;
  /** How many reference images the model accepts (the fact, not a guess). */
  maxReferences: number;
  /** Capability highlights the user may not have known (e.g. "style-transfer variants", "editing"). */
  supports: string[];
  /** Recommended reference types to attach for a precise result. */
  recommend: string[];
  /** One-line framing. */
  note?: string;
}

/** One part of the prompt FORMULA in a builder block (PR-10a). Every field is AGENT-emitted —
 *  the code never bakes parts, chips, or values. `chips` are SUGGESTED anchors (tap to add); the
 *  user can always free-type more (never a cage). */
export interface BuilderPart {
  /** Stable id — 'subject' | 'action' | 'context' | 'composition' | 'style' | agent-defined. */
  id: string;
  label: string;
  /** One line: what this part is for (structural guidance, e.g. "the main focal point"). */
  guidance: string;
  /** The part's REAL content — ONLY what the USER actually specified (iteration zero). Empty if the
   *  user didn't mention this part. Never the agent's invention (that's `recommend`). User-editable. */
  value: string;
  /** The agent's SUGGESTED improvement for this part — shown as the field PLACEHOLDER (a
   *  recommendation, never auto-counted into the prompt). The user types their own or taps a chip. */
  recommend?: string;
  /** Agent-SUGGESTED chips (tap to APPEND to the value). Never a code table. */
  chips: string[];
  /** This part's weight in the target model's FORMULA — drives the honest, weighted score (PR-10c).
   *  From the model's `promptFormula`; defaults to 1 when absent. */
  weight?: number;
}

/** The STRUCTURED CONSULT (PR-10a) — the Prompt Builder the center stage renders. The agent breaks
 *  the brief into the formula parts + folds in the chosen model's reference facts; the user shapes it
 *  (suggested + free-form) and hits Render. Media-agnostic: `media` drives which parts the agent emits. */
export interface A2UIBuilderBlock {
  kind: 'builder';
  /** Routes to the center stage. Defaults to 'canvas'. */
  surface?: A2UISurface;
  /** e.g. "Shaping · Third-gen Camaro on a rural backroad". */
  title: string;
  media: 'image' | 'video' | 'pixel' | 'anim';
  parts: BuilderPart[];
  /** The target model driving this formula (id + label). The formula/parts/weights are ITS documented
   *  shape — different model → different parts/weights (PR-10c). */
  modelId?: string;
  /** One line on how this model wants the prompt assembled (order/format) — surfaced in the Guide. */
  assembly?: string;
  /** The chosen model's reference facts, folded in as the References section (PR-10a; the standalone
   *  Prompt Guide panel returns in PR-10d). */
  model?: { label: string; maxReferences: number; supports: string[] };
}

/** Any A2UI block a turn can carry. */
export type A2UIBlock = A2UIOptionsBlock | A2UIQuestionBlock | A2UIReferencesBlock | A2UIBuilderBlock;

/**
 * The block router (slots-not-screens): which region a block belongs in. An explicit `surface`
 * always wins; otherwise it's derived by kind — the references/model card is a Prompt-Guide
 * ('controls') block, everything conversational stays inline ('chat'). One source of truth so the
 * renderer (inline in MessageTurn) and the panel (ChatView) never disagree about where a block goes.
 */
export function a2uiSurface(block: A2UIBlock): A2UISurface {
  if (block.surface) return block.surface;
  if (block.kind === 'builder') return 'canvas'; // the center Prompt Builder
  if (block.kind === 'references') return 'controls'; // the Prompt Guide panel
  return 'chat';
}

/** One generated image tile streamed into the turn (the dispatched image workflow's output). */
export interface GalleryImage {
  url: string;
  /** Registry model id — pairs the tile with its fan entry (label is display-only). */
  modelId?: string;
  modelLabel: string;
  index: number;
  /** The fan-out fit score the model was picked by (higher = better fit for this request). */
  score?: number;
}

/**
 * One model's LIVE status inside a fan-out render — the client's view of the per-model lifecycle
 * (`gen_plan` seeds it; `fan_model` + `image` events advance it). 'pending' = planned, API call not
 * yet dispatched; 'running' = the adapter is on the wire; 'done'/'failed' = settled. A failed model
 * NEVER fails the turn — the rest of the fan keeps streaming (graceful specialist).
 */
export interface FanModelStatus {
  modelId: string;
  label: string;
  /** Images this model was asked for. */
  n: number;
  /** Images landed so far (== n when done). */
  delivered: number;
  state: 'pending' | 'running' | 'done' | 'failed';
  /** Failure reason (adapter taxonomy or message) — only on 'failed'. */
  reason?: string;
  /** The selection rationale this model was picked by. */
  why?: string;
  /** Wall-clock ms from dispatch to settle — set on 'done'. */
  ms?: number;
}

export type ChatTurnStatus = 'thinking' | 'streaming' | 'done' | 'error';

export interface ChatTurn {
  id: string;
  userPrompt: string;
  /** Reference images the user attached to this turn (data URLs) — shown on the user bubble. */
  userImages?: string[];
  status: ChatTurnStatus;
  statusMessage: string;
  text: string;
  /** Honest backend phase steps for the thinking reel — fed by `step` SSE events (keyed by id). */
  steps: ThinkingStep[];
  a2ui: A2UIBlock | null;
  suggestions: string[];
  /** Images generated by a dispatched workflow, streamed in as tiles. */
  images: GalleryImage[];
  /** True while a dispatched image workflow is generating (drives the gallery loading state). */
  generating?: boolean;
  /** The fan's per-model status — seeded by `gen_plan` the instant routing resolves (ALL N models
   *  paint at once) and advanced live by `fan_model` + `image` events. NOT cleared on gen_done: the
   *  settled fan is the run's record (the status panel), and it rehydrates from the persisted
   *  interaction on reload. Plan order = the agent's ranking. */
  fan?: FanModelStatus[];
  /** Gentle non-blocking notices from the coordinator (best-effort shortfalls) — shown muted. */
  notices?: string[];
  /** Set when the Operator TRANSFERRED this turn to a specialist (large workflow) — attributes the
   *  work to the Image/Video agent and drove the nav flip. */
  transferredTo?: 'image' | 'video';
  /** The specialist agent's own opener (streamed after a transfer) — the Image agent speaking. */
  agentText?: string;
  /** Grounded citations for the turn (web / model / data). The SourcesRow renders these as
   *  chips. Populated by the coordinator (P4) + rehydrated from a persisted response; the P1
   *  chat path leaves it empty (no live sources event yet). */
  sources: Source[];
  error?: string;
  createdAt: number;
  /** Wall-clock time (ms) from `createdAt` to the `done` event — surfaced in the message footer. */
  durationMs?: number;
  /** The persisted Interaction id this turn maps to — captured from the `done` event (streaming)
   *  or from the Interaction on `loadThread`. Present once the turn is stored; drives delete. */
  interactionId?: string;
}

/** How the next render fans out — edited by the picker/composer, read by the render request. */
export interface FanConfig {
  mode: 'auto' | 'manual';
  /** Manual mode: the model ids to fan across. */
  models: string[];
  /** Auto mode: how many models the agent fans across (top-N). */
  fanModels: number;
  /** Images per model. */
  perModel: number;
  /** Render aspect (e.g. "16:9") — also the reference aspect-fit target. Undefined = let the model decide. */
  aspect?: string;
}

interface ChatTurnsState {
  turns: ChatTurn[];
  /** The active thread id — captured from the `done` event, persisted to localStorage. */
  threadId: string | null;
  /** The active project's display TITLE — so the shell can always show WHICH project you're in
   *  (a project you can't name is a project you can't trust). Set when a project is opened; the
   *  shell falls back to the first user prompt for a brand-new, not-yet-titled project. */
  threadTitle: string | null;
  /** The active workflow medium — flips to 'image'/'video' when the Operator TRANSFERS,
   *  driving the left-nav highlight (and, in Slice 2, the Image IDE surface). */
  activeMedium: 'chat' | 'image' | 'video';
  /** The active workflow's Epistemic Frame — captured on transfer. While set + in a workspace,
   *  follow-up turns go STRAIGHT to the Image agent (Option A), not back through the Operator. */
  activeFrame: { goal: string; subject?: string; medium: 'image' | 'video' } | null;
  /** SHARED view lens for a creative section — the split [Chat | IDE] pill. 'chat' = the conversation
   *  (default; an empty section reads as an invitation to talk); 'ide' = the working surface (Image's
   *  three-panel, Video's storyboard). CRITICAL CONTRACT: this is a SHARED, EPHEMERAL signal written by
   *  BOTH the user (the pill) and the agent (flips to 'ide' when it produces work — the transfer). It is
   *  NEVER read as permission — the agent always acts and sets it, never "checks what the user clicked".
   *  It is NOT durable project data: flipping the lens can't touch the persisted turns/frame/assets. */
  viewMode: 'chat' | 'ide';
  /** How the NEXT render fans out (the picker + composer config edit this). 'auto' = the Model agent
   *  picks the top-N; 'manual' = fan across exactly `models`. `perModel` = images each. Shared so the
   *  picker, the composer, and the Render button all read/write one source. */
  fanConfig: FanConfig;
  /** SHARED builder part values — the single source for the Build panel AND the center prompt
   *  (two-way binding), AND what the Agent writes to via `part_edit` (the COUPLING). Keyed by part id. */
  partValues: Record<string, string>;
  /** Which builder turn `partValues` is seeded for (re-seed only on a NEW builder). */
  partSeedTurn: string | null;
  /** The Agent's most recent part edit — drives the Build panel highlight/ring animation. `n` bumps
   *  every edit so re-editing the same part re-triggers the flash. */
  lastEdit: { id: string; n: number } | null;
  /** Set/edit a part value (user typing, chip tap, or an agent `part_edit`). */
  setPartValue: (id: string, value: string, fromAgent?: boolean) => void;
  /** Seed the shared values from a new builder's iteration-zero (no-op if already seeded for it). */
  seedBuilder: (turnId: string, seed: Record<string, string>) => void;
  /** Send a prompt — appends a new turn and streams its response. Returns the new turn id.
   *  `references` ride along to the Image agent in a workspace. `builder` (the current parts + values)
   *  turns a workspace message into a COLLABORATION — the agent can edit the parts, not just render. */
  send: (
    prompt: string,
    references?: string[],
    builder?: { parts: { id: string; label: string; value: string }[] },
    /** Aligned with `references` by index — the saved-asset id for @-mentioned refs (null = a new
     *  upload). Lets the generation link lineage to the REAL asset instead of a duplicate. */
    referenceAssetIds?: (string | null)[]
  ) => string;
  /** Restore a persisted conversation from the SQLite store (reload/reopen hydration). */
  loadThread: (threadId: string) => Promise<void>;
  /** Soft-delete a persisted turn by its interaction id (audit-preserving; NO spend). */
  deleteTurn: (interactionId: string) => Promise<void>;
  /** Clear the whole conversation (turns + thread id + stored key). */
  reset: () => void;
  /** Switch the active workflow medium (drives the nav + the surface layout). */
  setActiveMedium: (medium: 'chat' | 'image' | 'video') => void;
  /** Set the shared Chat/IDE lens (see `viewMode`). Called by the pill AND by the agent transfer. */
  setViewMode: (mode: 'chat' | 'ide') => void;
  /** Update the fan-out config (the picker/composer). Partial merge. */
  setFanConfig: (patch: Partial<FanConfig>) => void;
  /** Name the active project (set when one is opened, so the shell can display it). */
  setThreadTitle: (title: string | null) => void;
  /** Enter a section from the primary NAV — the phone-menu hand-off. Selects the medium and DROPS
   *  any in-flight workflow frame (so you land back at the Operator's root for that section: "what
   *  do you want to do?"), while KEEPING the project state (turns + thread). Nav is "same project,
   *  back to the operator HERE" — it is NOT a reset, and it is NOT resuming a workspace mid-flight.
   *  A TRANSFER is the opposite move: it carries intent forward in flight (sets the frame). */
  enterSection: (medium: 'chat' | 'image' | 'video') => void;
}

export const useChatTurnsStore = create<ChatTurnsState>((set, get) => {
  const patch = (id: string, updates: Partial<ChatTurn>) =>
    set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...updates } : t)) }));

  async function run(
    id: string,
    prompt: string,
    references: string[] = [],
    builder?: { parts: { id: string; label: string; value: string }[] },
    referenceAssetIds?: (string | null)[]
  ) {
    // Carry the COMPLETED prior turns as history so follow-ups stay coherent. (The just-added
    // turn is excluded — its assistant text doesn't exist yet.) An image-agent turn's reply lives
    // in `agentText` (not `text`), so fall back to it for workspace coherence.
    const history = get()
      .turns.filter((t) => t.id !== id && t.status === 'done')
      .map((t) => ({ user: t.userPrompt, assistant: t.text.trim() || (t.agentText ?? '').trim() }))
      .filter((t) => t.assistant)
      .flatMap((t) => [
        { role: 'user' as const, content: t.user },
        { role: 'assistant' as const, content: t.assistant },
      ]);

    // Option A routing: while in a workspace WITH an active frame, follow-ups talk STRAIGHT to the
    // Image agent (no Operator re-diagnosis). Otherwise the Operator front door handles the turn.
    const st = get();
    const toImageAgent = st.activeMedium !== 'chat' && st.activeFrame != null;

    try {
      const res = await fetch(toImageAgent ? '/api/image-agent' : '/api/chat-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          toImageAgent
            ? {
                prompt,
                history,
                thread_id: st.threadId ?? undefined,
                frame: st.activeFrame,
                section: st.activeMedium,
                references, // attached reference images (data URLs) for the Image agent
                reference_asset_ids: referenceAssetIds, // aligned with references — existing saved-asset ids (lineage)
                builder, // present → COLLABORATION: the agent can edit the parts, not just render
                fan: st.fanConfig, // the picker/config: which models, how many, images each, aspect
              }
            : {
                prompt,
                history,
                thread_id: st.threadId ?? undefined,
                // The entry section sets the Operator's prior (chat / image / video).
                section: st.activeMedium,
                // The Operator carries EVERYTHING the user brought — attaching a reference at the front
                // door is context to transfer, never something to restrict. Persisted with the turn so
                // it rides along to the specialist on transfer + rehydrates on reload.
                references,
                reference_asset_ids: referenceAssetIds,
                // The composer's render config (models · images · aspect) rides along too — when the
                // intent is Image/Video the Operator hands it straight to the specialist, so a render
                // uses what you SET, not the default. Without this the fan silently fell back to 1.
                fan: st.fanConfig,
              }
        ),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        patch(id, { status: 'error', error: err.error || `HTTP ${res.status}`, statusMessage: '' });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === 'status') {
            patch(id, { statusMessage: evt.message || '' });
          } else if (evt.type === 'step') {
            // Honest phase steps feed the thinking reel. `start` pushes/activates a step keyed by
            // id (deduped); `done` flips that step to done. Unknown ids on `done` are ignored.
            const stepId: string | undefined =
              typeof evt.id === 'string' ? evt.id : undefined;
            set((s) => ({
              turns: s.turns.map((t) => {
                if (t.id !== id) return t;
                const steps = t.steps.slice();
                const idx = stepId != null ? steps.findIndex((st) => st.id === stepId) : -1;
                if (evt.status === 'start') {
                  // Stamp the start so `done` can record how long the step actually took — the
                  // per-step timing the kept reasoning record surfaces.
                  const next: ThinkingStep = {
                    id: stepId,
                    label: typeof evt.label === 'string' ? evt.label : '',
                    state: 'active',
                    startedAt: Date.now(),
                  };
                  if (idx >= 0) steps[idx] = { ...steps[idx], ...next };
                  else steps.push(next);
                } else if (evt.status === 'done' && idx >= 0) {
                  const startedAt = steps[idx].startedAt;
                  steps[idx] = {
                    ...steps[idx],
                    state: 'done',
                    ms: startedAt != null ? Date.now() - startedAt : steps[idx].ms,
                  };
                }
                return { ...t, steps };
              }),
            }));
          } else if (evt.type === 'text') {
            // First text delta flips the turn from 'thinking' to 'streaming'.
            set((s) => ({
              turns: s.turns.map((t) =>
                t.id === id
                  ? { ...t, status: 'streaming', text: t.text + (evt.delta || '') }
                  : t
              ),
            }));
          } else if (evt.type === 'a2ui') {
            patch(id, { a2ui: evt.block });
          } else if (evt.type === 'suggestions') {
            patch(id, { suggestions: Array.isArray(evt.items) ? evt.items : [] });
          } else if (evt.type === 'transfer') {
            // The Operator transferred to a specialist — flip the active medium (nav), capture the
            // Epistemic Frame (so workspace follow-ups go straight to the Image agent), + attribute
            // this turn to that agent.
            const to: 'image' | 'video' = evt.to === 'video' ? 'video' : 'image';
            const f = evt.frame && typeof evt.frame === 'object' ? evt.frame : {};
            const frame =
              typeof f.goal === 'string' && f.goal.trim()
                ? {
                    goal: f.goal.trim(),
                    subject: typeof f.subject === 'string' ? f.subject.trim() : undefined,
                    medium: to,
                  }
                : null;
            set({ activeMedium: to, ...(frame ? { activeFrame: frame } : {}) });
            patch(id, { transferredTo: to });
          } else if (evt.type === 'agent_start') {
            // The specialist agent (Image agent) began its leg. Do NOT flag `generating` here — that
            // belongs to actual image generation (gen_start), so the CONSULTATION leg (reference-first
            // hand-off) never shows a false "Generating…".
          } else if (evt.type === 'agent_text') {
            // Stream the specialist's opener into its own field (distinct from the Operator's). On a
            // dedicated image-agent turn there's no Operator `text`, so flip out of 'thinking' here
            // (otherwise the turn shows only the thinking reel until done).
            set((s) => ({
              turns: s.turns.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      status: t.status === 'thinking' ? 'streaming' : t.status,
                      agentText: (t.agentText ?? '') + (evt.delta || ''),
                    }
                  : t
              ),
            }));
          } else if (evt.type === 'gen_start') {
            patch(id, { generating: true });
          } else if (evt.type === 'gen_plan') {
            // Routing resolved — the fan is known. Seed one status entry per model (plan order =
            // the agent's ranking) so the stage paints ALL N model loaders now.
            const models = Array.isArray(evt.models) ? evt.models : [];
            patch(id, {
              generating: true,
              fan: models.map((m: { modelId?: string; label?: string; n?: number; why?: string }) => ({
                modelId: String(m.modelId ?? m.label ?? ''),
                label: String(m.label ?? m.modelId ?? 'Model'),
                n: Math.max(1, Number(m.n) || 1),
                delivered: 0,
                state: 'pending' as const,
                why: typeof m.why === 'string' && m.why ? m.why : undefined,
              })),
            });
          } else if (evt.type === 'fan_model') {
            // One model's lifecycle advanced (running → done | failed). PER-MODEL only: a failed
            // model never touches the turn's generating/error — the rest of the fan keeps streaming.
            set((s) => ({
              turns: s.turns.map((t) => {
                if (t.id !== id || !t.fan) return t;
                return {
                  ...t,
                  fan: t.fan.map((f) => {
                    if (f.modelId !== evt.modelId) return f;
                    if (evt.state === 'running') return { ...f, state: 'running' as const };
                    if (evt.state === 'done')
                      return {
                        ...f,
                        state: 'done' as const,
                        delivered: typeof evt.delivered === 'number' ? evt.delivered : f.delivered,
                        ms: typeof evt.ms === 'number' ? evt.ms : undefined,
                      };
                    if (evt.state === 'failed')
                      return { ...f, state: 'failed' as const, reason: typeof evt.reason === 'string' ? evt.reason : undefined };
                    return f;
                  }),
                };
              }),
            }));
          } else if (evt.type === 'image') {
            // A generated tile arrived — append it (streamed gallery) + tick its model's delivered
            // count (matched by id, label as the fallback for older streams).
            set((s) => ({
              turns: s.turns.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      images: [
                        ...t.images,
                        { url: evt.url, modelId: evt.modelId, modelLabel: evt.modelLabel || '', index: t.images.length, score: evt.score },
                      ],
                      fan: t.fan?.map((f) =>
                        (evt.modelId ? f.modelId === evt.modelId : f.label === evt.modelLabel)
                          ? { ...f, delivered: f.delivered + 1 }
                          : f
                      ),
                    }
                  : t
              ),
            }));
          } else if (evt.type === 'gen_done') {
            // The whole fan settled. KEEP `fan` — the settled statuses are the run's record (the
            // status panel); only the generating flag drops. Belt-and-braces: anything still marked
            // pending/running at gen_done settles honestly (delivered==n → done, else failed).
            set((s) => ({
              turns: s.turns.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      generating: false,
                      fan: t.fan?.map((f) =>
                        f.state === 'pending' || f.state === 'running'
                          ? f.delivered >= f.n
                            ? { ...f, state: 'done' as const }
                            : { ...f, state: 'failed' as const, reason: f.reason ?? 'no result' }
                          : f
                      ),
                    }
                  : t
              ),
            }));
          } else if (evt.type === 'notice') {
            // Gentle best-effort heads-up (not an error) — append to the turn's notices.
            set((s) => ({
              turns: s.turns.map((t) =>
                t.id === id ? { ...t, notices: [...(t.notices ?? []), String(evt.message || '')] } : t
              ),
            }));
          } else if (evt.type === 'part_edit') {
            // THE COUPLING: the Agent edited a Build part. Write it to the shared values (→ the Build
            // panel + center prompt update live) and flag it for the highlight/ring animation.
            if (typeof evt.id === 'string' && typeof evt.value === 'string') {
              get().setPartValue(evt.id, evt.value, true);
            }
          } else if (evt.type === 'gen_error') {
            patch(id, { generating: false, error: evt.message });
          } else if (evt.type === 'done') {
            const createdAt = get().turns.find((t) => t.id === id)?.createdAt ?? Date.now();
            patch(id, {
              status: 'done',
              statusMessage: '',
              // Wall-clock duration of the response, for the message footer.
              durationMs: Date.now() - createdAt,
              // Capture the persisted Interaction id so this turn can be deleted later.
              ...(typeof evt.interaction_id === 'string' && evt.interaction_id
                ? { interactionId: evt.interaction_id }
                : {}),
            });
            // Capture the thread id so follow-ups (and reloads) target the SAME thread. The route
            // creates a thread when none is supplied and returns it here.
            if (typeof evt.thread_id === 'string' && evt.thread_id) {
              set({ threadId: evt.thread_id });
              if (typeof window !== 'undefined') {
                try {
                  window.localStorage.setItem(THREAD_STORAGE_KEY, evt.thread_id);
                } catch {
                  /* storage may be unavailable (private mode) — non-fatal */
                }
              }
            }
          } else if (evt.type === 'error') {
            patch(id, { status: 'error', error: evt.message, statusMessage: '' });
          }
        }
      }

      // Stream ended without an explicit done/error — close it out gracefully.
      if (get().turns.find((t) => t.id === id)?.status !== 'done') {
        const t = get().turns.find((tt) => tt.id === id);
        if (t && t.status !== 'error') {
          patch(id, { status: t.text.trim() ? 'done' : 'error', error: t.text.trim() ? undefined : 'No response.', statusMessage: '' });
        }
      }
    } catch (err) {
      patch(id, {
        status: 'error',
        error: err instanceof Error ? err.message : 'Network error',
        statusMessage: '',
      });
    }
  }

  return {
    turns: [],
    threadId: null,
    threadTitle: null,
    activeMedium: 'chat',
    activeFrame: null,
    viewMode: 'chat',
    fanConfig: loadFanConfig(),
    partValues: {},
    partSeedTurn: null,
    lastEdit: null,
    setPartValue: (partId, value, fromAgent = false) =>
      set((s) => ({
        partValues: { ...s.partValues, [partId]: value },
        ...(fromAgent ? { lastEdit: { id: partId, n: (s.lastEdit?.n ?? 0) + 1 } } : {}),
      })),
    seedBuilder: (turnId, seed) =>
      set((s) => (s.partSeedTurn === turnId ? {} : { partValues: seed, partSeedTurn: turnId, lastEdit: null })),
    send: (prompt, references = [], builder, referenceAssetIds) => {
      const clean = prompt.trim();
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      set((s) => ({
        turns: [
          ...s.turns,
          {
            id,
            userPrompt: clean,
            userImages: references.length > 0 ? references : undefined,
            status: 'thinking',
            statusMessage: 'Thinking…',
            text: '',
            steps: [],
            a2ui: null,
            suggestions: [],
            sources: [],
            images: [],
            createdAt: Date.now(),
          },
        ],
      }));
      // Fire and forget — the turn lives in the store, streamed in the background.
      void run(id, clean, references, builder, referenceAssetIds);
      return id;
    },
    loadThread: async (threadId) => {
      // Restore a persisted conversation from the SQLite store. Read-only; on any failure we
      // leave the store empty and warn (a fresh conversation) rather than throwing.
      try {
        const params = new URLSearchParams({
          thread_id: threadId,
          user_id: DEV_USER_ID,
        });
        const res = await fetch(`/api/chat-history?${params.toString()}`);
        if (!res.ok) {
          console.warn(`[chat-turns] loadThread failed: HTTP ${res.status}`);
          return;
        }
        const data: { interactions?: Interaction[]; assets?: Asset[] } = await res.json();
        const interactions = Array.isArray(data.interactions) ? data.interactions : [];

        // Group persisted assets by the interaction that produced them → repopulate each turn.
        // GENERATED assets rehydrate the turn's output images (Slice 1). UPLOAD assets (attached
        // references) rehydrate the turn's userImages (Slice 2 — the vanishing-attachment bug). Both
        // ordered by tile index.
        const imagesByInteraction = new Map<string, GalleryImage[]>();
        const userImagesByInteraction = new Map<string, { url: string; index: number }[]>();
        for (const a of Array.isArray(data.assets) ? data.assets : []) {
          if (!a || a.kind !== 'image' || !a.interaction_id || typeof a.url !== 'string') continue;
          const idx = typeof a.index === 'number' ? a.index : 0;
          if (a.source === 'upload') {
            const list = userImagesByInteraction.get(a.interaction_id) ?? [];
            list.push({ url: a.url, index: idx });
            userImagesByInteraction.set(a.interaction_id, list);
          } else {
            const list = imagesByInteraction.get(a.interaction_id) ?? [];
            list.push({ url: a.url, modelLabel: a.model_label ?? '', index: idx });
            imagesByInteraction.set(a.interaction_id, list);
          }
        }
        for (const list of imagesByInteraction.values()) list.sort((x, y) => x.index - y.index);
        for (const list of userImagesByInteraction.values()) list.sort((x, y) => x.index - y.index);

        // Map each persisted Interaction → a completed ChatTurn (ascending by created_at — the
        // query already sorts asc; keep the order it returns).
        const turns: ChatTurn[] = interactions.map((it) => {
          const a2ui = it.response?.a2ui as A2UIBlock | null;
          const persistedSources = (it.response as { sources?: Source[] } | undefined)?.sources;
          // Rehydrate the fan's per-model record (snake_case summary → the live status shape) so the
          // status panel repaints the run — the 360° round-trip: nothing about the run is lost.
          const persistedFan = Array.isArray(it.response?.fan)
            ? it.response.fan.map(
                (f): FanModelStatus => ({
                  modelId: f.model_id,
                  label: f.label,
                  n: f.n,
                  delivered: f.delivered,
                  state: f.state,
                  reason: f.reason,
                  why: f.why,
                  ms: f.ms,
                })
              )
            : undefined;
          return {
            id: it.id,
            userPrompt: it.prompt?.text ?? '',
            status: 'done',
            statusMessage: '',
            text: it.response?.text ?? '',
            steps: [],
            a2ui:
              a2ui &&
              (a2ui.kind === 'options' ||
                a2ui.kind === 'question' ||
                a2ui.kind === 'references' ||
                a2ui.kind === 'builder')
                ? a2ui
                : null,
            suggestions: [],
            sources: Array.isArray(persistedSources) ? persistedSources : [],
            images: imagesByInteraction.get(it.id) ?? [],
            userImages: (userImagesByInteraction.get(it.id) ?? []).map((u) => u.url),
            fan: persistedFan,
            createdAt: it.created_at,
            interactionId: it.id,
          };
        });

        set({ turns, threadId });
      } catch (err) {
        console.warn('[chat-turns] loadThread error (leaving conversation empty):', err);
      }
    },
    deleteTurn: async (interactionId) => {
      // Audit-preserving SOFT delete: the route flips the interaction to 'deleted' behind the
      // Repository port (NO spend, no model). On success we resync from the DB (so the deleted
      // turn drops), or optimistically remove it if there's no thread yet. On failure: warn only.
      try {
        const res = await fetch('/api/chat-mutate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'delete',
            thread_id: get().threadId ?? undefined,
            interaction_id: interactionId,
          }),
        });
        if (!res.ok) {
          console.warn(`[chat-turns] deleteTurn failed: HTTP ${res.status}`);
          return;
        }
        const threadId = get().threadId;
        if (threadId) {
          await get().loadThread(threadId);
        } else {
          set((s) => ({ turns: s.turns.filter((t) => t.interactionId !== interactionId) }));
        }
      } catch (err) {
        console.warn('[chat-turns] deleteTurn error (leaving conversation as-is):', err);
      }
    },
    reset: () => {
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem(THREAD_STORAGE_KEY);
        } catch {
          /* non-fatal */
        }
      }
      set({ turns: [], threadId: null, threadTitle: null, activeMedium: 'chat', activeFrame: null, viewMode: 'chat', partValues: {}, partSeedTurn: null, lastEdit: null });
    },
    setActiveMedium: (medium) => set({ activeMedium: medium }),
    setViewMode: (mode) => set({ viewMode: mode }),
    setFanConfig: (patch) =>
      set((s) => { const next = { ...s.fanConfig, ...patch }; saveFanConfig(next); return { fanConfig: next }; }),
    setThreadTitle: (title) => set({ threadTitle: title }),
    // Keep turns + threadId (the project); only the in-flight frame is dropped.
    enterSection: (medium) => set({ activeMedium: medium, activeFrame: null }),
  };
});
