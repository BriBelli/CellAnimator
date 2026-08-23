'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * MessageTurn — one conversation turn, ported faithfully from photolif's
 * `a2ui-chat-message` (apps/a2ui-chat) into React on our token primitives.
 *
 * Layout (photolif .message):
 *   [avatar 32px]  [content column]          ← assistant: avatar LEFT
 *   [content column]  [avatar 32px]          ← user: row-reverse
 *
 *   • assistant avatar = the Pixcel-X mark on a bland token circle (NOT a rainbow
 *     gradient) — the agent's identity is the avatar, there is no top badge line.
 *   • assistant content: markdown text (white-space: normal, tight em rhythm) →
 *     streaming cursor → the a2ui options card → footer meta (model badge +
 *     duration + timestamp + hover actions) → sources → arrow followups.
 *   • user content: the accent bubble (right-aligned) + a timestamp meta.
 *
 * Tokens-only, sentence case, no scale-pop, one entrance curve
 * (--a2ui-ease-entrance = cubic-bezier(0.22,1,0.36,1)).
 * ───────────────────────────────────────────────────────────────────────────── */

import { a2uiSurface, type ChatTurn } from '../../store/chat-turns-store';
import { Avatar, Icon, PixcelMark } from '../ui';
import { QuestionBlock } from './QuestionBlock';
import { ProposalBlock } from './ProposalBlock';
import { ReferencesBlock } from './ReferencesBlock';
import { MessageActions } from './MessageActions';
import { FanStatus } from './FanStatus';
import { ThinkingIndicator } from './ThinkingIndicator';
import { StreamingCursor } from './StreamingCursor';
import { Markdown } from './Markdown';
import { SuggestionsRow } from './SuggestionsRow';
import { SourcesRow } from './SourcesRow';

export interface MessageTurnProps {
  turn: ChatTurn;
  /** Show the assistant action-bar footer (copy · regenerate · feedback). Default true. */
  showActions?: boolean;
  onSuggestion: (text: string) => void;
  /** Render 'controls'-surface blocks (the references/model card) inline in the turn. True in chat
   *  home (no panel exists); false in the workspace, where they're lifted to the Prompt Guide panel.
   *  Default true. */
  renderControlsInline?: boolean;
  /** Enter the specialist workspace for this turn's transfer (the clickable transfer CTA). */
  onOpenWorkflow?: (medium: 'image' | 'video') => void;
  /** Copy this turn's assistant text to the clipboard (every done turn). */
  onCopy: () => void;
  /** Re-run the model for this turn (LAST done turn only) — SPENDS a model call. */
  onRegenerate?: () => void;
  /** Soft-delete this turn (LAST done, persisted turn only). */
  onDelete?: () => void;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Entrance choreography — photolif's messageIn / contentFadeIn / metaFadeIn.
 * The message root rises + fades in ONCE on mount (a CSS animation on a stable,
 * id-keyed node fires once and never replays as React reconciles streaming text).
 * The a2ui card + followups fade in under the text on the same curve, delayed.
 * ───────────────────────────────────────────────────────────────────────────── */
const CSS = `
@keyframes pxc-msg-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes pxc-a2ui-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.pxc-msg {
  display: flex;
  gap: var(--a2ui-space-3);
  animation: pxc-msg-in 300ms var(--a2ui-ease-entrance) both;
}
.pxc-msg.user { flex-direction: row-reverse; }

/* Avatar — 32px token circle. Assistant: Pixcel-X on a bland elevated surface,
   X tinted with the brand token (no rainbow). User: the shared Avatar primitive. */
.pxc-avatar {
  width: 32px; height: 32px; flex-shrink: 0;
  border-radius: var(--a2ui-radius-full);
  display: flex; align-items: center; justify-content: center;
}
.pxc-avatar.assistant {
  background: var(--a2ui-bg-elevated);
  color: var(--pxs-accent-text);
}

.pxc-content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pxc-msg.user .pxc-content { align-items: flex-end; }

.pxc-user-bubble {
  max-width: min(600px, 100%);
  padding: var(--a2ui-space-3) var(--a2ui-space-4);
  /* Subtle GLASS — almost part of the background: frosted, no coral. Double-click to expand. */
  background: var(--pxc-bg-glass-20); color: var(--a2ui-text-primary);
  backdrop-filter: var(--pxc-glass-filter); -webkit-backdrop-filter: var(--pxc-glass-filter);
  border: 1px solid var(--pxc-border-subtle);
  border-radius: var(--a2ui-radius-xl);
  /* The bubble's angle sits at the TOP-right (toward the avatar), not bottom-right. */
  border-top-right-radius: var(--a2ui-radius-sm);
  line-height: var(--a2ui-leading-normal);
  white-space: pre-wrap; word-break: break-word;
  /* Expanded (double-clicked) — tall content scrolls in place rather than pushing the chat. */
  max-height: 42vh; overflow-y: auto; cursor: default;
}
/* Collapsed by default: clip to ~6 lines with a trailing ellipsis. */
.pxc-user-bubble.pxc-clamped {
  display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden;
}
.pxc-user-meta {
  margin-top: var(--a2ui-space-1);
  font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary);
}
/* Attached reference thumbnails on the user bubble (right-aligned with the bubble). */
.pxc-user-refs {
  display: flex; flex-wrap: wrap; gap: var(--a2ui-space-2); justify-content: flex-end;
  margin-bottom: var(--a2ui-space-2); max-width: min(600px, 100%);
}
.pxc-user-ref {
  width: 56px; height: 56px; object-fit: cover; display: block;
  border-radius: var(--a2ui-radius-md); box-shadow: 0 0 0 1px var(--pxs-border-subtle);
}

.pxc-assistant-text {
  white-space: normal; word-break: break-word;
  color: var(--a2ui-text-primary);
  line-height: var(--a2ui-leading-relaxed);
  padding: var(--a2ui-space-1) 0;
}

/* Footer actions — hidden until the turn is hovered/focused, then eased in. */
.pxc-actions { opacity: 0; transition: opacity var(--a2ui-transition-fast); }
.pxc-msg:hover .pxc-actions,
.pxc-msg:focus-within .pxc-actions { opacity: 1; }
@media (max-width: 480px) { .pxc-actions { opacity: 1; } }

.pxc-a2ui-reveal { animation: pxc-a2ui-in 420ms var(--a2ui-ease-entrance) 140ms both; }
.pxc-choosing-reveal { animation: pxc-a2ui-in 300ms var(--a2ui-ease-entrance) both; }
.pxc-turn-error { font-size: var(--a2ui-text-md); color: var(--a2ui-error); }

/* Transfer CTA — the clickable hand-off row into the specialist workspace. A calm
   elevated card (no gradient on chrome, no scale-pop); the arrow nudges on hover. */
.pxc-transfer-cta {
  margin-top: var(--a2ui-space-3);
  display: flex; align-items: center; gap: var(--a2ui-space-3);
  width: 100%; max-width: 320px; text-align: left;
  padding: var(--a2ui-space-2) var(--a2ui-space-3);
  border-radius: var(--a2ui-radius-lg);
  border: 1px solid var(--a2ui-border-subtle); background: var(--a2ui-bg-elevated);
  color: var(--a2ui-text-primary); cursor: pointer; font-family: var(--a2ui-font-family);
  transition: border-color var(--a2ui-transition-fast), background var(--a2ui-transition-fast);
}
.pxc-transfer-cta:hover { border-color: var(--a2ui-border-default); background: var(--a2ui-bg-hover); }
.pxc-transfer-avatar {
  width: 26px; height: 26px; flex-shrink: 0;
  border-radius: var(--a2ui-radius-full);
  background: var(--a2ui-bg-tertiary); color: var(--pxs-accent-text);
  display: flex; align-items: center; justify-content: center;
}
.pxc-transfer-label {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  font-size: var(--a2ui-text-sm); line-height: var(--a2ui-leading-tight);
}
.pxc-transfer-sub { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); }
.pxc-transfer-arrow { color: var(--a2ui-text-tertiary); transition: transform var(--a2ui-transition-fast); }
.pxc-transfer-cta:hover .pxc-transfer-arrow { transform: translateX(2px); }

/* Generated gallery — a 2-up grid of tiles that stream in. */
.pxc-gallery {
  margin-top: var(--a2ui-space-4);
  display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--a2ui-space-2);
  max-width: 520px;
}
.pxc-tile {
  position: relative; display: block; aspect-ratio: 1 / 1; overflow: hidden;
  border-radius: var(--a2ui-radius-md); background: var(--a2ui-bg-tertiary);
  box-shadow: 0 0 0 1px var(--pxs-border-subtle);
  transition: transform var(--a2ui-transition-fast), box-shadow var(--a2ui-transition-fast);
}
.pxc-tile:hover { box-shadow: 0 0 0 1px var(--a2ui-border-default); }
.pxc-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* Hover overlay — the ONLY gradient allowed on chrome (gospel §6). Actions bottom-right. */
.pxc-tile-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: flex-end; justify-content: flex-end; gap: var(--a2ui-space-2);
  padding: var(--a2ui-space-2);
  background: linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.6) 100%);
  opacity: 0; transition: opacity var(--a2ui-transition-fast);
}
.pxc-tile:hover .pxc-tile-overlay, .pxc-tile:focus-within .pxc-tile-overlay { opacity: 1; }
.pxc-tile-action {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px;
  border-radius: var(--a2ui-radius-md);
  border: 1px solid var(--pxs-glass-border); background: var(--a2ui-glass-dark);
  backdrop-filter: blur(8px);
  color: var(--a2ui-text-primary); font-size: var(--a2ui-text-xs);
  font-family: var(--a2ui-font-family); text-decoration: none; cursor: pointer;
  transition: background var(--a2ui-transition-fast);
}
.pxc-tile-action:hover { background: var(--a2ui-bg-elevated); }
.pxc-tile-badge {
  position: absolute; left: 6px; bottom: 6px;
  padding: 2px 7px; border-radius: var(--a2ui-radius-full);
  font-size: var(--a2ui-text-xs); color: var(--a2ui-text-primary);
  background: var(--a2ui-glass-dark); backdrop-filter: blur(8px);
  border: 1px solid var(--pxs-glass-border);
}
.pxc-tile-loading {
  display: flex; align-items: center; justify-content: center;
  color: var(--a2ui-text-tertiary); font-size: var(--a2ui-text-sm);
  animation: pxc-tile-pulse 1.4s ease-in-out infinite;
}
@keyframes pxc-tile-pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .pxc-msg, .pxc-a2ui-reveal, .pxc-choosing-reveal { animation: none; }
}
`;

/** Short local wall-clock stamp ("06:03 PM") for the user meta. */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageTurn({
  turn,
  showActions = true,
  onSuggestion,
  renderControlsInline = true,
  onOpenWorkflow,
  onCopy,
  onRegenerate,
  onDelete,
}: MessageTurnProps) {
  const thinking = turn.status === 'thinking' && !turn.text;
  const streaming = turn.status === 'streaming';
  const done = turn.status === 'done';

  // POST-text WORKFLOW phase — the pipeline keeps working AFTER the opener text streams (the transfer
  // consult: shaping → grounding; a render: selecting → generating). Keep the reel visible through it
  // — otherwise a slow transfer runs dark for seconds — until the real result (builder/images/
  // suggestions) arrives. Shows all steps, centered on the active one, per the loading settings.
  const resultArrived = !!turn.a2ui || turn.suggestions.length > 0 || turn.images.length > 0;
  // Persist the reel through the WHOLE pipeline — not per-active-step. Keying off "a step is active"
  // would blink the reel out in the tick between one step finishing and the next starting (jitter).
  // Once steps exist, hold it steady until the turn is done or the real result lands.
  const running = !done && !resultArrived && turn.steps.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--a2ui-space-4)' }}>
      <style>{CSS}</style>

      {/* USER row — avatar RIGHT (row-reverse), accent bubble, timestamp meta. */}
      {turn.userPrompt && (
        <div className="pxc-msg user">
          <Avatar size={32} />
          <div className="pxc-content">
            {turn.userImages && turn.userImages.length > 0 && (
              <div className="pxc-user-refs">
                {turn.userImages.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} className="pxc-user-ref" src={src} alt="attached reference" />
                ))}
              </div>
            )}
            {turn.userPrompt && (
              <div
                className="pxc-user-bubble pxc-clamped"
                title="Double-click to expand"
                onDoubleClick={(e) => e.currentTarget.classList.toggle('pxc-clamped')}
              >
                {turn.userPrompt}
              </div>
            )}
            <div className="pxc-user-meta">{formatTime(turn.createdAt)}</div>
          </div>
        </div>
      )}

      {/* ASSISTANT row — Pixcel-X avatar LEFT, content column. */}
      <div className="pxc-msg assistant">
        <div className="pxc-avatar assistant" aria-hidden="true">
          <PixcelMark size={18} />
        </div>
        <div className="pxc-content">
          {turn.status === 'error' ? (
          <div className="pxc-turn-error">{turn.error || 'Something went wrong.'}</div>
        ) : thinking ? (
          <ThinkingIndicator message={turn.statusMessage} steps={turn.steps} />
        ) : (
          <>
            {turn.text && (
              <div className="pxc-assistant-text">
                <Markdown>{turn.text}</Markdown>
                {streaming && !running && <StreamingCursor />}
              </div>
            )}

            {running && (
              <div className="pxc-choosing-reveal" style={{ marginTop: 'var(--a2ui-space-2)' }}>
                <ThinkingIndicator steps={turn.steps} />
              </div>
            )}

            {/* The thought process KEPT — once the turn lands, the reel collapses into a
                "Reasoning (N) · Xs" record you can reopen, instead of vanishing with the work. */}
            {!running && (done || resultArrived) && turn.steps.length > 0 && (
              <div className="pxc-choosing-reveal" style={{ marginTop: 'var(--a2ui-space-2)' }}>
                <ThinkingIndicator steps={turn.steps} record />
              </div>
            )}

            {/* A2UI question — the agent's ask affordance (label + text-area + chips). */}
            {turn.a2ui && turn.a2ui.kind === 'question' && (
              <div className="pxc-a2ui-reveal" style={{ marginTop: 'var(--a2ui-space-4)' }}>
                <QuestionBlock block={turn.a2ui} onSubmit={onSuggestion} />
              </div>
            )}

            {/* A2UI proposal — the Operator's `propose` workflow paths (NO spend until a pick). */}
            {turn.a2ui && turn.a2ui.kind === 'options' && (
              <div className="pxc-a2ui-reveal" style={{ marginTop: 'var(--a2ui-space-4)' }}>
                <ProposalBlock block={turn.a2ui} onSelect={onSuggestion} />
              </div>
            )}

            {/* Transfer CTA — the Operator handed this turn to the Image agent; the row is a
                clickable affordance that opens the specialist WORKSPACE (never a dead-end). */}
            {turn.transferredTo && (
              <button
                type="button"
                className="pxc-transfer-cta pxc-a2ui-reveal"
                onClick={() => onOpenWorkflow?.(turn.transferredTo!)}
                title={`Open the ${turn.transferredTo === 'video' ? 'Video' : 'Image'} workspace`}
              >
                <span className="pxc-transfer-avatar" aria-hidden="true">
                  <PixcelMark size={13} />
                </span>
                <span className="pxc-transfer-label">
                  {turn.transferredTo === 'video' ? 'Video' : 'Image'} agent
                  <span className="pxc-transfer-sub">Open workspace</span>
                </span>
                <Icon name="arrow-right" size={15} className="pxc-transfer-arrow" />
              </button>
            )}

            {/* The Image agent's own opener (streamed after the transfer). */}
            {turn.agentText && (
              <div className="pxc-assistant-text pxc-a2ui-reveal" style={{ marginTop: 'var(--a2ui-space-2)' }}>
                <Markdown>{turn.agentText}</Markdown>
              </div>
            )}

            {/* FAN STATUS — the command-center view of a multi-model render: which models, their
                live progress, honest per-model failure. Stays after the run as the record of it
                (and rehydrates from the persisted summary on reload). */}
            {turn.fan && turn.fan.length > 0 && (
              <div className="pxc-a2ui-reveal" style={{ marginTop: 'var(--a2ui-space-3)' }}>
                <FanStatus fan={turn.fan} generating={turn.generating} />
              </div>
            )}

            {/* Generated gallery — tiles stream in from the dispatched image workflow. */}
            {(turn.images.length > 0 || turn.generating) && (
              <div className="pxc-gallery pxc-a2ui-reveal">
                {turn.images.map((img) => (
                  <div key={img.index} className="pxc-tile">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt={img.modelLabel || 'generated image'} />
                    <div className="pxc-tile-overlay">
                      <a
                        className="pxc-tile-action"
                        href={img.url}
                        download={`pixcel-${img.index + 1}.png`}
                        title="Download"
                      >
                        <Icon name="download" size={13} /> Download
                      </a>
                      <button
                        type="button"
                        className="pxc-tile-action"
                        onClick={() => onSuggestion('Make a few more variations of this.')}
                        title="Make variations"
                      >
                        <Icon name="refresh-cw" size={13} /> Variations
                      </button>
                    </div>
                    {img.modelLabel && <span className="pxc-tile-badge">{img.modelLabel}</span>}
                  </div>
                ))}
                {turn.generating && <div className="pxc-tile pxc-tile-loading">Generating…</div>}
              </div>
            )}

            {/* Gentle best-effort notices (never errors) — e.g. "rendered 2 of 4, a model capped". */}
            {turn.notices && turn.notices.length > 0 && (
              <div className="pxc-a2ui-reveal" style={{ marginTop: 'var(--a2ui-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--a2ui-space-1)' }}>
                {turn.notices.map((n, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--a2ui-space-2)', fontSize: 'var(--a2ui-text-sm)', color: 'var(--a2ui-text-tertiary)' }}>
                    <Icon name="info" size={13} style={{ flexShrink: 0 }} /> {n}
                  </div>
                ))}
              </div>
            )}

            {/* A2UI references — the Image agent's grounded capability recommendation (Model agent):
                what the chosen model supports + what to attach next. A 'controls'-surface block, so
                in the workspace it's lifted to the Prompt Guide panel (renderControlsInline=false);
                inline here only in chat home, where no panel exists. */}
            {turn.a2ui && turn.a2ui.kind === 'references' &&
              (renderControlsInline || a2uiSurface(turn.a2ui) !== 'controls') && (
              <div className="pxc-a2ui-reveal" style={{ marginTop: 'var(--a2ui-space-4)' }}>
                <ReferencesBlock block={turn.a2ui} />
              </div>
            )}

            {/* Footer meta + actions — DONE turns only, when the Action bar setting is on. */}
            {done && showActions && (
              <MessageActions
                createdAt={turn.createdAt}
                durationMs={turn.durationMs}
                text={turn.text}
                onCopy={onCopy}
                onRegenerate={onRegenerate}
                onDelete={onDelete}
              />
            )}

            <SourcesRow sources={turn.sources} />
            <SuggestionsRow suggestions={turn.suggestions} onSelect={onSuggestion} />
          </>
        )}
        </div>
      </div>
    </div>
  );
}

export default MessageTurn;
