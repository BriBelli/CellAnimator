'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * BuilderPanel — the STRUCTURED CONSULT, rendered in the center stage (PR-10a).
 *
 * The specialist's consult is no longer prose in the chat — it's this: the prompt FORMULA broken
 * into parts (Subject / Action / Context / Composition / Style, agent-defined), each with guidance,
 * an editable value, and agent-SUGGESTED anchor chips. The user shapes it — tap suggestions, free-type
 * their own ("never a cage": every part has a free-type escape) — then hits Render, which assembles
 * the parts into the prompt and hands off to the image agent to generate.
 *
 * This is a DUMB renderer: every part, chip, and value is agent-emitted (see A2UIBuilderBlock). No
 * code decides content. Scoring, color-coded assembly, and the standalone Prompt Guide are later
 * phases (PR-10b/c/d); this is the structure working.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from 'react';
import { Button, Icon, IconButton } from '../ui';
import type { A2UIBuilderBlock } from '../../store/chat-turns-store';
import { bandLabel, STRUCTURE_CAP, type ScoreBand, type BuilderScore } from '../../lib/prompt-score';
import type { CraftResult } from '../../lib/agents/model-agent/craft-critique';
import type { CraftRollup } from '../../lib/agents/model-agent/craft-rollup';
import type { CompiledPrompt } from '../../lib/engine/prompt-compile';
import type { SlotRole } from '../../lib/engine/model-registry';

/** The roles a user can assign to an attached reference (the subset worth offering by hand). */
type ReferenceRole = Extract<SlotRole, 'general' | 'character' | 'style' | 'object'>;
const ROLE_LABEL: Record<ReferenceRole, string> = {
  general: 'a general reference',
  character: 'the character to keep consistent',
  style: 'the style to apply',
  object: 'an object to reproduce',
};
/** Two letters, because the control lives on a 52px thumbnail. */
const ROLE_SHORT: Record<ReferenceRole, string> = { general: 'REF', character: 'CHR', style: 'STY', object: 'OBJ' };

export interface BuilderPanelProps {
  block: A2UIBuilderBlock;
  /** Controlled part values — LIFTED to ChatView so the center color-coded prompt and this panel
   *  share one source (two-way binding). Keyed by part id. */
  values: Record<string, string>;
  /** The live STRUCTURE score (completeness of this model's formula parts) — computed once in
   *  ChatView and shared with the center prompt. Capped: structure alone can't mean "good". */
  score: BuilderScore;
  /** The CRAFT critique — the earned score, judged against the model's own doctrine. Null until the
   *  user asks for it; `available: false` when the model has no distilled doctrine yet (shown as
   *  such, never faked). */
  craft?: CraftResult | null;
  /** Request a craft critique for the ACTIVE lens only (one call). */
  onCritique?: () => void;
  /** Request critiques across the whole fan + the rollup (N calls — user-initiated). */
  onCritiqueAll?: () => void;
  /** True while a critique is in flight. */
  critiquing?: boolean;
  /** THE FAN — every model this prompt will be sent to. One entry = no lens strip. */
  lenses?: CompiledPrompt[];
  /** Which lens is being viewed. Undefined → the lead (the brief itself). */
  activeLensId?: string;
  onSelectLens?: (modelId: string) => void;
  /** Per-model craft scores for the strip chips. */
  lensScores?: Record<string, number>;
  /** Cross-model findings: universal vs model-specific. */
  rollup?: CraftRollup | null;
  /** Revert a diverged lens back to the shared brief. */
  onRevertLens?: (modelId: string) => void;
  /** Update a part's value (the single source of truth lives in ChatView). */
  onValueChange: (id: string, value: string) => void;
  /** The Agent's most recent part edit (the COUPLING) — flashes + scrolls that part into view. */
  highlight?: { id: string; n: number } | null;
  /** Assemble → generate: hands the composed prompt + attached references to the image agent. */
  onRender: (prompt: string, references: string[], referenceRoles?: ReferenceRole[]) => void;
  /** Why rendering is unavailable right now (budget exhausted). Absent → rendering is allowed.
   *  Stated rather than silently disabling a button: an inert control with no reason is the worst
   *  version of this, because the user cannot tell whether it is broken or they are blocked. */
  budgetBlock?: string | null;
  /** Disable Render while a generation is already in flight. */
  busy?: boolean;
  /** Rehydrate the attached references on reload (Slice 2) — the persisted in-state upload assets. */
  initialRefs?: string[];
}

const CSS = `
.pxc-build { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: var(--a2ui-space-6); background: var(--a2ui-bg-app); }
.pxc-build-inner { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--a2ui-space-3); }
.pxc-build-title { font-size: var(--a2ui-text-lg); font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-primary); letter-spacing: -0.01em; margin-bottom: var(--a2ui-space-1); }
.pxc-build-title span { color: var(--a2ui-text-tertiary); font-weight: var(--a2ui-font-normal); }

/* Score header — the quality ring builds up as parts fill (the Guide, in motion). */
.pxc-build-score { display: flex; align-items: center; gap: var(--a2ui-space-3);
  background: var(--a2ui-bg-secondary); border: 1px solid var(--pxs-border-subtle);
  border-radius: 14px; padding: var(--a2ui-space-4) var(--a2ui-space-5); }
.pxc-ring { flex-shrink: 0; }
.pxc-ring-track { stroke: var(--a2ui-bg-tertiary); }
.pxc-ring-fill { transition: stroke-dashoffset var(--a2ui-transition-normal), stroke var(--a2ui-transition-normal); stroke-linecap: round; }
.pxc-ring-num { font-size: var(--a2ui-text-md); font-weight: var(--a2ui-font-semibold); fill: var(--a2ui-text-primary); }
.pxc-build-score-title { font-size: var(--a2ui-text-md); font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-primary); }
.pxc-build-score-sub { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); }
.pxc-build-score-model { margin-left: auto; text-align: right; font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); max-width: 45%; }
/* Icon actions, sitting with the score. Subtle-filled so they're findable at a glance (the original
   ghost link was invisible) while Render keeps the only filled-accent treatment in the panel. */
.pxc-review { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-shrink: 0; }

.pxc-part-head { display: flex; align-items: center; gap: var(--a2ui-space-2); }
.pxc-lens-strip { display: flex; gap: var(--a2ui-space-2); overflow-x: auto; padding: 2px 2px var(--a2ui-space-2);
  margin: var(--a2ui-space-3) 0 var(--a2ui-space-2); scrollbar-width: none; }
.pxc-lens-strip::-webkit-scrollbar { display: none; }
/* Chips must LOOK tappable: a filled surface + a real border. As bare text on the panel background
   they read as a caption and get missed entirely. */
.pxc-lens { flex: 0 0 auto; display: flex; align-items: center; gap: var(--a2ui-space-2);
  padding: 7px 12px; border-radius: var(--a2ui-radius-full, 999px);
  border: 1px solid var(--pxs-border-subtle, var(--a2ui-border));
  background: var(--a2ui-bg-secondary); font-size: var(--a2ui-text-sm);
  color: var(--a2ui-text-secondary); white-space: nowrap; cursor: pointer; transition: all .15s ease; }
.pxc-lens:hover { border-color: var(--a2ui-accent); color: var(--a2ui-text-primary); transform: translateY(-1px); }
.pxc-lens-active { border-color: var(--a2ui-accent); color: var(--a2ui-text-primary);
  box-shadow: 0 0 0 1px var(--a2ui-accent) inset; }
.pxc-lens-name { font-weight: var(--a2ui-font-medium); }
/* The score reads as a badge ON the chip, not as loose digits beside the name. */
.pxc-lens-score { font-variant-numeric: tabular-nums; font-size: var(--a2ui-text-xs);
  font-weight: var(--a2ui-font-semibold); padding: 1px 7px; border-radius: 999px;
  background: var(--a2ui-bg-tertiary, rgba(255,255,255,0.07)); color: var(--a2ui-text-secondary); }
.pxc-lens-active .pxc-lens-score { background: var(--a2ui-accent); color: #fff; }
.pxc-lens-pin { color: var(--a2ui-accent); font-size: 16px; line-height: 1; }
.pxc-rollup { display: flex; flex-direction: column; gap: var(--a2ui-space-2); margin: var(--a2ui-space-2) 0;
  padding: var(--a2ui-space-3); border: 1px solid var(--a2ui-border); border-radius: var(--a2ui-radius-md, 10px); }
.pxc-rollup-row { display: flex; gap: var(--a2ui-space-2); font-size: var(--a2ui-text-sm);
  color: var(--a2ui-text-secondary); line-height: 1.45; }
.pxc-rollup-count { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-size: var(--a2ui-text-xs);
  color: var(--a2ui-text-tertiary); padding-top: 2px; }
.pxc-diverged { display: flex; align-items: center; gap: var(--a2ui-space-2); font-size: var(--a2ui-text-xs);
  color: var(--a2ui-text-tertiary); margin-bottom: var(--a2ui-space-2); }
.pxc-revert { font-size: var(--a2ui-text-xs); color: var(--a2ui-accent); text-decoration: underline; cursor: pointer; background: none; border: none; padding: 0; }
/* The review reads like a document, not a log line: capped height with its own scroll so it never
   pushes the prompt fields off-screen, and dismissible — it had no close affordance at all. */
.pxc-craft { margin: var(--a2ui-space-3) 0; border: 1px solid var(--pxs-border-subtle, var(--a2ui-border));
  border-radius: 14px; background: var(--a2ui-bg-secondary); overflow: hidden; }
.pxc-craft-bar { display: flex; align-items: center; gap: var(--a2ui-space-2);
  padding: var(--a2ui-space-3) var(--a2ui-space-4);
  border-bottom: 1px solid var(--pxs-border-subtle, var(--a2ui-border)); }
.pxc-craft-bar-title { font-size: var(--a2ui-text-sm); font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-primary); }
.pxc-craft-bar-sub { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); }
.pxc-craft-close { margin-left: auto; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 7px; border: none; background: transparent;
  color: var(--a2ui-text-tertiary); cursor: pointer; }
.pxc-craft-close:hover { background: var(--a2ui-bg-tertiary, rgba(255,255,255,0.06)); color: var(--a2ui-text-primary); }
.pxc-craft-body { max-height: 42vh; overflow-y: auto; padding: var(--a2ui-space-4);
  display: flex; flex-direction: column; gap: var(--a2ui-space-4); }
.pxc-craft-verdict { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-secondary); line-height: 1.6; }
.pxc-craft-finding { border-left: 3px solid var(--a2ui-border); padding: 2px 0 2px var(--a2ui-space-4);
  display: flex; flex-direction: column; gap: 7px; }
.pxc-craft-blocking { border-left-color: var(--a2ui-danger, #e5484d); }
.pxc-craft-weak { border-left-color: var(--a2ui-warning); }
.pxc-craft-polish { border-left-color: var(--a2ui-border); }
.pxc-craft-head { display: flex; gap: var(--a2ui-space-2); align-items: center; }
.pxc-craft-sev { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: var(--a2ui-font-semibold);
  padding: 2px 7px; border-radius: 5px; background: var(--a2ui-bg-tertiary, rgba(255,255,255,0.07)); color: var(--a2ui-text-secondary); }
.pxc-craft-blocking .pxc-craft-sev { background: color-mix(in srgb, var(--a2ui-danger, #e5484d) 18%, transparent); color: var(--a2ui-danger, #e5484d); }
.pxc-craft-weak .pxc-craft-sev { background: color-mix(in srgb, var(--a2ui-warning) 18%, transparent); color: var(--a2ui-warning); }
.pxc-craft-part { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-secondary); }
.pxc-craft-issue { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-primary); line-height: 1.6; }
.pxc-craft-fix { font-size: var(--a2ui-text-sm); color: var(--a2ui-accent); line-height: 1.6; }
.pxc-craft-src { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); font-style: italic; line-height: 1.55; }
.pxc-build-blocked { font-size: var(--a2ui-text-sm); color: var(--a2ui-danger, #e5484d); line-height: 1.5;
  padding: var(--a2ui-space-3); border-radius: 10px; margin-bottom: var(--a2ui-space-3);
  border: 1px solid color-mix(in srgb, var(--a2ui-danger, #e5484d) 35%, transparent); }
.pxc-craft-reopen { margin: var(--a2ui-space-2) 0; padding: 9px 14px; width: 100%; text-align: left;
  border-radius: 10px; border: 1px dashed var(--pxs-border-subtle, var(--a2ui-border));
  background: transparent; color: var(--a2ui-text-tertiary); font-size: var(--a2ui-text-sm); cursor: pointer; }
.pxc-craft-reopen:hover { color: var(--a2ui-text-primary); border-color: var(--a2ui-accent); }
.pxc-craft-strengths { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); line-height: 1.55;
  padding-top: var(--a2ui-space-2); border-top: 1px solid var(--pxs-border-subtle, var(--a2ui-border)); }
.pxc-craft-none { margin: var(--a2ui-space-3) 0; font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); line-height: 1.5; }
.pxc-band { margin-left: auto; font-size: 10px; letter-spacing: 0.06em; font-weight: var(--a2ui-font-semibold);
  padding: 3px 9px; border-radius: var(--a2ui-radius-full); text-transform: uppercase; }
.pxc-band-strong { background: var(--a2ui-success-bg); color: var(--a2ui-success); }
.pxc-band-good { background: var(--a2ui-accent-subtle); color: var(--a2ui-text-secondary); }
.pxc-band-thin { background: var(--a2ui-warning-bg); color: var(--a2ui-warning); }

/* Each part is a CARD — grouped, tight, scannable (no big gaps between loose form elements). */
.pxc-part { display: flex; flex-direction: column; gap: var(--a2ui-space-2);
  background: var(--a2ui-bg-secondary); border: 1px solid var(--pxs-border-subtle);
  border-radius: 14px; padding: var(--a2ui-space-4) var(--a2ui-space-5); }
/* The Agent just edited this part (coupling) — a brief accent pulse. */
@keyframes pxc-part-flash { 0% { box-shadow: 0 0 0 2px var(--a2ui-accent); background: var(--a2ui-accent-subtle); }
  100% { box-shadow: 0 0 0 0 transparent; background: var(--a2ui-bg-secondary); } }
.pxc-part-flash { animation: pxc-part-flash 1.5s ease-out; }
@media (prefers-reduced-motion: reduce) { .pxc-part-flash { animation: none; } }
.pxc-part-label { font-size: var(--a2ui-text-xs); text-transform: uppercase; letter-spacing: 0.05em; font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-secondary); }
.pxc-part-guide { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); line-height: var(--a2ui-leading-tight); margin-top: -2px; }
.pxc-part-field { width: 100%; min-height: 36px; resize: vertical; border-radius: var(--a2ui-radius-md);
  background: var(--a2ui-bg-input); border: 1px solid var(--a2ui-border-default);
  padding: var(--a2ui-space-2) var(--a2ui-space-3); color: var(--a2ui-text-primary);
  font-family: var(--a2ui-font-family); font-size: var(--a2ui-text-md); line-height: var(--a2ui-leading-normal); outline: none;
  transition: border-color var(--a2ui-transition-fast), box-shadow var(--a2ui-transition-fast); }
.pxc-part-field:focus { border-color: var(--a2ui-accent); box-shadow: 0 0 0 2px var(--a2ui-accent-subtle); }
/* The recommendation shows as a DIM, italic placeholder — clearly a suggestion, not the value. */
.pxc-part-field::placeholder { color: var(--a2ui-text-disabled); font-style: italic; opacity: 1; }

.pxc-chips { display: flex; flex-wrap: wrap; gap: var(--a2ui-space-2); align-items: center; }
/* Active anchor (selected/added) — accent-tinted, removable. */
.pxc-anchor { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px 0 11px;
  border-radius: var(--a2ui-radius-full); font-size: var(--a2ui-text-sm); font-family: var(--a2ui-font-family);
  background: var(--a2ui-accent-subtle); color: var(--a2ui-text-primary); border: 1px solid var(--a2ui-accent); }
.pxc-anchor button { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  border: none; background: none; color: var(--a2ui-text-tertiary); cursor: pointer; border-radius: var(--a2ui-radius-full); }
.pxc-anchor button:hover { color: var(--a2ui-text-primary); background: var(--a2ui-bg-hover); }
/* Suggested chip (not yet added) — quiet, tap to add. */
.pxc-suggest { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 11px;
  border-radius: var(--a2ui-radius-full); font-size: var(--a2ui-text-sm); font-family: var(--a2ui-font-family);
  background: var(--a2ui-bg-tertiary); color: var(--a2ui-text-secondary); border: 1px solid var(--pxs-border-subtle);
  cursor: pointer; transition: background var(--a2ui-transition-fast), color var(--a2ui-transition-fast), border-color var(--a2ui-transition-fast); }
.pxc-suggest:hover { background: var(--a2ui-bg-elevated); color: var(--a2ui-text-primary); border-color: var(--a2ui-border-default); }
.pxc-suggest > svg { color: var(--a2ui-text-tertiary); }
/* Free-type escape — never a cage. */
.pxc-add { height: 28px; min-width: 120px; flex: 1; max-width: 220px; border-radius: var(--a2ui-radius-full);
  background: transparent; border: 1px dashed var(--pxs-border-subtle); padding: 0 12px;
  color: var(--a2ui-text-primary); font-family: var(--a2ui-font-family); font-size: var(--a2ui-text-sm); outline: none; }
.pxc-add::placeholder { color: var(--a2ui-text-tertiary); }
.pxc-add:focus { border-style: solid; border-color: var(--a2ui-accent); }

.pxc-build-refs { display: flex; flex-direction: column; gap: var(--a2ui-space-2);
  background: var(--a2ui-bg-secondary); border: 1px solid var(--pxs-border-subtle);
  border-radius: 14px; padding: var(--a2ui-space-4) var(--a2ui-space-5); }
.pxc-build-refs-head { display: flex; align-items: baseline; gap: var(--a2ui-space-2); }
.pxc-build-refs-model { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); }
.pxc-build-drop { display: flex; align-items: center; gap: var(--a2ui-space-2); height: 44px; padding: 0 var(--a2ui-space-3);
  border-radius: var(--a2ui-radius-md); border: 1px dashed var(--a2ui-border-default); background: var(--a2ui-bg-secondary);
  color: var(--a2ui-text-secondary); font-size: var(--a2ui-text-sm); font-family: var(--a2ui-font-family); cursor: pointer;
  transition: border-color var(--a2ui-transition-fast), background var(--a2ui-transition-fast); }
.pxc-build-drop:hover { border-color: var(--a2ui-accent); background: var(--a2ui-bg-hover); }
.pxc-build-supports { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); }
.pxc-build-thumbs { display: flex; flex-wrap: wrap; gap: var(--a2ui-space-2); }
.pxc-build-thumb { position: relative; width: 52px; height: 52px; border-radius: var(--a2ui-radius-md); overflow: hidden;
  box-shadow: 0 0 0 1px var(--pxs-border-subtle); }
.pxc-build-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pxc-thumb-role { position: absolute; left: 0; right: 0; bottom: 0; height: 15px; border: none; cursor: pointer;
  font-size: 8px; font-weight: var(--a2ui-font-semibold); letter-spacing: 0.06em;
  background: rgba(0,0,0,0.62); color: var(--a2ui-text-tertiary); }
.pxc-thumb-role[data-role='character'], .pxc-thumb-role[data-role='style'], .pxc-thumb-role[data-role='object'] { color: var(--a2ui-accent); }
.pxc-thumb-role:hover { background: rgba(0,0,0,0.8); color: var(--a2ui-text-primary); }
.pxc-build-thumb .pxc-thumb-x { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border: none; border-radius: var(--a2ui-radius-full);
  background: var(--a2ui-glass-dark); backdrop-filter: blur(6px); color: var(--a2ui-text-primary); cursor: pointer;
  display: flex; align-items: center; justify-content: center; }

.pxc-build-foot { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: var(--a2ui-space-3);
  padding-top: var(--a2ui-space-3); }
`;

/** The quality ring — a stroke arc that fills to `value`%, colored by band. */
/** "Nano Banana Pro (Gemini 3 Pro Image)" → "Nano Banana Pro"; then clipped for the chip. */
function shortModel(label: string): string {
  const base = label.split('(')[0].trim();
  return base.length > 14 ? `${base.slice(0, 13)}…` : base;
}

function QualityRing({ value, band }: { value: number; band: ScoreBand }) {
  const r = 19;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circ * (1 - clamped / 100);
  const color = band === 'strong' ? 'var(--a2ui-success)' : band === 'thin' ? 'var(--a2ui-warning)' : 'var(--a2ui-accent)';
  return (
    <svg className="pxc-ring" width={46} height={46} viewBox="0 0 46 46" aria-hidden="true">
      <g transform="rotate(-90 23 23)">
        <circle className="pxc-ring-track" cx={23} cy={23} r={r} fill="none" strokeWidth={4} />
        <circle
          className="pxc-ring-fill"
          cx={23}
          cy={23}
          r={r}
          fill="none"
          strokeWidth={4}
          stroke={color}
          strokeDasharray={circ}
          strokeDashoffset={offset}
        />
      </g>
      <text className="pxc-ring-num" x={23} y={23} dominantBaseline="central" textAnchor="middle">
        {clamped}
      </text>
    </svg>
  );
}

export function BuilderPanel({
  block, values, score, craft, onCritique, onCritiqueAll, critiquing, lenses, activeLensId,
  onSelectLens, lensScores, rollup, onRevertLens, onValueChange, highlight, onRender, busy,
  initialRefs, budgetBlock,
}: BuilderPanelProps) {
  // Values are CONTROLLED (owned by ChatView, shared with the center prompt). A chip APPENDS to the
  // field (comma-joined, de-duped); typing edits directly. The recommendation is the placeholder.
  const [refs, setRefs] = useState<string[]>(() => initialRefs ?? []);
  /** What each attached image is FOR, index-aligned with `refs`. This is the fact that decides
   *  whether a reference works: a face tagged `character` reaches Ideogram's character channel and
   *  is named as the character in Gemini's/FLUX's prompt, instead of being read as a mood board.
   *  Defaults to 'general' so attaching without thinking behaves exactly as it always has. */
  const [refRoles, setRefRoles] = useState<ReferenceRole[]>(() => (initialRefs ?? []).map(() => 'general'));
  const cycleRole = (i: number) =>
    setRefRoles((r) => {
      const next = [...r];
      const order: ReferenceRole[] = ['general', 'character', 'style', 'object'];
      next[i] = order[(order.indexOf(next[i] ?? 'general') + 1) % order.length];
      return next;
    });

  // THE COUPLING (visual): when the Agent edits a part, flash it + scroll it into view so you SEE
  // the change land. `highlight.n` bumps every edit, so re-editing the same part re-triggers.
  const [flashPart, setFlashPart] = useState<string | null>(null);
  useEffect(() => {
    if (!highlight) return;
    setFlashPart(highlight.id);
    document.getElementById(`pxc-field-${highlight.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setFlashPart(null), 1500);
    return () => clearTimeout(t);
  }, [highlight?.n, highlight?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasChip = (id: string, chip: string) =>
    (values[id] ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(chip.trim().toLowerCase());
  const addChip = (id: string, chip: string) => {
    const t = chip.trim();
    if (!t || hasChip(id, t)) return;
    const cur = (values[id] ?? '').trim();
    onValueChange(id, cur ? `${cur}, ${t}` : t);
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === 'string' ? reader.result : '';
        if (url) {
          setRefs((r) => [...r, url]);
          setRefRoles((r) => [...r, 'general']);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  /** Compose the prompt — each part's field value, comma-joined in order. */
  const assemble = () => block.parts.map((p) => (values[p.id] ?? '').trim()).filter(Boolean).join(', ');

  /** Is the craft review expanded? A fresh review opens itself; the user can dismiss it and reopen
   *  from the summary line without re-running (and re-paying for) it. */
  const [craftOpen, setCraftOpen] = useState(true);
  useEffect(() => {
    if (craft?.available) setCraftOpen(true);
  }, [craft]);

  /** The lens being viewed (the lead/brief by default). */
  const activeLens = lenses?.find((l) => l.modelId === (activeLensId ?? lenses?.[0]?.modelId));
  /** A part's label for rollup rows — the lead formula's wording. */
  const partLabel = (id: string): string => (id ? (block.parts.find((p) => p.id === id)?.label ?? id) : 'Overall');

  const bandOfPart = (id: string): ScoreBand => score.parts.find((s) => s.id === id)?.band ?? 'thin';
  /** Why a part reads thin — so a band is never an unexplained verdict. */
  const reasonOfPart = (id: string): string | undefined => score.parts.find((s) => s.id === id)?.reason;

  const maxRefs = block.model?.maxReferences ?? 0;
  const canRender = !busy && !budgetBlock && assemble().length > 0;

  return (
    <div className="pxc-build relative flex-1 min-w-0">
      <style>{CSS}</style>
      <div className="pxc-build-inner">
        {/* TWO AXES, honestly labelled. The ring shows STRUCTURE (completeness of this model's
            formula parts, capped at STRUCTURE_CAP) until a CRAFT critique has been earned — at which
            point it shows the judged score and the findings below say why. A number the user can't
            interrogate is a lie, so nothing here claims quality without receipts. */}
        <div className="pxc-build-score">
          <QualityRing
            value={craft?.available ? craft.score : score.overall}
            band={craft?.available ? (craft.score >= 80 ? 'strong' : craft.score >= 55 ? 'good' : 'thin') : score.overallBand}
          />
          <div>
            <div className="pxc-build-score-title">{craft?.available ? 'Prompt craft' : 'Prompt structure'}</div>
            <div className="pxc-build-score-sub">
              {craft?.available
                ? `Judged against ${craft.modelLabel.split('(')[0].trim()}'s guide`
                : `${bandLabel(score.overallBand)} · ${score.filled}/${score.total} parts · structure only (max ${STRUCTURE_CAP})`}
            </div>
          </div>
          {onCritique && (
            <div className="pxc-review">
              {/* Icon actions — the LABEL carries the affordance, so each one names the model and what
                  it will actually do. Subtle (not primary): Render owns the filled treatment. */}
              <IconButton
                /* The graduation cap is EARNED: it appears only once this prompt has been graded and
                   cleared the strong band (same 80 the ring uses). Everything else shows the study
                   icon — a promise of the check, not a claim of having passed it. */
                icon={craft?.available && craft.score >= 80 ? 'graduation-cap' : 'book-open-check'}
                variant="subtle"
                boxSize={34}
                size={15}
                loading={critiquing}
                disabled={critiquing || assemble().length === 0}
                onClick={() => { setCraftOpen(true); onCritique(); }}
                label={
                  craft?.available
                    ? `Grade this prompt again against ${shortModel(block.model?.label ?? 'the model')}'s guide`
                    : `Grade this prompt against ${shortModel(block.model?.label ?? 'the model')}'s own published guide`
                }
              />
              {onCritiqueAll && lenses && lenses.length > 1 && (
                <IconButton
                  icon="book-copy"
                  variant="subtle"
                  boxSize={34}
                  size={15}
                  disabled={critiquing || assemble().length === 0}
                  onClick={() => { setCraftOpen(true); onCritiqueAll(); }}
                  // The value here isn't "review N times" — it's the COMPARISON: which weaknesses every
                  // model flags (fix once) versus which are one model's quirk. Name the payoff.
                  label={`Compare across all ${lenses.length} models — find what they all flag`}
                />
              )}
            </div>
          )}
        </div>

        {/* The critique itself — the reasons, the fixes, and where each came from. This is the part
            that makes the number mean something; without it the ring is theatre. */}
        {craft?.available && craftOpen && (
          <div className="pxc-craft">
            <div className="pxc-craft-bar">
              <div>
                <div className="pxc-craft-bar-title">Craft review · {craft.score}</div>
                <div className="pxc-craft-bar-sub">
                  {craft.findings.length === 0
                    ? `No issues against ${shortModel(craft.modelLabel)}'s guide`
                    : `${craft.findings.length} finding${craft.findings.length === 1 ? '' : 's'} · ${shortModel(craft.modelLabel)}'s guide`}
                </div>
              </div>
              <button type="button" className="pxc-craft-close" onClick={() => setCraftOpen(false)} title="Close the review">
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="pxc-craft-body">
            {craft.verdict && <div className="pxc-craft-verdict">{craft.verdict}</div>}
            {craft.findings.map((f, i) => (
              <div key={i} className={`pxc-craft-finding pxc-craft-${f.severity}`}>
                <div className="pxc-craft-head">
                  <span className="pxc-craft-sev">{f.severity}</span>
                  {f.partId && <span className="pxc-craft-part">{block.parts.find((p) => p.id === f.partId)?.label ?? f.partId}</span>}
                </div>
                <div className="pxc-craft-issue">{f.issue}</div>
                <div className="pxc-craft-fix">→ {f.fix}</div>
                {f.groundedIn && <div className="pxc-craft-src">per {craft.modelLabel.split('(')[0].trim()}: “{f.groundedIn}”</div>}
              </div>
            ))}
            {craft.strengths.length > 0 && (
              <div className="pxc-craft-strengths">Working: {craft.strengths.join(' · ')}</div>
            )}
            {craft.sources.length > 0 && (
              <div className="pxc-craft-src">
                Grounded in {craft.sources.length} official source{craft.sources.length === 1 ? '' : 's'}
                {craft.doctrineConfidence !== 'high' ? ` · ${craft.doctrineConfidence} confidence` : ''}
              </div>
            )}
            </div>
          </div>
        )}
        {/* Closed but still current — one click back in, without paying for another review. */}
        {craft?.available && !craftOpen && (
          <button type="button" className="pxc-craft-reopen" onClick={() => setCraftOpen(true)}>
            Show craft review · {craft.score}
            {craft.findings.length > 0 ? ` · ${craft.findings.length} finding${craft.findings.length === 1 ? '' : 's'}` : ''}
          </button>
        )}
        {craft && !craft.available && craft.reason === 'no_doctrine' && (
          <div className="pxc-craft-none">
            No craft score yet — {craft.modelLabel.split('(')[0].trim()}&apos;s prompting guide hasn&apos;t been distilled.
            Structure only until it has.
          </div>
        )}

        {/* THE LENS STRIP — one brief, N models. Each chip is a VIEW of the same document compiled
            into that model's real formula, never a separate editor: authoring five prompts to get one
            image is the trap. Horizontally scrollable because 5 tabs cannot fit this panel without
            truncating names to "Ide…". Hidden entirely for a single-model fan. */}
        {lenses && lenses.length > 1 && (
          <div className="pxc-lens-strip">
            {lenses.map((lens, i) => {
              const active = (activeLensId ?? lenses[0].modelId) === lens.modelId;
              const s = lensScores?.[lens.modelId];
              return (
                <button
                  key={lens.modelId}
                  className={`pxc-lens${active ? ' pxc-lens-active' : ''}`}
                  onClick={() => onSelectLens?.(lens.modelId)}
                  title={`${lens.modelLabel}${i === 0 ? ' — the brief' : lens.identical ? '' : ' — recompiled to its formula'}`}
                >
                  <span className="pxc-lens-name">{shortModel(lens.modelLabel)}</span>
                  {typeof s === 'number' && <span className="pxc-lens-score">{s}</span>}
                  {lens.diverged && <span className="pxc-lens-pin" title="Diverged from the brief">•</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* THE ROLLUP — the thing only a fan can tell you: which problems every model flags (fix once,
            everything improves) versus which are one model's compile detail. */}
        {rollup && rollup.judged.length > 1 && (
          <div className="pxc-rollup">
            {rollup.universal.length > 0 ? (
              rollup.universal.slice(0, 3).map((f, i) => (
                <div key={i} className="pxc-rollup-row">
                  <span className="pxc-rollup-count">
                    {f.modelIds.length}/{rollup.judged.length}
                  </span>
                  <span>
                    <strong>{partLabel(f.partId)}</strong> {f.issue} <span className="pxc-craft-fix">→ {f.fix}</span>
                  </span>
                </div>
              ))
            ) : (
              <div className="pxc-rollup-row">
                <span className="pxc-rollup-count">✓</span>
                <span>No shared weaknesses across {rollup.judged.length} models — remaining notes are model-specific.</span>
              </div>
            )}
            {rollup.unavailable.length > 0 && (
              <div className="pxc-craft-src">
                No doctrine yet for {rollup.unavailable.map((u) => shortModel(u.modelLabel)).join(', ')} — not judged.
              </div>
            )}
          </div>
        )}

        {/* A diverged lens is showing this model's OWN values, not the shared brief. Always reversible. */}
        {activeLens?.diverged && (
          <div className="pxc-diverged">
            Overridden for {shortModel(activeLens.modelLabel)} only.
            <button className="pxc-revert" onClick={() => onRevertLens?.(activeLens.modelId)}>
              Revert to brief
            </button>
          </div>
        )}
        {activeLens && !activeLens.identical && activeLens.notes.length > 0 && (
          <div className="pxc-craft-src">{activeLens.notes[0]}</div>
        )}

        {/* References — ABOVE THE FOLD: the most-promoted control, so it sits right under the score,
            not buried below the parts. Always offered; the chosen model's facts enrich it. */}
        <div className="pxc-build-refs">
          <div className="pxc-build-refs-head">
            <div className="pxc-part-label">References</div>
            {block.model && <div className="pxc-build-refs-model">{block.model.label}</div>}
          </div>
          <label className="pxc-build-drop">
            <Icon name="paperclip" size={15} />
            {maxRefs > 0 ? `Attach — up to ${maxRefs}` : 'Attach references'}
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                onFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          {refs.length > 0 && (
            <div className="pxc-build-thumbs">
              {refs.map((src, i) => {
                const role = refRoles[i] ?? 'general';
                return (
                  <span key={i} className="pxc-build-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="reference" />
                    <button
                      type="button"
                      aria-label="Remove"
                      className="pxc-thumb-x"
                      onClick={() => {
                        setRefs((r) => r.filter((_, j) => j !== i));
                        setRefRoles((r) => r.filter((_, j) => j !== i));
                      }}
                    >
                      <Icon name="x" size={11} />
                    </button>
                    {/* Tap to say what this image is for. One control, cycling — a dropdown per
                        thumbnail would dominate a 52px tile. */}
                    <button
                      type="button"
                      className="pxc-thumb-role"
                      data-role={role}
                      onClick={() => cycleRole(i)}
                      title={`Used as: ${ROLE_LABEL[role]} — tap to change`}
                    >
                      {ROLE_SHORT[role]}
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {block.model && block.model.supports.length > 0 && (
            <div className="pxc-build-supports">Supports: {block.model.supports.join(' · ')}</div>
          )}
        </div>

        {block.parts.map((part) => {
          // Recommendation = the PLACEHOLDER; chips not already in the value are still offered.
          const suggestions = part.chips.filter((c) => !hasChip(part.id, c));
          return (
            <div key={part.id} className={`pxc-part${flashPart === part.id ? ' pxc-part-flash' : ''}`}>
              <div className="pxc-part-head">
                <div className="pxc-part-label">{part.label}</div>
                <span className={`pxc-band pxc-band-${bandOfPart(part.id)}`} title={reasonOfPart(part.id) ?? ''}>
                  {bandOfPart(part.id)}
                </span>
              </div>
              {part.guidance && <div className="pxc-part-guide">{part.guidance}</div>}
              <textarea
                id={`pxc-field-${part.id}`}
                className="pxc-part-field"
                rows={2}
                value={values[part.id] ?? ''}
                placeholder={part.recommend || `Describe the ${part.label.toLowerCase()}…`}
                onChange={(e) => onValueChange(part.id, e.target.value)}
                // TAB on an empty field accepts the recommendation (the placeholder) — the seed of
                // type-ahead / IntelliSense. Non-empty fields Tab normally (move focus).
                onKeyDown={(e) => {
                  if (e.key === 'Tab' && !e.shiftKey && !(values[part.id] ?? '').trim() && part.recommend) {
                    e.preventDefault();
                    onValueChange(part.id, part.recommend);
                  }
                }}
              />
              {suggestions.length > 0 && (
                <div className="pxc-chips">
                  {suggestions.map((c) => (
                    <button key={c} type="button" className="pxc-suggest" onClick={() => addChip(part.id, c)}>
                      <Icon name="plus" size={12} /> {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="pxc-build-foot">
          <Button variant="primary" size="md" type="button" disabled={!canRender} onClick={() => onRender(assemble(), refs)}>
            <Icon name="sparkles" size={15} /> Render
          </Button>
        </div>
      </div>
    </div>
  );
}

export default BuilderPanel;
