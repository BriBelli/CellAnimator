'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * ThinkingIndicator — the pre-text "thinking" loader for a chat turn.
 *
 * ONE setting (settings-store.loadingMode) — constructive-not-destructive, but no confusing axes:
 *   • simple   — a spinner + "Loading…" + elapsed seconds. Also the non-SSE / streaming-off state.
 *   • detailed — the single-row SLOT MACHINE: one active step in a fixed one-line window that rolls
 *                (one out, one in) as steps advance. It NEVER reflows the surrounding text — the whole
 *                point is cognitive calm. Depth is on demand: an expand button opens a scrollable box
 *                to read the full thought history, then collapses back to the calm one row.
 *
 * (Stack was removed — its auto-append reflowed the text on every step and broke the calm.)
 *
 * Tokens-only, sentence case, one easing curve (--a2ui-ease-entrance). Reduced motion → static.
 * Reads the setting itself, so call sites just pass `steps` (+ optional `message`); pass `mode` only
 * to override.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import { useSettings, type LoadingMode } from '../../store/settings-store';

export type ThinkingStepState = 'pending' | 'active' | 'done';

export interface ThinkingStep {
  /** Backend step id (e.g. 'reading', 'choosing') — used to match start/done events. */
  id?: string;
  label: string;
  state: ThinkingStepState;
  /** Optional sub-text (a tool target / short note) — shown in the expanded view. */
  detail?: string;
  /** Optional chain-of-thought prose — shown in the expanded view. */
  reasoning?: string;
  /** When this step started (ms epoch) — stamped by the store on `start`. */
  startedAt?: number;
  /** How long the step took (ms) — stamped by the store on `done`. Surfaced in the record. */
  ms?: number;
}

export interface ThinkingIndicatorProps {
  /** The status label for the no-steps / simple case (default "Thinking…" / "Loading…"). */
  message?: string;
  /** The multi-step feed. Rolled in the single-row reel; readable in full when expanded. */
  steps?: ThinkingStep[];
  /** Override the loading mode (defaults to the user setting). */
  mode?: LoadingMode;
  /** RECORD mode — the turn is DONE. Instead of a live reel, render one collapsed
   *  "Reasoning (N) · 4.2s" row that expands to the full step history. The thought process is part
   *  of the work, so it survives the turn instead of vanishing when the result lands. */
  record?: boolean;
}

/** Height of one reel row (px) — the single-line window; the reel translates by this per step. */
const REEL_STEP_H = 24;

const CSS = `
@keyframes pxc-think-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@keyframes pxc-think-spin { to { transform: rotate(360deg); } }
@keyframes pxc-think-step-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }

.pxc-think { font-size: var(--a2ui-text-md); line-height: var(--a2ui-leading-normal); min-width: 0; }

/* ── simple: spinner + label + seconds (one line) ──────────────────────────── */
.pxc-think__simple { display: flex; align-items: center; gap: var(--a2ui-space-2); color: var(--a2ui-text-secondary); }
.pxc-think__spin { flex-shrink: 0; width: 13px; height: 13px; border: 2px solid var(--a2ui-border-default);
  border-top-color: var(--a2ui-accent); border-radius: 50%; animation: pxc-think-spin 0.8s linear infinite; }
.pxc-think__simple-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pxc-think__secs { color: var(--a2ui-text-tertiary); font-size: var(--a2ui-text-xs);
  font-variant-numeric: tabular-nums; flex-shrink: 0; }

/* ── detailed: shimmer label (no steps yet) ────────────────────────────────── */
.pxc-think__label {
  display: block; color: var(--a2ui-text-secondary);
  background: linear-gradient(100deg,
    var(--a2ui-text-secondary) 0%, var(--a2ui-text-secondary) 35%,
    var(--a2ui-text-primary) 50%,
    var(--a2ui-text-secondary) 65%, var(--a2ui-text-secondary) 100%);
  background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  animation: pxc-think-shimmer 2200ms var(--a2ui-ease-entrance) infinite;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── detailed: the row (reel/expanded + expand toggle) ─────────────────────── */
.pxc-think__row { display: flex; align-items: flex-start; gap: var(--a2ui-space-2); min-width: 0; }
.pxc-think__area { flex: 1; min-width: 0; }

/* shared step */
.pxc-think__step { display: flex; align-items: flex-start; gap: var(--a2ui-space-2); color: var(--a2ui-text-tertiary); min-width: 0; }
.pxc-think__step-check { flex-shrink: 0; width: 12px; height: 12px; margin-top: 4px; color: var(--a2ui-success); }
.pxc-think__step-spin { flex-shrink: 0; width: 10px; height: 10px; margin-top: 5px; border: 1.5px solid var(--a2ui-border-default);
  border-top-color: var(--a2ui-text-tertiary); border-radius: 50%; animation: pxc-think-spin 0.8s linear infinite; }
.pxc-think__step-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pxc-think__step-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pxc-think__step-detail { color: var(--a2ui-accent); font-size: 10px; font-style: italic; opacity: 0.85;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pxc-think__step-reason { color: var(--a2ui-text-tertiary); font-size: 11px; line-height: 1.45; white-space: normal; }

/* collapsed: the single-line slot-machine window */
.pxc-think__reel-window { height: ${REEL_STEP_H}px; overflow: hidden; position: relative; }
.pxc-think__reel { display: flex; flex-direction: column; transition: transform 450ms var(--a2ui-ease-entrance); }
.pxc-think__reel .pxc-think__step { height: ${REEL_STEP_H}px; flex-shrink: 0; align-items: center;
  opacity: 0.35; transition: opacity 300ms var(--a2ui-ease-entrance), color 300ms var(--a2ui-ease-entrance); }
.pxc-think__reel .pxc-think__step--current { opacity: 1; color: var(--a2ui-text-primary); }

/* expanded: the scrollable full history */
.pxc-think__expanded { display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto;
  padding-right: 2px; scrollbar-width: thin; scrollbar-color: var(--a2ui-border-default) transparent; }
.pxc-think__expanded::-webkit-scrollbar { width: 4px; }
.pxc-think__expanded::-webkit-scrollbar-thumb { background: var(--a2ui-border-default); border-radius: 2px; }
.pxc-think__expanded .pxc-think__step { animation: pxc-think-step-in 250ms var(--a2ui-ease-entrance) both; }
.pxc-think__expanded .pxc-think__step--current { color: var(--a2ui-text-primary); }

/* ── record: the DONE turn's collapsed "Reasoning (N)" row ────────────────── */
.pxc-think__record-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 0; border: none; background: none;
  color: var(--a2ui-text-tertiary); font-family: var(--a2ui-font-family); font-size: var(--a2ui-text-sm);
  cursor: pointer; border-radius: var(--a2ui-radius-sm);
}
.pxc-think__record-btn:hover { color: var(--a2ui-text-secondary); }
.pxc-think__record-btn svg { width: 12px; height: 12px; transition: transform 0.2s ease; }
.pxc-think__record-btn[data-open="true"] svg { transform: rotate(180deg); }
.pxc-think__record-secs { color: var(--a2ui-text-tertiary); font-variant-numeric: tabular-nums; }
.pxc-think__record-body { margin-top: var(--a2ui-space-2); padding-left: var(--a2ui-space-2);
  border-left: 1px solid var(--a2ui-border-subtle); display: flex; flex-direction: column; gap: 6px; }
.pxc-think__step-ms { color: var(--a2ui-text-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }

/* expand toggle */
.pxc-think__expand { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: ${REEL_STEP_H}px; border: none; background: none; color: var(--a2ui-text-tertiary);
  cursor: pointer; border-radius: var(--a2ui-radius-sm); }
.pxc-think__expand:hover { color: var(--a2ui-text-secondary); }
.pxc-think__expand svg { width: 12px; height: 12px; transition: transform 0.2s ease; }
.pxc-think__expand[data-open="true"] svg { transform: rotate(180deg); }

@media (prefers-reduced-motion: reduce) {
  .pxc-think__label { animation: none; -webkit-text-fill-color: var(--a2ui-text-secondary); color: var(--a2ui-text-secondary); }
  .pxc-think__reel { transition: none; }
  .pxc-think__expanded .pxc-think__step { animation: none; }
  .pxc-think__spin, .pxc-think__step-spin { animation: none; }
}
`;

/** The index of the step to center on — first non-done, else the last. */
function currentStepIndex(steps: ThinkingStep[]): number {
  for (let i = 0; i < steps.length; i++) if (steps[i].state !== 'done') return i;
  return steps.length - 1;
}

function Check() {
  return (
    <svg className="pxc-think__step-check" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One step row. `full` (expanded) reveals detail + reasoning; collapsed shows the label only. */
function StepRow({ step, current, full }: { step: ThinkingStep; current: boolean; full: boolean }) {
  return (
    <div className={`pxc-think__step${current ? ' pxc-think__step--current' : ''}`}>
      {step.state === 'done' ? <Check /> : <span className="pxc-think__step-spin" />}
      <span className="pxc-think__step-text">
        <span className="pxc-think__step-label">
          {step.label}
          {full && step.ms != null && step.ms >= 100 && (
            <span className="pxc-think__step-ms"> · {(step.ms / 1000).toFixed(1)}s</span>
          )}
        </span>
        {full && step.detail && <span className="pxc-think__step-detail">{step.detail}</span>}
        {full && step.reasoning && <span className="pxc-think__step-reason">{step.reasoning}</span>}
      </span>
    </div>
  );
}

/**
 * RECORD — the finished turn's thought process, kept. One calm "Reasoning (N) · 4.2s" row that
 * expands to the full step history with per-step timings. The reel used to vanish the moment the
 * result landed, taking the whole account of HOW the work happened with it.
 */
function ThinkingRecord({ steps }: { steps: ThinkingStep[] }) {
  const [open, setOpen] = useState(false);
  const total = steps.reduce((s, st) => s + (st.ms ?? 0), 0);
  return (
    <div className="pxc-think">
      <button
        type="button"
        className="pxc-think__record-btn"
        data-open={open ? 'true' : 'false'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide the workflow' : 'Show how this was worked out'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        Reasoning ({steps.length})
        {total >= 100 && <span className="pxc-think__record-secs">· {(total / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="pxc-think__record-body">
          {steps.map((s, i) => (
            <StepRow key={s.id ?? i} step={s} current={false} full />
          ))}
        </div>
      )}
    </div>
  );
}

/** A live elapsed-seconds counter for simple mode (honest elapsed — not an added delay). */
function useElapsed(active: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    setN(0);
    const t = window.setInterval(() => setN((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return n;
}

export function ThinkingIndicator({ message, steps, mode, record }: ThinkingIndicatorProps) {
  const settingMode = useSettings((s) => s.loadingMode);
  const m = mode ?? settingMode;
  const all = Array.isArray(steps) ? steps : [];
  const hasSteps = all.length > 0;
  const active = hasSteps ? currentStepIndex(all) : 0;

  const [expanded, setExpanded] = useState(false);
  const elapsed = useElapsed(m === 'simple' && !record);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep the expanded view pinned to the active step as new steps stream in.
  useEffect(() => {
    if (expanded && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [expanded, all.length]);

  // ── RECORD: the turn is done — the thought process is kept, not discarded ──
  if (record) {
    if (!hasSteps) return null;
    return (
      <>
        <style>{CSS}</style>
        <ThinkingRecord steps={all} />
      </>
    );
  }

  // ── SIMPLE: spinner + label + seconds ──
  if (m === 'simple') {
    const label = (hasSteps ? all[active].label : message?.trim()) || 'Loading…';
    return (
      <>
        <style>{CSS}</style>
        <div className="pxc-think" role="status" aria-live="polite">
          <div className="pxc-think__simple">
            <span className="pxc-think__spin" />
            <span className="pxc-think__simple-label">{label}</span>
            {elapsed >= 1 && <span className="pxc-think__secs">{elapsed}s</span>}
          </div>
        </div>
      </>
    );
  }

  // ── DETAILED: no steps yet → the calm shimmer ──
  if (!hasSteps) {
    return (
      <>
        <style>{CSS}</style>
        <div className="pxc-think" role="status" aria-live="polite">
          <span className="pxc-think__label">{message?.trim() || 'Thinking…'}</span>
        </div>
      </>
    );
  }

  // ── DETAILED: the single-row slot machine, expandable to the full scrollable history ──
  const canExpand = all.length > 1;
  return (
    <>
      <style>{CSS}</style>
      <div className="pxc-think" role="status" aria-live="polite">
        <div className="pxc-think__row">
          <div className="pxc-think__area">
            {expanded ? (
              <div className="pxc-think__expanded" ref={scrollRef}>
                {all.map((s, i) => (
                  <StepRow key={s.id ?? i} step={s} current={i === active} full />
                ))}
              </div>
            ) : (
              <div className="pxc-think__reel-window">
                <div className="pxc-think__reel" style={{ transform: `translateY(${-active * REEL_STEP_H}px)` }}>
                  {all.map((s, i) => (
                    <StepRow key={s.id ?? i} step={s} current={i === active} full={false} />
                  ))}
                </div>
              </div>
            )}
          </div>
          {canExpand && (
            <button
              type="button"
              className="pxc-think__expand"
              data-open={expanded ? 'true' : 'false'}
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Collapse' : 'Expand the full workflow'}
              aria-label={expanded ? 'Collapse workflow' : 'Expand workflow'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export default ThinkingIndicator;
