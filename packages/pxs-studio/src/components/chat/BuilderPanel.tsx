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
import { Button, Icon } from '../ui';
import type { A2UIBuilderBlock } from '../../store/chat-turns-store';
import { bandLabel, type ScoreBand, type BuilderScore } from '../../lib/prompt-score';

export interface BuilderPanelProps {
  block: A2UIBuilderBlock;
  /** Controlled part values — LIFTED to ChatView so the center color-coded prompt and this panel
   *  share one source (two-way binding). Keyed by part id. */
  values: Record<string, string>;
  /** The live weighted score, computed once in ChatView and shared with the center prompt. */
  score: BuilderScore;
  /** Update a part's value (the single source of truth lives in ChatView). */
  onValueChange: (id: string, value: string) => void;
  /** The Agent's most recent part edit (the COUPLING) — flashes + scrolls that part into view. */
  highlight?: { id: string; n: number } | null;
  /** Assemble → generate: hands the composed prompt + attached references to the image agent. */
  onRender: (prompt: string, references: string[]) => void;
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

.pxc-part-head { display: flex; align-items: center; gap: var(--a2ui-space-2); }
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
.pxc-build-thumb button { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border: none; border-radius: var(--a2ui-radius-full);
  background: var(--a2ui-glass-dark); backdrop-filter: blur(6px); color: var(--a2ui-text-primary); cursor: pointer;
  display: flex; align-items: center; justify-content: center; }

.pxc-build-foot { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: var(--a2ui-space-3);
  padding-top: var(--a2ui-space-3); }
`;

/** The quality ring — a stroke arc that fills to `value`%, colored by band. */
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

export function BuilderPanel({ block, values, score, onValueChange, highlight, onRender, busy, initialRefs }: BuilderPanelProps) {
  // Values are CONTROLLED (owned by ChatView, shared with the center prompt). A chip APPENDS to the
  // field (comma-joined, de-duped); typing edits directly. The recommendation is the placeholder.
  const [refs, setRefs] = useState<string[]>(() => initialRefs ?? []);

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
        if (url) setRefs((r) => [...r, url]);
      };
      reader.readAsDataURL(file);
    });
  };

  /** Compose the prompt — each part's field value, comma-joined in order. */
  const assemble = () => block.parts.map((p) => (values[p.id] ?? '').trim()).filter(Boolean).join(', ');

  const bandOfPart = (id: string): ScoreBand => score.parts.find((s) => s.id === id)?.band ?? 'thin';

  const maxRefs = block.model?.maxReferences ?? 0;
  const canRender = !busy && assemble().length > 0;

  return (
    <div className="pxc-build relative flex-1 min-w-0">
      <style>{CSS}</style>
      <div className="pxc-build-inner">
        {/* Score header — the honest quality ring, weighted by the model's formula, climbing live.
            (The panel title lives in the collapsible header in ChatView.) */}
        <div className="pxc-build-score">
          <QualityRing value={score.overall} band={score.overallBand} />
          <div>
            <div className="pxc-build-score-title">Prompt quality</div>
            <div className="pxc-build-score-sub">
              {bandLabel(score.overallBand)} · {score.filled}/{score.total} parts
            </div>
          </div>
          {block.model && (
            <div className="pxc-build-score-model">
              Each part maps to what {block.model.label.split('(')[0].trim()} rewards
            </div>
          )}
        </div>

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
              {refs.map((src, i) => (
                <span key={i} className="pxc-build-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="reference" />
                  <button type="button" aria-label="Remove" onClick={() => setRefs((r) => r.filter((_, j) => j !== i))}>
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
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
                <span className={`pxc-band pxc-band-${bandOfPart(part.id)}`}>{bandOfPart(part.id)}</span>
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
