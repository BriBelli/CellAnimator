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

import { useEffect, useRef, useState } from 'react';
import { Icon, SegmentedControl } from '../ui';
import { useChatTurnsStore } from '../../store/chat-turns-store';

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
.rc-model[data-on="true"] { color: var(--a2ui-text-primary); }
.rc-model:disabled { opacity: 0.4; cursor: default; }
.rc-check { width: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--a2ui-accent); flex-shrink: 0; }
.rc-model-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-model-off { flex-shrink: 0; font-size: 10px; color: var(--a2ui-text-tertiary); }
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

  useEffect(() => {
    if (!open || models.length > 0) return;
    fetch('/api/models/list')
      .then((r) => r.json())
      .then((d) => setModels(Array.isArray(d.models) ? d.models : []))
      .catch(() => {});
  }, [open, models.length]);

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

  const modelsLabel =
    fanConfig.mode === 'manual'
      ? `${fanConfig.models.length || 0} model${fanConfig.models.length === 1 ? '' : 's'}`
      : `Auto · top ${fanConfig.fanModels}`;
  const summary = `${modelsLabel} · ${fanConfig.perModel}/ea · ${fanConfig.aspect ?? 'auto'}`;

  const toggleModel = (id: string) => {
    const has = fanConfig.models.includes(id);
    setFanConfig({ models: has ? fanConfig.models.filter((m) => m !== id) : [...fanConfig.models, id] });
  };

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
              onChange={(m) => setFanConfig({ mode: m as 'auto' | 'manual' })}
              options={[
                { value: 'auto', label: 'Auto', icon: <span>Auto</span> },
                { value: 'manual', label: 'Manual', icon: <span>Manual</span> },
              ]}
            />
          </div>

          {fanConfig.mode === 'auto' ? (
            <div className="rc-row">
              <span className="rc-lbl">How many</span>
              <Stepper value={fanConfig.fanModels} min={1} max={5} onChange={(n) => setFanConfig({ fanModels: n })} />
            </div>
          ) : (
            <div className="rc-models">
              {models.length === 0 ? (
                <span className="rc-note">Loading models…</span>
              ) : (
                models.map((m) => (
                  <button key={m.id} type="button" className="rc-model" data-on={fanConfig.models.includes(m.id)} disabled={!m.ready} onClick={() => toggleModel(m.id)}>
                    <span className="rc-check">{fanConfig.models.includes(m.id) && <Icon name="check" size={12} />}</span>
                    <span className="rc-model-name">{m.label}</span>
                    {!m.ready && <span className="rc-model-off">no key</span>}
                  </button>
                ))
              )}
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
