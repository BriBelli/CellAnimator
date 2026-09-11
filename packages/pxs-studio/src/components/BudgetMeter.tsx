'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * BudgetMeter — the user's spend, and their control over it.
 *
 * Why this is a product surface and not a debug readout: the cap used to be a $5 constant nobody
 * could change, on a medium where a single 10-second 1080p clip is $3.40. That is a wall, not a
 * safety rail. This is the person's own money being streamed to the providers through us, so the
 * number is theirs to set — our job is to meter it honestly, show it before they commit, and stop
 * cleanly when it runs out.
 *
 * Three states, because "how much is left" is the only question this answers: healthy, running low
 * (amber, while there is still time to act), and exhausted (nothing more will run until the cap is
 * raised). It never hides a number and never suggests spending less than the user asked for.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from 'react';
import { useChatTurnsStore } from '../store/chat-turns-store';

const money = (n: number) => `$${n.toFixed(2)}`;

const CSS = `
.pxs-budget { display: flex; flex-direction: column; gap: var(--a2ui-space-2); padding: var(--a2ui-space-3) var(--a2ui-space-4); }
.pxs-budget-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--a2ui-space-3); }
.pxs-budget-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; color: var(--a2ui-text-tertiary); }
.pxs-budget-edit { font-size: var(--a2ui-text-xs); color: var(--a2ui-accent); background: none; border: none; padding: 0; cursor: pointer; }
.pxs-budget-edit:hover { text-decoration: underline; }
.pxs-budget-figure { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-primary); font-variant-numeric: tabular-nums; }
.pxs-budget-figure b { font-weight: 600; }
.pxs-budget-track { height: 5px; border-radius: 999px; background: var(--a2ui-bg-tertiary, rgba(255,255,255,0.08)); overflow: hidden; }
.pxs-budget-fill { height: 100%; border-radius: 999px; background: var(--a2ui-accent); transition: width .3s ease, background .3s ease; }
.pxs-budget[data-state='low'] .pxs-budget-fill { background: var(--a2ui-warning); }
.pxs-budget[data-state='out'] .pxs-budget-fill { background: var(--a2ui-danger, #e5484d); }
.pxs-budget-note { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); line-height: 1.45; }
.pxs-budget[data-state='low'] .pxs-budget-note { color: var(--a2ui-warning); }
.pxs-budget[data-state='out'] .pxs-budget-note { color: var(--a2ui-danger, #e5484d); }
.pxs-budget-form { display: flex; gap: var(--a2ui-space-2); align-items: center; }
.pxs-budget-input { flex: 1; min-width: 0; height: 30px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--pxs-border-subtle, var(--a2ui-border)); background: var(--a2ui-bg-secondary);
  color: var(--a2ui-text-primary); font-size: var(--a2ui-text-sm); font-variant-numeric: tabular-nums; }
.pxs-budget-input:focus { outline: none; border-color: var(--a2ui-accent); }
.pxs-budget-save { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent;
  background: var(--a2ui-accent); color: #fff; font-size: var(--a2ui-text-xs); font-weight: 600; cursor: pointer; }
.pxs-budget-save:disabled { opacity: 0.5; cursor: default; }
.pxs-budget-cancel { height: 30px; padding: 0 8px; border: none; background: none; color: var(--a2ui-text-tertiary); font-size: var(--a2ui-text-xs); cursor: pointer; }
.pxs-budget-err { font-size: var(--a2ui-text-xs); color: var(--a2ui-danger, #e5484d); line-height: 1.45; }
`;

export function BudgetMeter() {
  const budget = useChatTurnsStore((s) => s.budget);
  const loadBudget = useChatTurnsStore((s) => s.loadBudget);
  const setSpendCap = useChatTurnsStore((s) => s.setSpendCap);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!budget) void loadBudget();
  }, [budget, loadBudget]);

  if (!budget) return null;

  // "Low" fires at 80% — early enough that a video render is still affordable, since one clip can be
  // most of what remains. A warning that arrives at 95% on this medium arrives after the decision.
  const state = !budget.allowed ? 'out' : budget.used_fraction >= 0.8 ? 'low' : 'ok';

  const save = async () => {
    const value = Number(draft);
    setSaving(true);
    setError(null);
    const err = await setSpendCap(value);
    setSaving(false);
    if (err) {
      setError(err);
      return;
    }
    setEditing(false);
  };

  return (
    <div className="pxs-budget" data-state={state}>
      <style>{CSS}</style>
      <div className="pxs-budget-head">
        <span className="pxs-budget-label">Budget</span>
        {!editing && (
          <button
            type="button"
            className="pxs-budget-edit"
            onClick={() => {
              setDraft(String(budget.cap_usd));
              setError(null);
              setEditing(true);
            }}
          >
            Change
          </button>
        )}
      </div>

      {editing ? (
        <>
          <div className="pxs-budget-form">
            <input
              className="pxs-budget-input"
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setEditing(false);
              }}
              aria-label="Spend cap in dollars"
            />
            <button type="button" className="pxs-budget-save" onClick={() => void save()} disabled={saving || draft.trim() === ''}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="pxs-budget-cancel" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {error && <div className="pxs-budget-err">{error}</div>}
          <div className="pxs-budget-note">
            Work stops when spending reaches this. Set it to 0 to pause all generation.
          </div>
        </>
      ) : (
        <>
          <div className="pxs-budget-figure">
            <b>{money(budget.remaining_usd)}</b> left of {money(budget.cap_usd)}
          </div>
          <div className="pxs-budget-track">
            <div className="pxs-budget-fill" style={{ width: `${Math.round(budget.used_fraction * 100)}%` }} />
          </div>
          <div className="pxs-budget-note">
            {state === 'out'
              ? 'Budget reached — raise it to keep generating.'
              : state === 'low'
                ? `${money(budget.spent_usd)} spent. Running low.`
                : `${money(budget.spent_usd)} spent`}
          </div>
        </>
      )}
    </div>
  );
}

export default BudgetMeter;
