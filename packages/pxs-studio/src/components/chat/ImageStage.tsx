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

export interface StageImage {
  url: string;
  modelLabel: string;
  index: number;
  turnId: string;
  /** Fan-out fit score the model was picked by — used to RANK the model columns (best fit first). */
  score?: number;
}

interface ImageStageProps {
  images: StageImage[];
  generating: boolean;
  /** The active render's fan plan (model label + images each) — drives one loader group per model so
   *  every model in the fan shows as "cooking" at once, not a single ambiguous spinner. */
  genPlan?: { label: string; n: number }[];
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
.pxc-stage-head { display: flex; align-items: center; padding: var(--a2ui-space-5) var(--a2ui-space-6) 0; }
.pxc-stage-label {
  font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-semibold);
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--a2ui-text-tertiary);
}

/* FAN-OUT — one column per model, packed from the left. EVERY tile is the SAME FIXED SIZE (fixed column
   width × a fixed 4:3 box, image letterboxed inside): no more "one big, one small" — uniform, and three
   models sit side-by-side above the fold. Columns are a fixed width so the grid never stretches a lone
   image to fill the canvas. */
.pxc-stage-groups { display: grid; grid-template-columns: repeat(auto-fill, var(--pxc-tile-w, 340px)); justify-content: start; gap: var(--a2ui-space-5) var(--a2ui-space-4); align-items: start; }
.pxc-stage-group { min-width: 0; display: flex; flex-direction: column; gap: var(--a2ui-space-3); }
.pxc-stage-group-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pxc-stage-model { font-size: var(--a2ui-text-sm); font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Per-model FIT SCORE — the badge that speeds the choosing once the field is trusted. */
.pxc-stage-score { flex-shrink: 0; display: inline-flex; align-items: center; height: 18px; padding: 0 7px;
  border-radius: var(--a2ui-radius-full); font-family: var(--a2ui-font-mono); font-size: 10px; font-variant-numeric: tabular-nums;
  color: var(--pxs-accent-text); background: var(--a2ui-accent-subtle); border: 1px solid var(--a2ui-border-subtle); }
.pxc-stage-count { margin-left: auto; flex-shrink: 0; font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); font-variant-numeric: tabular-nums; }

.pxc-stage-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; min-width: 0; padding: var(--a2ui-space-5) var(--a2ui-space-6) var(--a2ui-space-8); }
/* BENTO — a repeating 4-tile rhythm (hero 16/9 span-2 · square · square · wide 16/10 span-2) over a
   2-col grid, so results pack like the mock instead of a uniform square grid. "dense" backfills the
   holes that spanning tiles would otherwise leave. */
.pxc-stage-grid {
  display: grid; gap: var(--a2ui-space-4);
  grid-template-columns: 1fr 1fr;
  grid-auto-flow: row dense;
}
.pxc-stage-tile {
  position: relative; overflow: hidden; aspect-ratio: 4 / 3;
  border-radius: var(--a2ui-radius-lg); background: var(--a2ui-bg-tertiary);
  box-shadow: 0 0 0 1px var(--pxs-border-subtle);
  transition: box-shadow var(--a2ui-transition-fast);
}
.pxc-bento-hero { grid-column: span 2; aspect-ratio: 16 / 9; }
.pxc-bento-wide { grid-column: span 2; aspect-ratio: 16 / 10; }
.pxc-bento-sq   { aspect-ratio: 1 / 1; }
/* BOLD-mode accent washes — alternating coral/violet radial under each tile (behind the image, so a
   real thumbnail covers it; it reads on empty/loading tiles). Professional flips --px-tint-* neutral. */
.pxc-stage-tile:hover { box-shadow: 0 0 0 1px var(--a2ui-border-default); }
/* CONTAIN, not cover — never crop what the model made (a character sheet is the whole image). Letterbox
   on the tile bg. */
.pxc-stage-tile img { width: 100%; height: 100%; object-fit: contain; display: block; background: var(--a2ui-bg-tertiary); }
.pxc-stage-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: flex-start; justify-content: flex-end; gap: 6px;
  padding: var(--a2ui-space-3);
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
.pxc-stage-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
  border-radius: var(--a2ui-radius-md); border: 1px solid var(--pxs-glass-border);
  background: var(--a2ui-glass-dark); backdrop-filter: blur(8px); color: var(--a2ui-text-primary);
  cursor: pointer; transition: background var(--a2ui-transition-fast); text-decoration: none;
}
.pxc-stage-icon:hover { background: var(--a2ui-bg-elevated); }
.pxc-stage-icon[data-on="true"] { color: var(--a2ui-success); }
.pxc-stage-icon:disabled { cursor: default; }
.pxc-stage-badge {
  position: absolute; left: 8px; bottom: 8px;
  padding: 2px 8px; border-radius: var(--a2ui-radius-full);
  font-size: var(--a2ui-text-xs); color: var(--a2ui-text-primary);
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
.pxc-stage-pending {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--a2ui-text-tertiary); font-size: var(--a2ui-text-sm);
  aspect-ratio: 4 / 3; border-radius: var(--a2ui-radius-lg);
  background: var(--a2ui-bg-tertiary); box-shadow: 0 0 0 1px var(--pxs-border-subtle);
  animation: pxc-stage-pulse 1.4s ease-in-out infinite;
}
.pxc-stage-spinner { width: 15px; height: 15px; flex-shrink: 0; border-radius: 50%;
  border: 2px solid var(--pxs-border-subtle); border-top-color: var(--pxs-accent-text);
  animation: pxc-stage-spin 0.7s linear infinite; }
@keyframes pxc-stage-spin { to { transform: rotate(360deg); } }
@keyframes pxc-stage-pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 0.9; } }

/* Empty state — the mockup's clean full-bleed canvas: the shared <GreetingHero> lockup invites the
   first prompt (the workflow carousel is a later slice). Calm, no glyph, no marketing. The title +
   subtitle type lives in GreetingHero so it stays identical to the chat splash. */
.pxc-stage-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--a2ui-space-2); padding: var(--a2ui-space-8); text-align: center;
}

@media (prefers-reduced-motion: reduce) { .pxc-stage-pending { animation: none; } }
`;

/** "a car" / "an owl" / "the dragon" → "car" / "owl" / "dragon" so "shape your {subject}" reads right. */
function cleanSubject(s: string): string {
  return s.replace(/^\s*(a|an|the)\s+/i, '').trim() || s.trim();
}

/** Bento rhythm — a repeating 4-tile cycle: hero (span-2 16/9) · square · square · wide (span-2 16/10). */
function bentoClass(i: number): string {
  const m = i % 4;
  if (m === 0) return 'pxc-bento-hero';
  if (m === 3) return 'pxc-bento-wide';
  return 'pxc-bento-sq';
}

export function ImageStage({ images, generating, genPlan, medium, contextLabel, onSaveAsset }: ImageStageProps) {
  const isVideo = medium === 'video';
  const label = isVideo ? 'video' : 'image';
  const hasContent = images.length > 0 || generating;
  const ctx = contextLabel?.trim();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

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

  // MERGE the fan PLAN with what's arrived: every planned model gets a column NOW (with its tiles so far
  // + a loader per image still cooking), so you see all N models working at once — not one lone spinner.
  // Fall back to arrived-only when there's no plan (e.g. reload of a finished render).
  const plan = generating && genPlan && genPlan.length > 0 ? genPlan : null;
  const groups: { label: string; items: { img: StageImage; gi: number }[]; pending: number }[] = plan
    ? plan.map((p) => {
        const items = arrived.get(p.label) ?? [];
        return { label: p.label, items, pending: Math.max(0, p.n - items.length) };
      })
    : [...arrived.entries()].map(([label, items]) => ({ label, items, pending: 0 }));
  // A model that streamed a tile but wasn't in the plan (safety) still gets its column.
  if (plan) {
    for (const [label, items] of arrived) {
      if (!plan.some((p) => p.label === label)) groups.push({ label, items, pending: 0 });
    }
  }
  const multiModel = groups.length > 1;
  // Best-fit FIRST — the agent's ranking becomes the column order, made explicit with a #rank badge.
  groups.sort((a, b) => (b.items[0]?.img.score ?? 0) - (a.items[0]?.img.score ?? 0));

  const renderTile = (img: StageImage, gi: number, cls: string) => (
    <div key={`${img.turnId}-${img.index}`} className={`pxc-stage-tile ${cls}`} tabIndex={0}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img.url} alt={img.modelLabel || 'generated image'} />
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
          <div className="pxc-stage-head"><span className="pxc-stage-label">Results</span></div>
          <div className="pxc-stage-scroll">
            {/* One column per model (planned OR arrived). Each shows its tiles + a loader per image still
                cooking — so all N models read as "working" at once, and every tile is the SAME fixed size. */}
            <div className="pxc-stage-groups">
              {/* Pre-routing: generating but the fan isn't known yet — one honest loader until gen_plan lands. */}
              {generating && groups.length === 0 && (
                <div className="pxc-stage-group">
                  <div className="pxc-stage-pending"><span className="pxc-stage-spinner" /> Routing…</div>
                </div>
              )}
              {groups.map((g, ri) => (
                <div key={g.label} className="pxc-stage-group">
                  {multiModel && (
                    <div className="pxc-stage-group-head">
                      {g.items[0]?.img.score != null && <span className="pxc-stage-score" title="Model agent's fit rank for this prompt">#{ri + 1}</span>}
                      <span className="pxc-stage-model">{g.label}</span>
                      {g.items.length + g.pending > 1 && <span className="pxc-stage-count" title="Images from this model">{g.items.length + g.pending}</span>}
                    </div>
                  )}
                  {g.items.map(({ img, gi }) => renderTile(img, gi, ''))}
                  {Array.from({ length: g.pending }).map((_, i) => (
                    <div key={`pending-${g.label}-${i}`} className="pxc-stage-pending">
                      <span className="pxc-stage-spinner" /> {g.label}
                    </div>
                  ))}
                </div>
              ))}
            </div>
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
