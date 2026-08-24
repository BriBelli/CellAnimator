'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * FanStatus — the chat COMMAND CENTER for a multi-model render.
 *
 * A 3-model × 3-image render must never read as a blank screen with images popping
 * in. This is the high-level process view: which models were picked (and why), each
 * model's API call as a live row with a progress bar, honest per-model failure in
 * amber — and it STAYS after the run as the record of what happened (it rehydrates
 * from the persisted fan summary on reload).
 *
 * Density follows the ONE existing loading setting (settings-store.loadingMode):
 *   • detailed — the full card: header, a row per model, footer tally.
 *   • simple   — one compact summary line, expandable to the same card.
 * Failures are NEVER hidden in either mode — that's the whole point of the surface.
 *
 * Tokens-only, no gradient on chrome, sentence case, reduced-motion safe.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useState } from 'react';
import { Icon } from '../ui';
import { useSettings, type LoadingMode } from '../../store/settings-store';
import type { FanModelStatus } from '../../store/chat-turns-store';

export interface FanStatusProps {
  /** The turn's per-model fan status (live while generating, settled after). */
  fan: FanModelStatus[];
  /** True while the render is still in flight — drives the live vs record framing. */
  generating?: boolean;
  /** Override the density (defaults to the user's loading setting). */
  mode?: LoadingMode;
}

/**
 * The adapter's failure reason → plain words. The taxonomy is `GenErrorReason`
 * (executor.ts); anything else is a raw adapter message, which we surface as-is
 * (truncated) rather than inventing a friendlier lie about what went wrong.
 */
function plainReason(reason?: string): string {
  switch (reason) {
    case 'no_key': return 'no API key';
    case 'moderated': return 'blocked by the provider';
    case 'timeout': return 'timed out';
    case 'rate_limited': return 'rate limited';
    case 'bad_request': return 'rejected the request';
    case 'transport': return 'connection failed';
    case 'unknown': return 'failed';
    case undefined: case '': return 'failed';
    default: return reason.length > 60 ? `${reason.slice(0, 57)}…` : reason;
  }
}

const CSS = `
@keyframes pxc-fan-spin { to { transform: rotate(360deg); } }
@keyframes pxc-fan-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }

.pxc-fan {
  border: 1px solid var(--pxs-glass-border); border-radius: var(--a2ui-radius-lg);
  background: var(--a2ui-glass-dark); backdrop-filter: blur(8px);
  padding: var(--a2ui-space-3) var(--a2ui-space-4);
  display: flex; flex-direction: column; gap: var(--a2ui-space-3);
  animation: pxc-fan-in 250ms var(--a2ui-ease-entrance) both;
}

/* ── header: what this run IS (routing at a glance) ── */
.pxc-fan__head { display: flex; align-items: baseline; gap: var(--a2ui-space-2); min-width: 0; }
.pxc-fan__title {
  font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-semibold);
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--a2ui-text-tertiary);
}
.pxc-fan__plan { margin-left: auto; flex-shrink: 0; font-size: var(--a2ui-text-xs);
  color: var(--a2ui-text-tertiary); font-variant-numeric: tabular-nums; }

/* ── one row per model: the API call, made visible ── */
.pxc-fan__rows { display: flex; flex-direction: column; gap: var(--a2ui-space-3); }
.pxc-fan__row { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pxc-fan__row-head { display: flex; align-items: center; gap: var(--a2ui-space-2); min-width: 0; }
.pxc-fan__label { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pxc-fan__count { margin-left: auto; flex-shrink: 0; font-size: var(--a2ui-text-xs);
  color: var(--a2ui-text-tertiary); font-variant-numeric: tabular-nums; }

/* state glyphs */
.pxc-fan__glyph { flex-shrink: 0; width: 13px; height: 13px; display: inline-flex; align-items: center; justify-content: center; }
.pxc-fan__spin { width: 11px; height: 11px; border: 1.5px solid var(--a2ui-border-default);
  border-top-color: var(--a2ui-accent); border-radius: 50%; animation: pxc-fan-spin 0.8s linear infinite; }
.pxc-fan__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--a2ui-border-strong); }
.pxc-fan__skip { color: var(--a2ui-text-tertiary); font-size: 13px; line-height: 1; }
.pxc-fan__row[data-state="skipped"] { opacity: 0.6; }
.pxc-fan__glyph[data-state="done"] { color: var(--a2ui-success); }
.pxc-fan__glyph[data-state="failed"] { color: var(--a2ui-warning); }

/* progress — delivered / planned. A failed row's bar goes amber at whatever it reached. */
.pxc-fan__bar { height: 3px; border-radius: var(--a2ui-radius-full); background: var(--a2ui-bg-tertiary); overflow: hidden; }
.pxc-fan__fill { height: 100%; border-radius: inherit; background: var(--a2ui-accent);
  transition: width 400ms var(--a2ui-ease-entrance); }
.pxc-fan__row[data-state="done"] .pxc-fan__fill { background: var(--a2ui-success); }
.pxc-fan__row[data-state="failed"] .pxc-fan__fill { background: var(--a2ui-warning); }

/* the pick's WHY + the failure reason — the two things that make the run legible */
.pxc-fan__why { font-size: 11px; line-height: 1.45; color: var(--a2ui-text-tertiary);
  overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.pxc-fan__reason { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--a2ui-warning); }

/* ── footer tally ── */
.pxc-fan__foot { display: flex; align-items: center; gap: var(--a2ui-space-2);
  padding-top: var(--a2ui-space-2); border-top: 1px solid var(--a2ui-border-subtle);
  font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); font-variant-numeric: tabular-nums; }
.pxc-fan__foot[data-short="true"] { color: var(--a2ui-warning); }

/* ── simple mode: one line, expandable ── */
.pxc-fan__compact { display: flex; align-items: center; gap: var(--a2ui-space-2);
  font-size: var(--a2ui-text-sm); color: var(--a2ui-text-secondary); }
.pxc-fan__expand { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border: none; background: none; color: var(--a2ui-text-tertiary);
  cursor: pointer; border-radius: var(--a2ui-radius-sm); }
.pxc-fan__expand:hover { color: var(--a2ui-text-secondary); }
.pxc-fan__expand svg { width: 12px; height: 12px; transition: transform 0.2s ease; }
.pxc-fan__expand[data-open="true"] svg { transform: rotate(180deg); }

@media (prefers-reduced-motion: reduce) {
  .pxc-fan { animation: none; }
  .pxc-fan__spin { animation: none; }
  .pxc-fan__fill { transition: none; }
}
`;

function Check() {
  return (
    <svg viewBox="0 0 12 12" fill="none" width="12" height="12" aria-hidden="true">
      <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Warn() {
  return (
    <svg viewBox="0 0 12 12" fill="none" width="12" height="12" aria-hidden="true">
      <path d="M6 1.5 L11 10.5 L1 10.5 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 5 L6 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6" cy="9" r="0.6" fill="currentColor" />
    </svg>
  );
}

/** One model's row — the API call as a visible, honest unit of work (incl. benched models). */
function ModelRow({ f }: { f: FanModelStatus }) {
  const isSkipped = f.state === 'skipped';
  const pct = f.n > 0 ? Math.min(100, (f.delivered / f.n) * 100) : 0;
  const stateLabel =
    isSkipped ? 'skipped' : f.state === 'failed' ? 'failed' : f.state === 'done' ? 'done' : f.state === 'running' ? 'rendering' : 'queued';
  return (
    <div className="pxc-fan__row" data-state={f.state}>
      <div className="pxc-fan__row-head">
        <span className="pxc-fan__glyph" data-state={f.state} aria-label={stateLabel} title={stateLabel}>
          {isSkipped ? <span className="pxc-fan__skip">–</span> : f.state === 'done' ? <Check /> : f.state === 'failed' ? <Warn /> : f.state === 'running' ? <span className="pxc-fan__spin" /> : <span className="pxc-fan__dot" />}
        </span>
        <span className="pxc-fan__label" title={f.label}>{f.label}</span>
        <span className="pxc-fan__count">
          {isSkipped ? 'skipped' : `${f.delivered}/${f.n}${f.state === 'done' && f.ms != null ? ` · ${(f.ms / 1000).toFixed(1)}s` : ''}`}
        </span>
      </div>
      {!isSkipped && (
        <div className="pxc-fan__bar">
          <div className="pxc-fan__fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      {isSkipped ? (
        <span className="pxc-fan__why">{f.reason || 'not used for this render'}</span>
      ) : f.state === 'failed' ? (
        <span className="pxc-fan__reason"><Warn /> {plainReason(f.reason)}</span>
      ) : (
        f.why && <span className="pxc-fan__why">{f.why}</span>
      )}
    </div>
  );
}

export function FanStatus({ fan, generating, mode }: FanStatusProps) {
  const settingMode = useSettings((s) => s.loadingMode);
  const m = mode ?? settingMode;
  const [expanded, setExpanded] = useState(false);

  if (!Array.isArray(fan) || fan.length === 0) return null;

  const active = fan.filter((f) => f.state !== 'skipped');
  const planned = fan.reduce((s, f) => s + f.n, 0);
  const delivered = fan.reduce((s, f) => s + f.delivered, 0);
  const failed = fan.filter((f) => f.state === 'failed').length;
  const short = !generating && delivered < planned;

  const footer = generating
    ? `${delivered}/${planned} delivered`
    : failed > 0
      ? `${delivered}/${planned} — ${failed} model${failed === 1 ? '' : 's'} failed`
      : `${delivered}/${planned} delivered`;

  const card = (
    <div className="pxc-fan">
      <div className="pxc-fan__head">
        <span className="pxc-fan__title">Routing</span>
        <span className="pxc-fan__plan">
          {active.length} model{active.length === 1 ? '' : 's'} · {planned} image{planned === 1 ? '' : 's'} planned
        </span>
      </div>
      <div className="pxc-fan__rows">
        {fan.map((f) => (
          <ModelRow key={f.modelId || f.label} f={f} />
        ))}
      </div>
      <div className="pxc-fan__foot" data-short={short ? 'true' : 'false'}>
        {generating ? <span className="pxc-fan__spin" /> : failed > 0 ? <Warn /> : <Check />}
        {footer}
      </div>
    </div>
  );

  // SIMPLE: one calm line — but a failure is never hidden, it shows in the line itself.
  if (m === 'simple' && !expanded) {
    return (
      <>
        <style>{CSS}</style>
        <div className="pxc-fan__compact" role="status" aria-live="polite">
          {generating ? <span className="pxc-fan__spin" /> : failed > 0 ? <Warn /> : <Check />}
          <span>
            {active.length} model{active.length === 1 ? '' : 's'} · {footer}
          </span>
          <button
            type="button"
            className="pxc-fan__expand"
            data-open="false"
            onClick={() => setExpanded(true)}
            title="Show each model"
            aria-label="Show each model"
          >
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div role="status" aria-live="polite">
        {card}
        {m === 'simple' && (
          <button
            type="button"
            className="pxc-fan__expand"
            data-open="true"
            onClick={() => setExpanded(false)}
            title="Collapse"
            aria-label="Collapse model list"
          >
            <Icon name="chevron-down" size={12} />
          </button>
        )}
      </div>
    </>
  );
}

export default FanStatus;
