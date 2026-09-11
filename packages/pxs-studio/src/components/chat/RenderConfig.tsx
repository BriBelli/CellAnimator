'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * RenderConfig — the fan-out picker (Slice 4). The manual control over what a render does:
 *   • Models: AUTO (the Model agent fans across the top-N by fit) or MANUAL (pick exact models).
 *   • Images each: M images per model.
 *   • Aspect: the render aspect — AND the reference aspect-fit target (a portrait ref → 16:9 canvas).
 *
 * Writes the shared store.fanConfig (read by the render request). A glass popover on the tokens, opened
 * from a compact summary trigger (the Artlist "16:9 / 1 Images" pattern). Model list from /api/models/list.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, SegmentedControl } from '../ui';
import { checkRenderBudget } from '../../lib/engine/render-estimate';
import { useChatTurnsStore } from '../../store/chat-turns-store';

/** Money, rendered the way people read it. */
const money = (n: number) => `$${n.toFixed(2)}`;

interface ModelOpt {
  id: string;
  label: string;
  provider: string;
  tier: number;
  ready: boolean;
  capabilities: string[];
}

const ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16'];

const CSS = `
.rc { position: relative; display: inline-block; font-family: var(--a2ui-font-family); }
.rc-trigger { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  border: 1px solid var(--pxc-border-subtle); border-radius: var(--a2ui-radius-md); background: var(--a2ui-bg-secondary);
  color: var(--a2ui-text-secondary); font-size: var(--a2ui-text-xs); cursor: pointer;
  transition: color var(--a2ui-transition-fast), border-color var(--a2ui-transition-fast); }
.rc-trigger:hover { color: var(--a2ui-text-primary); border-color: var(--a2ui-border-default); }
.rc-trigger svg { color: var(--a2ui-text-tertiary); }
.rc-pop { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: var(--a2ui-z-dropdown);
  width: 300px; padding: var(--a2ui-space-4); display: flex; flex-direction: column; gap: var(--a2ui-space-4);
  background: var(--pxc-bg-glass-frost); backdrop-filter: var(--pxc-glass-filter); -webkit-backdrop-filter: var(--pxc-glass-filter);
  border: 1px solid var(--pxc-stroke); border-radius: var(--a2ui-radius-lg); box-shadow: var(--a2ui-shadow-lg);
  animation: rc-in 120ms ease; }
@keyframes rc-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.rc-row { display: flex; align-items: center; justify-content: space-between; gap: var(--a2ui-space-3); }
.rc-lbl { font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-semibold); text-transform: uppercase; letter-spacing: 0.05em; color: var(--a2ui-text-tertiary); }
.rc-step { display: inline-flex; align-items: center; gap: 2px; }
.rc-step button { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--pxc-border-subtle); border-radius: var(--a2ui-radius-sm); background: var(--a2ui-bg-secondary);
  color: var(--a2ui-text-secondary); cursor: pointer; }
.rc-step button:hover:not(:disabled) { color: var(--a2ui-text-primary); border-color: var(--a2ui-border-default); }
.rc-step button:disabled { opacity: 0.4; cursor: default; }
.rc-step-val { min-width: 20px; text-align: center; font-family: var(--a2ui-font-mono); font-size: var(--a2ui-text-sm); color: var(--a2ui-text-primary); }
.rc-aspects, .rc-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.rc-aspect { height: 26px; padding: 0 9px; border: 1px solid var(--pxc-border-subtle); border-radius: var(--a2ui-radius-sm);
  background: none; color: var(--a2ui-text-secondary); font-family: var(--a2ui-font-mono); font-size: var(--a2ui-text-xs); cursor: pointer;
  transition: color var(--a2ui-transition-fast), border-color var(--a2ui-transition-fast), background var(--a2ui-transition-fast); }
.rc-aspect:hover { color: var(--a2ui-text-primary); }
.rc-aspect[data-on="true"] { color: var(--pxs-accent-text); border-color: var(--a2ui-accent); background: var(--a2ui-accent-subtle); }
.rc-models { display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; }
.rc-model { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 8px; border: none; background: none;
  color: var(--a2ui-text-secondary); font-family: inherit; font-size: var(--a2ui-text-sm); text-align: left; cursor: pointer;
  border-radius: var(--a2ui-radius-md); transition: background var(--a2ui-transition-fast), color var(--a2ui-transition-fast); }
.rc-model:hover:not(:disabled) { background: var(--a2ui-bg-hover); color: var(--a2ui-text-primary); }
.rc-model[data-on="true"] { color: var(--a2ui-text-primary); background: var(--a2ui-accent-subtle); }
.rc-model[data-on="true"] .rc-check { color: var(--pxs-accent-text); }
.rc-model:disabled { cursor: default; }
.rc-model:disabled { opacity: 0.4; }
.rc-check { width: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--a2ui-accent); flex-shrink: 0; }
.rc-model-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-model-off { flex-shrink: 0; font-size: 10px; color: var(--a2ui-text-tertiary); }
.rc-cost { display: flex; flex-direction: column; gap: 2px; padding: var(--a2ui-space-3) 0;
  border-top: 1px solid var(--pxs-border-subtle, var(--a2ui-border)); }
.rc-cost-figure { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-primary); font-variant-numeric: tabular-nums; }
.rc-cost-note { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); }
.rc-cost[data-verdict='tight'] .rc-cost-note { color: var(--a2ui-warning); }
.rc-cost[data-verdict='over'] .rc-cost-figure { color: var(--a2ui-danger, #e5484d); }
.rc-cost[data-verdict='over'] .rc-cost-note { color: var(--a2ui-danger, #e5484d); }
.rc-derived { display: inline-flex; align-items: center; justify-content: center; min-width: 34px; height: 28px;
  padding: 0 10px; border-radius: var(--a2ui-radius-md); background: var(--a2ui-bg-tertiary);
  color: var(--a2ui-text-secondary); font-size: var(--a2ui-text-sm); font-variant-numeric: tabular-nums; }
.rc-note { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); line-height: 1.4; }
`;

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <span className="rc-step">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="Decrease">
        <Icon name="x" size={11} style={{ transform: 'rotate(45deg)' }} />
      </button>
      <span className="rc-step-val">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="Increase">
        <Icon name="plus" size={12} />
      </button>
    </span>
  );
}

export function RenderConfig() {
  const fanConfig = useChatTurnsStore((s) => s.fanConfig);
  const setFanConfig = useChatTurnsStore((s) => s.setFanConfig);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  // Load the catalog on MOUNT (not just on open) so the trigger summary + Auto preview are correct
  // before the popover is ever opened.
  useEffect(() => {
    if (models.length > 0) return;
    fetch('/api/models/list')
      .then((r) => r.json())
      .then((d) => setModels(Array.isArray(d.models) ? d.models : []))
      .catch(() => {});
  }, [models.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // RANK — ready models first, then by tier (desc), stable on registry order. This is the fit order the
  // AUTO fan pre-selects from and the order everything sorts by (so selections stay rank-ordered).
  const ranked = [...models].sort((a, b) => Number(b.ready) - Number(a.ready) || b.tier - a.tier);
  const readyRanked = ranked.filter((m) => m.ready);
  const rankIndex = (id: string) => {
    const i = ranked.findIndex((m) => m.id === id);
    return i < 0 ? 999 : i;
  };
  const byRank = (ids: string[]) => [...ids].sort((a, b) => rankIndex(a) - rankIndex(b));
  const labelOf = (id: string) => models.find((m) => m.id === id)?.label ?? id;

  // LIVE COST — the number that turns "hit render and find out" into a decision. Recomputed as the
  // knobs move, because the knobs ARE the price: models × count (× seconds × resolution for video).
  const budget = useChatTurnsStore((st) => st.budget);
  const isAuto = fanConfig.mode === 'auto';
  // In MANUAL the count is DERIVED from the selection — picking a model IS asking for it. A separate
  // cap meant a model could be checked and still silently not render ("capped"), which is a trap:
  // you chose it, the UI showed a checkmark, and nothing came back. Only AUTO has a real count to set,
  // because there the agent needs to know how wide to fan.
  const count = isAuto ? Math.max(1, fanConfig.fanModels) : Math.max(1, fanConfig.models.length);
  const maxCount = Math.max(1, readyRanked.length || 5);

  // THE SELECTION — one concrete, ordered list, whatever the mode:
  //  • AUTO   → NOT a selection at all. The Model agent picks per request from the cross-validated
  //             fit for THAT brief; this list is only the pool it draws from, and `count` is how many
  //             it may fan across. Showing these rows as CHECKED was a straight contradiction —
  //             "Auto" that displays three locked-in choices reads as a manual selection, and the
  //             rank-ordered preview isn't even what the agent would choose. Auto now shows no
  //             checkmarks; picking one is an explicit act that moves you to Manual.
  //  • MANUAL → exactly what the user curated (persisted). Editing ANY model flips Auto → Manual and
  //             seeds the current preview so nothing is lost.
  const selected =
    fanConfig.mode === 'manual'
      ? byRank(fanConfig.models.filter((id) => models.some((m) => m.id === id)))
      : readyRanked.slice(0, count).map((m) => m.id);
  // Manual: every selected model renders. Auto: the preview is the top-`count`.
  const active = isAuto ? selected.slice(0, count) : selected;

  // Before the catalog loads, fall back to the raw count so the trigger never flashes "0 models".
  const shownCount = active.length || (models.length === 0 ? count : 0);
  const summary = `${fanConfig.mode === 'auto' ? 'Auto' : 'Manual'} · ${shownCount} model${shownCount === 1 ? '' : 's'} · ${fanConfig.perModel}/ea · ${fanConfig.aspect ?? 'auto'}`;

  // Priced against what will ACTUALLY run: in Auto the agent picks, so the preview list is the best
  // available prediction and is labelled as such rather than quoted as a certainty.
  const cost = useMemo(
    () =>
      checkRenderBudget(
        { medium: 'image', modelIds: active, perModel: fanConfig.perModel },
        budget?.remaining_usd ?? Number.POSITIVE_INFINITY,
      ),
    [active, fanConfig.perModel, budget?.remaining_usd],
  );

  // Toggling a model always lands in MANUAL with a concrete list; count follows the selection size so
  // selecting adds (+1) and deselecting removes (−1) — never below 1.
  const toggleModel = (id: string) => {
    const base = selected; // the current concrete list (auto preview or manual)
    const has = base.includes(id);
    if (has && base.length <= 1) return; // keep at least one
    const next = byRank(has ? base.filter((m) => m !== id) : [...base, id]);
    setFanConfig({ mode: 'manual', models: next, fanModels: Math.max(1, next.length) });
  };

  /** AUTO only — how wide the agent should fan. In Manual the count follows the selection. */
  const setCount = (c: number) => setFanConfig({ fanModels: Math.max(1, Math.min(maxCount, c)) });

  const toAuto = () => setFanConfig({ mode: 'auto', models: [] });
  const toManual = () => setFanConfig({ mode: 'manual', models: selected, fanModels: Math.max(1, active.length) });

  return (
    <div className="rc" ref={ref}>
      <style>{CSS}</style>
      <button type="button" className="rc-trigger" onClick={() => setOpen((v) => !v)} title="Render settings — models, images, aspect">
        <Icon name="settings" size={13} />
        <span>{summary}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="rc-pop">
          <div className="rc-row">
            <span className="rc-lbl">Models</span>
            <SegmentedControl
              label="Fan mode"
              value={fanConfig.mode}
              onChange={(m) => (m === 'auto' ? toAuto() : toManual())}
              options={[
                { value: 'auto', label: 'Auto', icon: <span>Auto</span> },
                { value: 'manual', label: 'Manual', icon: <span>Manual</span> },
              ]}
            />
          </div>

          <div className="rc-row">
            <span className="rc-lbl">{isAuto ? 'How many models' : 'Models selected'}</span>
            {isAuto ? (
              <Stepper value={count} min={1} max={maxCount} onChange={setCount} />
            ) : (
              /* Same row, same height — no layout shift when switching modes. A read-only figure
                 rather than a disabled stepper: a greyed control still asks "why is this here?",
                 whereas a plain count reads as a fact about what you picked. */
              <span className="rc-derived" title="Set by the models you select below">
                {count}
              </span>
            )}
          </div>

          {/* The MODEL LIST — shown in BOTH modes, but they MEAN different things. In Auto these are
              the candidate pool (no checkmarks — the agent decides per render); tapping one is how you
              take over, which lands you in Manual with that model chosen. In Manual they're your
              curated list; selections beyond "How many" show CAPPED (checked, disabled) and return
              when you raise the count. No-key models are always disabled. */}
          <div className="rc-models" data-auto={isAuto}>
            {models.length === 0 ? (
              <span className="rc-note">Loading models…</span>
            ) : (
              ranked.map((m) => {
                // In Auto nothing is "selected" — there is no user choice to display yet.
                const isSelected = !isAuto && selected.includes(m.id);
                const isActive = !isAuto && active.includes(m.id);
                const disabled = !m.ready;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="rc-model"
                    data-on={isActive}
                    disabled={disabled}
                    onClick={() => toggleModel(m.id)}
                    title={isAuto ? `Choose ${m.label} yourself (switches to Manual)` : undefined}
                  >
                    <span className="rc-check">{isSelected && <Icon name="check" size={12} />}</span>
                    <span className="rc-model-name">{m.label}</span>
                    {!m.ready ? <span className="rc-model-off">no key</span> : null}
                  </button>
                );
              })
            )}
          </div>
          {isAuto && models.length > 0 && (
            <div className="rc-note">
              The model agent picks the best {count === 1 ? 'model' : `${count} models`} for each render.
              Tap one to choose yourself.
            </div>
          )}

          {/* THE PRICE, before the click. Video is ~50x an image per render, so a control surface
              that can spend either must say what this one costs while the knobs are still reachable. */}
          {active.length > 0 && (
            <div className="rc-cost" data-verdict={cost.verdict}>
              <span className="rc-cost-figure">{cost.estimate.summary}</span>
              {budget && (
                <span className="rc-cost-note">
                  {cost.verdict === 'over'
                    ? `${money(cost.shortfallUsd)} over your remaining ${money(budget.remaining_usd)}`
                    : cost.verdict === 'tight'
                      ? `most of your remaining ${money(budget.remaining_usd)}`
                      : `${money(budget.remaining_usd)} left`}
                </span>
              )}
              {isAuto && <span className="rc-cost-note">estimated — the agent picks the final models</span>}
            </div>
          )}

          <div className="rc-row">
            <span className="rc-lbl">Images each</span>
            <Stepper value={fanConfig.perModel} min={1} max={4} onChange={(n) => setFanConfig({ perModel: n })} />
          </div>

          <div className="rc-row" style={{ alignItems: 'flex-start' }}>
            <span className="rc-lbl" style={{ marginTop: 4 }}>Aspect</span>
            <div className="rc-aspects" style={{ flex: 1, justifyContent: 'flex-end' }}>
              <button type="button" className="rc-aspect" data-on={!fanConfig.aspect} onClick={() => setFanConfig({ aspect: undefined })}>auto</button>
              {ASPECTS.map((a) => (
                <button key={a} type="button" className="rc-aspect" data-on={fanConfig.aspect === a} onClick={() => setFanConfig({ aspect: a })}>{a}</button>
              ))}
            </div>
          </div>

          <span className="rc-note">Aspect sets the render and re-fits your references onto that frame — so a portrait reference conditions a 16:9 shot instead of being cloned.</span>
        </div>
      )}
    </div>
  );
}

export default RenderConfig;
