'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * ImageStage — the CENTER canvas of the Image (and Video) workspace.
 *
 * This is the surface the Operator's TRANSFER lands on: the specialist's generated
 * images shown LARGE on a calm stage (not buried inline in the chat column), with
 * the conversation continuing in the right pane. It is what makes a transfer feel
 * like entering a workflow instead of hitting a dead-end.
 *
 * Tokens-only, Claude Design gospel: no gradient on chrome (the one allowed gradient
 * is the per-tile hover overlay, §6), no scale-pop, calm empty state. Newest images
 * first; a pulsing placeholder while the specialist is still generating.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from 'react';
import { Icon } from '../ui';
import { GreetingHero } from '../GreetingHero';
import { toastManager } from '../Toast';
import type { FanModelStatus } from '../../store/chat-turns-store';

export interface StageImage {
  url: string;
  /** Registry model id — pairs the tile with its fan status entry (label is display-only). */
  modelId?: string;
  modelLabel: string;
  index: number;
  turnId: string;
  /** Fan-out fit score the model was picked by — used to RANK the model columns (best fit first). */
  score?: number;
}

/** How results are laid out — the split toggle. Persisted per user. */
export type StageView = 'grouped' | 'stream';

/** Is this delivered media a clip? Decided from the URL rather than the workspace medium, so a turn
 *  that mixes stills and motion renders each correctly instead of picking one for the whole grid. */
function isPlayable(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

/** localStorage key for the results view preference (grouped ↔ stream). */
const VIEW_STORAGE_KEY = 'pxs-stage-view';

interface ImageStageProps {
  images: StageImage[];
  generating: boolean;
  /** The active render's fan — per-model live status (planned · running · done · failed), so every
   *  model in the fan shows its own state at once instead of one ambiguous spinner. */
  genPlan?: FanModelStatus[];
  /** The turn the fan belongs to. REQUIRED for correct loader math across a session: the stage shows
   *  every image in the conversation, so "how many are still cooking" must count only THIS render's
   *  tiles — otherwise a second render across the same models sees its quota already filled by the
   *  first render's images and shows no loaders at all. */
  fanTurnId?: string;
  medium: 'image' | 'video';
  /** The active workflow's subject/goal — personalizes the empty state to the in-state context
   *  (consult-first framing) instead of a generic placeholder. */
  contextLabel?: string;
  /** Save a generated tile to the Assets catalog (promote in-state → first-class). Returns true on
   *  success so the tile can flip to a "Saved" state. */
  onSaveAsset?: (img: StageImage) => Promise<boolean>;
}

const CSS = `
.pxc-stage { background: var(--a2ui-bg-app); }

/* RESULTS column header — the mock's uppercase label above the bento (only shown with content;
   the empty state keeps the warmer GreetingHero invitation instead). */
.pxc-stage-head { display: flex; align-items: center; gap: var(--a2ui-space-3); padding: var(--a2ui-space-5) var(--a2ui-space-6) 0; }
.pxc-stage-label {
  font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-semibold);
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--a2ui-text-tertiary);
}

/* VIEW TOGGLE — grouped-by-model ↔ stream-order. Two lenses on the same fan: grouped is decision
   closure (every model's take side by side); stream is watching the run land in arrival order. */
.pxc-stage-views { margin-left: auto; display: inline-flex; gap: 2px; padding: 2px;
  border: 1px solid var(--pxs-glass-border); border-radius: var(--a2ui-radius-md); background: var(--a2ui-glass-dark); }
.pxc-stage-view {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 24px; padding: 0 10px;
  font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-medium); white-space: nowrap;
  border: none; background: none; border-radius: var(--a2ui-radius-sm); color: var(--a2ui-text-tertiary);
  cursor: pointer; transition: background var(--a2ui-transition-fast), color var(--a2ui-transition-fast);
}
.pxc-stage-view:hover { color: var(--a2ui-text-secondary); }
.pxc-stage-view[data-on="true"] { background: var(--a2ui-bg-elevated); color: var(--a2ui-text-primary); }

/* FAN-OUT — one column per model, packed from the left. EVERY tile is the SAME FIXED SIZE (fixed column
   width × a fixed 4:3 box, image letterboxed inside): no more "one big, one small" — uniform, and three
   models sit side-by-side above the fold. Columns are a fixed width so the grid never stretches a lone
   image to fill the canvas. */
/* GROUPED — each model is a SECTION: a tight header line, then that model's images flowing
   left→right in the shared grid. It used to be a narrow fixed-width COLUMN per model, which stacked
   every image of a model vertically and pushed the rest of the fan below the fold. */
.pxc-stage-groups { display: flex; flex-direction: column; gap: var(--a2ui-space-5); }
.pxc-stage-group { min-width: 0; display: flex; flex-direction: column; gap: var(--a2ui-space-3); }
/* The header is a COMPACT chip sized to its content — it never spans the section or crowds the art. */
.pxc-stage-group-head { display: inline-flex; align-items: center; gap: 7px; min-width: 0; width: fit-content;
  max-width: 100%; padding: 4px 10px 4px 8px; border-radius: var(--a2ui-radius-full);
  background: var(--a2ui-bg-secondary); border: 1px solid var(--pxs-border-subtle); }
.pxc-stage-model { font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Per-model FIT SCORE — the badge that speeds the choosing once the field is trusted. */
.pxc-stage-score { flex-shrink: 0; display: inline-flex; align-items: center; height: 18px; padding: 0 7px;
  border-radius: var(--a2ui-radius-full); font-family: var(--a2ui-font-mono); font-size: 10px; font-variant-numeric: tabular-nums;
  color: var(--pxs-accent-text); background: var(--a2ui-accent-subtle); border: 1px solid var(--a2ui-border-subtle); }
.pxc-stage-count { flex-shrink: 0; font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); font-variant-numeric: tabular-nums; }
/* Per-model STATUS chip — the column says how its API call is doing: spinner while running,
   ✓ when it settled, ⚠ when it failed. Without it a column can only be read by absence. */
.pxc-stage-state { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; }
.pxc-stage-state[data-state="done"] { color: var(--a2ui-success); }
.pxc-stage-state[data-state="failed"] { color: var(--a2ui-warning); }
.pxc-stage-state .pxc-stage-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--a2ui-border-strong); }
.pxc-stage-state .pxc-stage-spinner { width: 11px; height: 11px; border-width: 1.5px; }

/* FAILED column — it KEEPS its slot with the honest reason. A model whose loaders simply vanish
   is the exact "what happened?" hole this surface exists to close. */
.pxc-stage-failed {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  aspect-ratio: 4 / 3; padding: var(--a2ui-space-4); text-align: center;
  border-radius: var(--a2ui-radius-lg); background: var(--a2ui-bg-tertiary);
  box-shadow: 0 0 0 1px var(--a2ui-warning-bg); color: var(--a2ui-warning); font-size: var(--a2ui-text-sm);
}
.pxc-stage-failed-sub { color: var(--a2ui-text-tertiary); font-size: var(--a2ui-text-xs); }

.pxc-stage-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; min-width: 0;
  padding: var(--a2ui-space-4) var(--a2ui-space-5) var(--a2ui-space-8);
  /* The canvas — not the window — is what tiles must fit. Opening the Prompt guide halves this
     width, so viewport media queries would size tiles for a canvas that isn't there. */
  container-type: inline-size; }

/* THE TILE GRID — every result surface uses this. Tiles are RELATIVE (minmax + 1fr), so they always
   flow left→right and wrap; they never collapse into a single column. Previously this was a fixed
   340px track that silently became a one-column stack of oversized tiles the moment the canvas got
   narrow — which is every time the Prompt guide is open. Compact by default so a whole fan sits
   above the fold on a 15" laptop, growing with the canvas. */
.pxc-tiles { display: grid; gap: var(--a2ui-space-3);
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); align-items: start; }
@container (min-width: 560px) { .pxc-tiles { gap: var(--a2ui-space-4); grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); } }
@container (min-width: 900px)  { .pxc-tiles { grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); } }
@container (min-width: 1400px) { .pxc-tiles { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); } }
.pxc-stage-skipped { display: flex; flex-wrap: wrap; gap: var(--a2ui-space-2) var(--a2ui-space-4); margin-bottom: var(--a2ui-space-4); }
.pxc-stage-skip-item { display: inline-flex; align-items: baseline; gap: 5px; font-size: var(--a2ui-text-xs); color: var(--a2ui-text-secondary); }
.pxc-stage-skip-dash { color: var(--a2ui-text-tertiary); }
.pxc-stage-skip-reason { color: var(--a2ui-text-tertiary); }
.pxc-stage-tile {
  position: relative; overflow: hidden; aspect-ratio: 4 / 3;
  border-radius: var(--a2ui-radius-lg); background: var(--a2ui-bg-tertiary);
  box-shadow: 0 0 0 1px var(--pxs-border-subtle);
  transition: box-shadow var(--a2ui-transition-fast);
}
/* BOLD-mode accent washes — alternating coral/violet radial under each tile (behind the image, so a
   real thumbnail covers it; it reads on empty/loading tiles). Professional flips --px-tint-* neutral. */
.pxc-stage-tile:hover { box-shadow: 0 0 0 1px var(--a2ui-border-default); }
/* CONTAIN, not cover — never crop what the model made (a character sheet is the whole image). Letterbox
   on the tile bg. */
.pxc-stage-tile img, .pxc-stage-tile video { width: 100%; height: 100%; object-fit: contain; display: block; background: var(--a2ui-bg-tertiary); }
.pxc-stage-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: flex-start; justify-content: flex-end; gap: 4px;
  padding: 6px;
  background: linear-gradient(180deg, rgba(0,0,0,0.5) 0%, transparent 32%);
  opacity: 0; transition: opacity var(--a2ui-transition-fast);
}
.pxc-stage-tile:hover .pxc-stage-overlay, .pxc-stage-tile:focus-within .pxc-stage-overlay { opacity: 1; }
.pxc-stage-action {
  display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 11px;
  border-radius: var(--a2ui-radius-md);
  border: 1px solid var(--pxs-glass-border); background: var(--a2ui-glass-dark);
  backdrop-filter: blur(8px);
  color: var(--a2ui-text-primary); font-size: var(--a2ui-text-sm);
  font-family: var(--a2ui-font-family); text-decoration: none; cursor: pointer;
  transition: background var(--a2ui-transition-fast);
}
.pxc-stage-action:hover { background: var(--a2ui-bg-elevated); }
.pxc-stage-action[data-on="true"] { color: var(--a2ui-success); }
/* Sized for a COMPACT tile — 30px buttons covered a third of a small thumbnail. */
.pxc-stage-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  border-radius: var(--a2ui-radius-md); border: 1px solid var(--pxs-glass-border);
  background: var(--a2ui-glass-dark); backdrop-filter: blur(8px); color: var(--a2ui-text-primary);
  cursor: pointer; transition: background var(--a2ui-transition-fast); text-decoration: none;
}
.pxc-stage-icon:hover { background: var(--a2ui-bg-elevated); }
.pxc-stage-icon[data-on="true"] { color: var(--a2ui-success); }
.pxc-stage-icon:disabled { cursor: default; }
.pxc-stage-badge {
  position: absolute; left: 6px; right: 6px; bottom: 6px; width: fit-content; max-width: calc(100% - 12px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 7px; border-radius: var(--a2ui-radius-full);
  font-size: 10px; color: var(--a2ui-text-primary);
  background: var(--a2ui-glass-dark); backdrop-filter: blur(8px);
  border: 1px solid var(--pxs-glass-border);
  opacity: 0; transition: opacity var(--a2ui-transition-fast);
}
/* Model badge + actions both reveal together, ONLY on hover (or tap/focus on mobile). */
.pxc-stage-tile:hover .pxc-stage-badge, .pxc-stage-tile:focus-within .pxc-stage-badge { opacity: 1; }

/* ── Full-screen artifact viewer (the eye) ── */
.pxc-viewer { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.88); backdrop-filter: blur(6px); padding: 48px; animation: pxc-viewer-in 0.18s ease; }
@keyframes pxc-viewer-in { from { opacity: 0; } to { opacity: 1; } }
.pxc-viewer-img { max-width: min(92vw, 1400px); max-height: 86vh; object-fit: contain;
  border-radius: var(--a2ui-radius-lg); box-shadow: 0 24px 90px rgba(0,0,0,0.65); }
.pxc-viewer-btn { position: absolute; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--pxs-glass-border); background: var(--a2ui-glass-dark); backdrop-filter: blur(10px);
  color: var(--a2ui-text-primary); cursor: pointer; border-radius: var(--a2ui-radius-full);
  transition: background var(--a2ui-transition-fast); }
.pxc-viewer-btn:hover { background: var(--a2ui-bg-elevated); }
.pxc-viewer-close { top: 20px; right: 20px; width: 40px; height: 40px; }
.pxc-viewer-prev, .pxc-viewer-next { top: 50%; transform: translateY(-50%); width: 46px; height: 46px; }
.pxc-viewer-prev { left: 20px; }
.pxc-viewer-prev svg { transform: rotate(180deg); }
.pxc-viewer-next { right: 20px; }
.pxc-viewer-meta { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 6px 14px; border-radius: var(--a2ui-radius-full); font-size: var(--a2ui-text-sm);
  color: var(--a2ui-text-secondary); background: var(--a2ui-glass-dark); backdrop-filter: blur(10px);
  border: 1px solid var(--pxs-glass-border); font-variant-numeric: tabular-nums; }
/* PENDING tile — a thumbnail-SHAPED placeholder (same fixed size as a real tile) with a shimmer
   sweep and the model's honest phase. Not a bare spinner: the tile that will hold the image is
   already there, so a slow model reads as "working", never as "nothing happened". */
.pxc-stage-pending {
  position: relative; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
  color: var(--a2ui-text-tertiary); font-size: var(--a2ui-text-sm);
  aspect-ratio: 4 / 3; border-radius: var(--a2ui-radius-lg); padding: var(--a2ui-space-3);
  background: var(--a2ui-bg-tertiary); box-shadow: 0 0 0 1px var(--pxs-border-subtle);
  text-align: center;
}
/* The sweep rides ABOVE the tile bg but below the text — the "developing" read. */
.pxc-stage-pending::before {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 20%, var(--a2ui-bg-elevated) 50%, transparent 80%);
  background-size: 220% 100%; animation: pxc-stage-shimmer 1.8s var(--a2ui-ease-entrance) infinite;
}
.pxc-stage-pending > * { position: relative; }
.pxc-stage-pending-label { color: var(--a2ui-text-secondary); font-size: var(--a2ui-text-xs);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
/* The honest PHASE — what this model's call is actually doing right now. Never a fake percentage:
   image adapters don't stream progress, so we show the phase we truly know. */
.pxc-stage-phase { font-size: 10px; color: var(--a2ui-text-tertiary); }
/* A landed image FADES over its skeleton rather than snapping in — the one cheap polish that makes a
   live fan feel composed. Pure CSS on mount; no new state. */
@keyframes pxc-tile-in { from { opacity: 0; } to { opacity: 1; } }
.pxc-stage-tile img { animation: pxc-tile-in 0.28s var(--a2ui-ease-entrance) both; }
.pxc-stage-spinner { width: 15px; height: 15px; flex-shrink: 0; border-radius: 50%;
  border: 2px solid var(--pxs-border-subtle); border-top-color: var(--pxs-accent-text);
  animation: pxc-stage-spin 0.7s linear infinite; }
@keyframes pxc-stage-spin { to { transform: rotate(360deg); } }
@keyframes pxc-stage-pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 0.9; } }
@keyframes pxc-stage-shimmer { 0% { background-position: 180% 0; } 100% { background-position: -80% 0; } }

/* STREAM view — arrival order in the shared responsive grid. UNIFORM tiles: images land in
   unpredictable completion order, and varied bento spans would reshuffle the whole grid on every
   arrival. Uniform keeps a live fan calm. */

/* Empty state — the mockup's clean full-bleed canvas: the shared <GreetingHero> lockup invites the
   first prompt (the workflow carousel is a later slice). Calm, no glyph, no marketing. The title +
   subtitle type lives in GreetingHero so it stays identical to the chat splash. */
.pxc-stage-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--a2ui-space-2); padding: var(--a2ui-space-8); text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .pxc-stage-pending { animation: none; }
  .pxc-stage-pending::before { animation: none; opacity: 0.5; }
  .pxc-stage-spinner { animation: none; }
}
`;

/** "a car" / "an owl" / "the dragon" → "car" / "owl" / "dragon" so "shape your {subject}" reads right. */
function cleanSubject(s: string): string {
  return s.replace(/^\s*(a|an|the)\s+/i, '').trim() || s.trim();
}

/** The adapter's failure reason → plain words (mirrors FanStatus — same honest taxonomy). */
function plainReason(reason?: string): string {
  switch (reason) {
    case 'no_key': return 'no API key';
    case 'moderated': return 'blocked by the provider';
    case 'timeout': return 'timed out';
    case 'rate_limited': return 'rate limited';
    case 'bad_request': return 'rejected the request';
    case 'transport': return 'connection failed';
    case 'unknown': case undefined: case '': return 'failed';
    default: return reason.length > 48 ? `${reason.slice(0, 45)}…` : reason;
  }
}

/**
 * The honest PHASE for a still-cooking tile. Image adapters don't stream per-image progress, so we
 * only ever say what we genuinely know: the call is queued, it's on the wire, or some of this
 * model's batch has already landed. Never a fabricated percentage.
 */
function phaseText(f: { state: FanModelStatus['state']; delivered: number; n: number } | undefined): string {
  if (!f) return 'rendering…';
  if (f.state === 'pending') return 'queued…';
  if (f.delivered > 0) return `${f.delivered} of ${f.n} in…`;
  return 'waiting on the provider…';
}

/** The status glyph for a model column (matches FanStatus's vocabulary). */
function StateGlyph({ state }: { state: FanModelStatus['state'] }) {
  return (
    <span className="pxc-stage-state" data-state={state} title={state === 'failed' ? 'failed' : state === 'done' ? 'done' : state === 'running' ? 'rendering' : 'queued'}>
      {state === 'done' ? (
        <svg viewBox="0 0 12 12" fill="none" width="12" height="12" aria-hidden="true">
          <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === 'failed' ? (
        <svg viewBox="0 0 12 12" fill="none" width="12" height="12" aria-hidden="true">
          <path d="M6 1.5 L11 10.5 L1 10.5 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M6 5 L6 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="6" cy="9" r="0.6" fill="currentColor" />
        </svg>
      ) : state === 'running' ? (
        <span className="pxc-stage-spinner" />
      ) : (
        <span className="pxc-stage-dot" />
      )}
    </span>
  );
}

export function ImageStage({ images, generating, genPlan, fanTurnId, medium, contextLabel, onSaveAsset }: ImageStageProps) {
  const isVideo = medium === 'video';
  const label = isVideo ? 'video' : 'image';
  // A fan that produced NOTHING still has content to show: the failed columns and their reasons.
  // (Falling back to the empty "what do you want to create?" state would erase the run entirely.)
  const hasContent = images.length > 0 || generating || (genPlan?.length ?? 0) > 0;
  const ctx = contextLabel?.trim();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // Results LENS — grouped by model (default: decision closure) ↔ stream order (watching it land).
  // Read from localStorage after mount so SSR/hydration match, then persisted on every change.
  const [view, setView] = useState<StageView>('grouped');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === 'stream' || stored === 'grouped') setView(stored);
    } catch {
      /* storage may be unavailable (private mode) — the default stands */
    }
  }, []);
  const chooseView = (v: StageView) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* non-fatal — the choice still applies for this session */
    }
  };

  const keyOf = (img: StageImage) => `${img.turnId}-${img.index}`;
  const handleSave = async (img: StageImage) => {
    if (!onSaveAsset || saved.has(keyOf(img))) return;
    setSavingKey(keyOf(img));
    const ok = await onSaveAsset(img).catch(() => false);
    setSavingKey(null);
    if (ok) setSaved((prev) => new Set(prev).add(keyOf(img)));
  };
  const handleCopy = async (img: StageImage) => {
    try {
      const blob = await (await fetch(img.url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toastManager.success('Copied to clipboard');
    } catch {
      try {
        await navigator.clipboard.writeText(img.url);
        toastManager.success('Image URL copied');
      } catch {
        toastManager.error('Could not copy');
      }
    }
  };

  // Group the fan-out results by MODEL — one column per model (decision closure: every model's take
  // side by side). Preserve each tile's GLOBAL index so the full-screen viewer still walks the whole set.
  const arrived = new Map<string, { img: StageImage; gi: number }[]>();
  images.forEach((img, gi) => {
    const label = img.modelLabel || 'Model';
    if (!arrived.has(label)) arrived.set(label, []);
    arrived.get(label)!.push({ img, gi });
  });

  // MERGE the fan STATUS with what's arrived: every model in the fan gets a column NOW (its tiles so
  // far + a shimmer tile per image still cooking + its live state), so you see all N models working at
  // once — not one lone spinner. A FAILED model keeps its column and says why, instead of its loaders
  // silently vanishing. Falls back to arrived-only when there's no fan (an older persisted render).
  const fullPlan = genPlan && genPlan.length > 0 ? genPlan : null;
  // Benched models are shown as a compact note, not empty columns. Active models drive the columns.
  const skipped = fullPlan ? fullPlan.filter((p) => p.state === 'skipped') : [];
  const plan = fullPlan ? fullPlan.filter((p) => p.state !== 'skipped') : null;
  /** Tiles THIS render landed for a model — the loader math must ignore earlier renders' images. */
  const landedThisRun = (modelLabel: string) =>
    (arrived.get(modelLabel) ?? []).filter(({ img }) => (fanTurnId ? img.turnId === fanTurnId : true)).length;
  const groups: {
    label: string;
    items: { img: StageImage; gi: number }[];
    pending: number;
    state: FanModelStatus['state'];
    reason?: string;
    why?: string;
    /** Tiles this model landed in THIS run (the failure tile keys off it, not the whole session). */
    runLanded: number;
  }[] = plan
    ? plan.map((p) => {
        const items = arrived.get(p.label) ?? [];
        const runLanded = landedThisRun(p.label);
        // A failed model shows NO pending loaders — its slot carries the failure tile instead.
        const pending = p.state === 'failed' || p.state === 'done' ? 0 : Math.max(0, p.n - runLanded);
        return { label: p.label, items, pending, state: p.state, reason: p.reason, why: p.why, runLanded };
      })
    : [...arrived.entries()].map(([label, items]) => ({ label, items, pending: 0, state: 'done' as const, runLanded: items.length }));
  // A model that streamed a tile but wasn't in the fan (safety) still gets its column.
  if (plan) {
    for (const [label, items] of arrived) {
      if (!plan.some((p) => p.label === label)) groups.push({ label, items, pending: 0, state: 'done', runLanded: items.length });
    }
  }
  const multiModel = groups.length > 1;
  // Best-fit FIRST — the agent's ranking becomes the column order, made explicit with a #rank badge.
  groups.sort((a, b) => (b.items[0]?.img.score ?? 0) - (a.items[0]?.img.score ?? 0));

  // STREAM view — every still-cooking slot across the whole fan, in fan order, so loaders and landed
  // tiles interleave as one live feed (the POC's arrival-order lens).
  const streamPending = plan
    ? plan.flatMap((p) => {
        const left = p.state === 'failed' || p.state === 'done' ? 0 : Math.max(0, p.n - landedThisRun(p.label));
        return Array.from({ length: left }, (_, i) => ({ key: `${p.modelId || p.label}-${i}`, f: p }));
      })
    : [];
  const streamFailed = plan ? plan.filter((p) => p.state === 'failed') : [];

  const renderTile = (img: StageImage, gi: number, cls: string) => (
    <div key={`${img.turnId}-${img.index}`} className={`pxc-stage-tile ${cls}`} tabIndex={0}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {isPlayable(img.url) ? (
        // A clip is PLAYABLE media, not a picture: muted + loop + playsInline so a grid of results
        // behaves like contact sheets rather than a wall of things demanding to be clicked.
        <video src={img.url} muted loop playsInline preload="metadata" onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img.url} alt={img.modelLabel || 'generated image'} />
      )}
      <div className="pxc-stage-overlay">
        {onSaveAsset && (
          <button
            type="button"
            className="pxc-stage-icon"
            data-on={saved.has(keyOf(img)) ? 'true' : 'false'}
            onClick={() => handleSave(img)}
            disabled={savingKey === keyOf(img) || saved.has(keyOf(img))}
            title={saved.has(keyOf(img)) ? 'Saved to Assets' : 'Save to Assets'}
          >
            <Icon name={saved.has(keyOf(img)) ? 'check' : 'save'} size={15} />
          </button>
        )}
        <button type="button" className="pxc-stage-icon" onClick={() => setViewerIndex(gi)} title="View">
          <Icon name="eye" size={15} />
        </button>
        <button type="button" className="pxc-stage-icon" onClick={() => handleCopy(img)} title="Copy image">
          <Icon name="copy" size={15} />
        </button>
        <a className="pxc-stage-icon" href={img.url} download={`pixcel-${img.index + 1}.png`} title="Download">
          <Icon name="download" size={15} />
        </a>
      </div>
      {img.modelLabel && <span className="pxc-stage-badge">{img.modelLabel}</span>}
    </div>
  );

  return (
    <div className="pxc-stage relative flex-1 flex flex-col min-w-0 min-h-0">
      <style>{CSS}</style>

      {hasContent ? (
        <>
          <div className="pxc-stage-head">
            <span className="pxc-stage-label">Results</span>
            {/* The two lenses on one fan. Only worth offering once there's more than one model. */}
            {(multiModel || streamPending.length > 0) && (
              /* Two anonymous glyphs told you nothing about what either lens does — labelled, with
                 arrival order first because that's what you watch while the fan is still running. */
              <div className="pxc-stage-views" role="group" aria-label="Results view">
                <button
                  type="button"
                  className="pxc-stage-view"
                  data-on={view === 'stream' ? 'true' : 'false'}
                  onClick={() => chooseView('stream')}
                  title="Every image in the order it landed"
                  aria-pressed={view === 'stream'}
                >
                  <Icon name="list" size={13} />
                  Stream order
                </button>
                <button
                  type="button"
                  className="pxc-stage-view"
                  data-on={view === 'grouped' ? 'true' : 'false'}
                  onClick={() => chooseView('grouped')}
                  title="Each model's take, side by side"
                  aria-pressed={view === 'grouped'}
                >
                  <Icon name="grid" size={13} />
                  Group by model
                </button>
              </div>
            )}
          </div>
          <div className="pxc-stage-scroll">
            {/* Benched models — accounted for as a compact note so a smaller-than-picked fan is never a
                silent mystery (e.g. Flux holds 1 reference but you attached 3). */}
            {skipped.length > 0 && (
              <div className="pxc-stage-skipped">
                {skipped.map((sm) => (
                  <span key={sm.modelId || sm.label} className="pxc-stage-skip-item">
                    <span className="pxc-stage-skip-dash">–</span> {sm.label}
                    {sm.reason ? <span className="pxc-stage-skip-reason"> · {sm.reason}</span> : null}
                  </span>
                ))}
              </div>
            )}
            {/* Pre-routing: generating but the fan isn't known yet — one honest loader until it lands. */}
            {generating && groups.length === 0 && (
              <div className="pxc-tiles">
                <div>
                  <div className="pxc-stage-pending">
                    <span className="pxc-stage-spinner" />
                    <span className="pxc-stage-pending-label">Routing…</span>
                    <span className="pxc-stage-phase">choosing the models</span>
                  </div>
                </div>
              </div>
            )}

            {view === 'grouped' ? (
              /* GROUPED — one column per model. Each shows its state chip, its tiles, and a shimmer
                 tile per image still cooking; a failed model keeps its slot and says why. */
              <div className="pxc-stage-groups">
                {groups.map((g, ri) => (
                  <div key={g.label} className="pxc-stage-group">
                    {multiModel && (
                      <div className="pxc-stage-group-head">
                        {g.items[0]?.img.score != null && (
                          <span className="pxc-stage-score" title={g.why || "Model agent's fit rank for this prompt"}>#{ri + 1}</span>
                        )}
                        <StateGlyph state={g.state} />
                        <span className="pxc-stage-model" title={g.why || g.label}>{g.label}</span>
                        {g.items.length + g.pending > 1 && (
                          <span className="pxc-stage-count" title="Images from this model">{g.items.length + g.pending}</span>
                        )}
                      </div>
                    )}
                    <div className="pxc-tiles">
                      {g.items.map(({ img, gi }) => renderTile(img, gi, ''))}
                      {Array.from({ length: g.pending }).map((_, i) => (
                        <div key={`pending-${g.label}-${i}`} className="pxc-stage-pending">
                          <span className="pxc-stage-spinner" />
                          <span className="pxc-stage-pending-label">{g.label}</span>
                          <span className="pxc-stage-phase">
                            {phaseText({ state: g.state, delivered: g.runLanded, n: g.runLanded + g.pending })}
                          </span>
                        </div>
                      ))}
                      {/* The failure KEEPS the slot — the model that didn't deliver is still accounted for. */}
                      {g.state === 'failed' && g.runLanded === 0 && (
                        <div className="pxc-stage-failed">
                          <StateGlyph state="failed" />
                          <span>{plainReason(g.reason)}</span>
                          <span className="pxc-stage-failed-sub">{g.label} delivered nothing</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* STREAM — arrival order, one flat feed: landed tiles first (newest-first ordering is
                 already applied upstream), then everything still cooking, then any failures. */
              <div className="pxc-tiles">
                {images.map((img, gi) => renderTile(img, gi, ''))}
                {streamPending.map(({ key, f }) => (
                  <div key={`stream-pending-${key}`} className="pxc-stage-pending">
                    <span className="pxc-stage-spinner" />
                    <span className="pxc-stage-pending-label">{f.label}</span>
                    <span className="pxc-stage-phase">{phaseText(f)}</span>
                  </div>
                ))}
                {streamFailed.map((f) => (
                  <div key={`stream-failed-${f.modelId || f.label}`} className="pxc-stage-failed">
                    <StateGlyph state="failed" />
                    <span>{plainReason(f.reason)}</span>
                    <span className="pxc-stage-failed-sub">{f.label} delivered nothing</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="pxc-stage-empty">
          {ctx ? (
            <GreetingHero
              size="compact"
              title={`Let’s shape your ${cleanSubject(ctx)}.`}
              subtitle="Shape it in the panel on the right — tune the parts, tap the chips, then Render. Your images land here."
            />
          ) : (
            <GreetingHero
              size="compact"
              title={`What ${label}(s) do you want to create?`}
              subtitle={
                isVideo
                  ? 'e.g. a slow push-in on a rain-soaked neon street, cinematic'
                  : 'e.g. a rain-soaked neon portrait at dusk, cinematic'
              }
            />
          )}
        </div>
      )}

      {viewerIndex !== null && images[viewerIndex] && (
        <StageViewer images={images} index={viewerIndex} onIndex={setViewerIndex} onClose={() => setViewerIndex(null)} />
      )}
    </div>
  );
}

/** Full-screen artifact viewer — browse the project's images large, prev/next (arrows or ←/→). */
function StageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: StageImage[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onIndex, onClose]);

  const img = images[index];
  return (
    <div className="pxc-viewer" onClick={onClose} role="dialog" aria-modal="true">
      <button type="button" className="pxc-viewer-btn pxc-viewer-close" onClick={onClose} aria-label="Close viewer">
        <Icon name="x" size={18} />
      </button>
      {index > 0 && (
        <button type="button" className="pxc-viewer-btn pxc-viewer-prev" onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }} aria-label="Previous">
          <Icon name="arrow-right" size={20} />
        </button>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="pxc-viewer-img" src={img.url} alt={img.modelLabel || 'artifact'} onClick={(e) => e.stopPropagation()} />
      {index < images.length - 1 && (
        <button type="button" className="pxc-viewer-btn pxc-viewer-next" onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }} aria-label="Next">
          <Icon name="arrow-right" size={20} />
        </button>
      )}
      <div className="pxc-viewer-meta">
        {img.modelLabel ? `${img.modelLabel} · ` : ''}{index + 1} / {images.length}
      </div>
    </div>
  );
}

export default ImageStage;
