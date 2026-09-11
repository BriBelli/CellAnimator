'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * PromptString — the CANONICAL image prompt: reads as ONE color-aware sentence, edits live.
 *
 * The feel (Brian's spec): a non-technical customer reads this as a single text-area they click into
 * and type — it just happens to be color-coded, like a span-styled string, with DIM COMMAS (a
 * disabled-color state) between the parts. Click a coloured phrase, type, and that part changes; on
 * every keystroke it binds to the store (setPartValue → Build panel + local, instant score).
 *
 * MECHANISM (why per-part, not one surface): each part is its own contentEditable run. That makes the
 * read-back unambiguous — the span IS the editing root, so typed text can't escape into a neighbouring
 * part, and onInput maps to exactly one part id. (A single caret surface loses characters to loose text
 * nodes at phrase boundaries — binding breaks.) The dim commas + seamless inline layout make the three
 * runs read as one flowing sentence; the only thing given up is cross-part arrow-key flow, which the
 * reference design accepted on purpose. The per-run caret guard (write text back only when the run is
 * NOT focused) means an incoming agent/store edit never yanks your caret mid-type.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import type { BuilderPart } from '../../store/chat-turns-store';
import type { BuilderScore } from '../../lib/prompt-score';

/** Standard formula-part colors (matches the Build panel legend). Non-standard ids → neutral. */
const PART_COLORS: Record<string, string> = {
  subject: 'var(--a2ui-accent)',
  action: '#3fb950',
  context: '#f87171',
  composition: '#e3b341',
  style: '#bc8cff',
};
const colorFor = (id: string): string => PART_COLORS[id] ?? 'var(--a2ui-text-secondary)';

export interface PromptStringProps {
  parts: BuilderPart[];
  /** The controlled part values (shared with the Build panel). */
  values: Record<string, string>;
  score: BuilderScore;
  /** Edit a part inline → write back to the store (drives Build panel + local score). */
  onValueChange: (id: string, value: string) => void;
  /** Optional: jump focus to a part's field in the Build panel (kept for compatibility). */
  onEditPart?: (id: string) => void;
}

/** One inline, editable, colored run bound to a single part — with the caret guard. */
function EditRun({
  value,
  placeholder,
  color,
  plain,
  onChange,
}: {
  value: string;
  placeholder: string;
  color: string;
  plain: boolean;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // Only write text back into the span when it's NOT focused — so a store/agent update mid-edit
  // never resets the caret to the start (the "uncontrolled while typing" rule).
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    const txt = value || '';
    if (el.textContent !== txt) el.textContent = txt;
  }, [value]);
  return (
    <span
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      className="pxc-seg"
      data-empty={value ? 'false' : 'true'}
      data-ph={placeholder}
      style={{ color: plain ? 'var(--a2ui-text-primary)' : color }}
      onInput={(e) => onChange(e.currentTarget.textContent ?? '')}
      onBlur={(e) => onChange((e.currentTarget.textContent ?? '').replace(/\s+/g, ' ').trim())}
    />
  );
}

const CSS = `
.pxc-ps {
  text-align: left;
  background: var(--a2ui-glass-dark, rgba(20,22,28,0.82)); backdrop-filter: blur(14px);
  border: 1px solid var(--pxs-border-subtle); border-radius: var(--a2ui-radius-xl);
  padding: var(--a2ui-space-4); box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  display: flex; flex-direction: column; gap: var(--a2ui-space-3);
}
.pxc-ps-line { text-align: left; font-size: var(--a2ui-text-md); line-height: var(--a2ui-leading-relaxed);
  color: var(--a2ui-text-primary); max-height: 156px; overflow-y: auto; cursor: text; }
.pxc-seg { font-family: var(--a2ui-font-family); font-size: inherit; line-height: inherit; font-weight: var(--a2ui-font-medium);
  outline: none; border-radius: 3px; padding: 0 1px; cursor: text; white-space: pre-wrap; }
.pxc-seg:focus { background: var(--a2ui-bg-hover); box-shadow: 0 0 0 2px var(--a2ui-accent-subtle); }
.pxc-seg[data-empty="true"]::before { content: attr(data-ph); color: var(--a2ui-text-disabled); font-style: italic; }
.pxc-ps-comma, .pxc-ps-stop { color: var(--a2ui-text-disabled); }
.pxc-ps-empty { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); }
.pxc-ps-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--a2ui-space-3);
  flex-wrap: wrap; padding-top: var(--a2ui-space-2); border-top: 1px solid var(--a2ui-border-subtle); }
.pxc-ps-legend { display: flex; flex-wrap: wrap; gap: var(--a2ui-space-3); align-items: center; }
.pxc-ps-leg { display: inline-flex; align-items: center; gap: 5px; font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); }
.pxc-ps-swatch { width: 8px; height: 8px; border-radius: 2px; display: inline-block; flex-shrink: 0; }
.pxc-ps-right { display: inline-flex; align-items: center; gap: var(--a2ui-space-3); }
.pxc-ps-meta { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); white-space: nowrap; }
.pxc-ps-info { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  border: none; background: none; color: var(--a2ui-text-tertiary); cursor: pointer; border-radius: var(--a2ui-radius-md);
  font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-semibold); font-family: var(--a2ui-font-family); font-style: italic; }
.pxc-ps-info[data-on="true"], .pxc-ps-info:hover { background: var(--a2ui-bg-hover); color: var(--pxs-accent-text); }
`;

export function PromptString({ parts, values, score, onValueChange }: PromptStringProps) {
  const [plain, setPlain] = useState(false);
  const words = parts.reduce((n, p) => n + (values[p.id] ?? '').split(/\s+/).filter(Boolean).length, 0);
  const anyFilled = parts.some((p) => (values[p.id] ?? '').trim().length > 0);

  return (
    <div className="pxc-ps">
      <style>{CSS}</style>
      {!anyFilled ? (
        <div className="pxc-ps-empty">Describe what to create — or shape it part by part under Parts, and it assembles here.</div>
      ) : (
        <div className="pxc-ps-line">
          {parts.map((p, i) => (
            <span key={p.id}>
              {i > 0 && <span className="pxc-ps-comma">{plain ? ' ' : ', '}</span>}
              <EditRun
                value={values[p.id] ?? ''}
                placeholder={p.label.toLowerCase()}
                color={colorFor(p.id)}
                plain={plain}
                onChange={(v) => onValueChange(p.id, v)}
              />
            </span>
          ))}
          <span className="pxc-ps-stop">.</span>
        </div>
      )}
      <div className="pxc-ps-foot">
        <div className="pxc-ps-legend">
          {!plain &&
            parts.map((p) => (
              <span key={p.id} className="pxc-ps-leg">
                <span className="pxc-ps-swatch" style={{ background: colorFor(p.id) }} /> {p.label}
              </span>
            ))}
          {plain && <span className="pxc-ps-meta">Reading mode</span>}
        </div>
        <div className="pxc-ps-right">
          <span className="pxc-ps-meta">
            {words} words · {score.overall}%
          </span>
          <button
            type="button"
            className="pxc-ps-info"
            data-on={plain ? 'true' : 'false'}
            onClick={() => setPlain((v) => !v)}
            title={plain ? 'Show color legend' : 'Read as plain text'}
          >
            i
          </button>
        </div>
      </div>
    </div>
  );
}

export default PromptString;
