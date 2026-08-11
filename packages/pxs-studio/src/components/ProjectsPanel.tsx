'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * ProjectsPanel — the projects list (Slice 5). THE THREAD IS THE PROJECT.
 *
 * A left-docked slide-out (next to the persistent NavRail) listing the user's projects — the saved
 * chat threads — sorted by LAST-UPDATED (a project rises when you work on it or open it, the
 * Cursor/Claude-Code history pattern). Click a project → it loads and nothing is lost (the 360°
 * loop). "New project" starts a fresh thread. Additive — does not touch the nav or the workspace.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from 'react';
import { Icon, SegmentedControl, SortMenu } from './ui';
import { toastManager } from './Toast';
import { SaveTemplateDialog } from './SaveTemplateDialog';
import { useChatTurnsStore } from '../store/chat-turns-store';
import { DEV_USER_ID } from '../lib/db/models';

interface ProjectRow {
  id: string;
  title: string;
  updated_at: number;
  /** Draft (ephemeral) vs Saved — the lifecycle from auto-promotion. Legacy rows read as 'saved'. */
  retention?: 'ephemeral' | 'saved';
  /** Ephemeral only — when the draft is GC-eligible (ms epoch). */
  expires_at?: number;
  asset_count?: number;
}

/** Sort keys honored from thread metadata (Type/Size from the mock don't apply to projects). */
type ProjectSort = 'date' | 'name';
const PROJECT_SORT_OPTIONS: { value: ProjectSort; label: string }[] = [
  { value: 'date', label: 'Date added' },
  { value: 'name', label: 'Name' },
];

/** The one-list filter (§ Slice 3): All · Saved · Drafts, default All. */
type ProjectFilter = 'all' | 'saved' | 'drafts';

/** Draft expiry, humanized. Null when there's no expiry (a saved project). */
function expiryLabel(expires_at?: number): string | null {
  if (!expires_at) return null;
  const days = Math.ceil((expires_at - Date.now()) / 86_400_000);
  return days <= 0 ? 'expires soon' : `expires in ${days}d`;
}

const isDraftRow = (p: ProjectRow): boolean => (p.retention ?? 'saved') === 'ephemeral';

/** The meta tail after the timestamp: a draft shows its expiry (amber); anything with assets shows the
 *  count. Returns a fragment beginning with " · " so it appends onto relTime, or null. */
function MetaTail({ p }: { p: ProjectRow }): JSX.Element | null {
  const n = p.asset_count ?? 0;
  if (isDraftRow(p)) {
    const exp = expiryLabel(p.expires_at);
    if (exp) return <> · <span className="pxp-expiry">{exp}</span></>;
  }
  return n > 0 ? <> · {n} asset{n === 1 ? '' : 's'}</> : null;
}

const CSS = `
/* A floating GLASS popover that OVERLAYS the canvas (does not push/box it) — a bubble connected to
   the rail's Projects control. Same .pxc-glass pattern: glass fill + subtle border + blur, no shadow,
   rounded, floating clear of the top/bottom edges. The left offset (inline) clears the rail. */
.pxp[data-full="true"] { right: var(--pxs-rail-inset); width: auto; }
/* FULL header — mirror the Assets full view: big title + description + right controls. */
.pxp[data-full="true"] .pxp-head { align-items: flex-start; padding: var(--a2ui-space-6) var(--a2ui-space-6) var(--a2ui-space-4); }
.pxp-h1 { margin: 0; font-size: var(--a2ui-text-2xl); font-weight: var(--a2ui-font-semibold); letter-spacing: -0.01em;
  color: var(--a2ui-text-primary); text-transform: none; }
.pxp-sub { margin: 4px 0 0; font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); }
.pxp[data-full="true"] .pxp-new { margin-left: var(--a2ui-space-6); margin-right: var(--a2ui-space-6); }
.pxp[data-full="true"] .pxp-list { padding: 0 var(--a2ui-space-5) var(--a2ui-space-4); }
/* FULL grid view — cards with a 16/10 cover, name, meta. */
.pxp-grid { flex: 1; overflow-y: auto; padding: 0 var(--a2ui-space-6) var(--a2ui-space-6);
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--a2ui-space-4); align-content: start; }
.pxp-card { display: flex; flex-direction: column; border-radius: var(--a2ui-radius-lg); overflow: hidden;
  background: var(--a2ui-bg-tertiary); box-shadow: 0 0 0 1px var(--pxs-border-subtle); cursor: pointer;
  transition: box-shadow var(--a2ui-transition-fast); text-align: left; border: none; padding: 0; font-family: inherit; }
.pxp-card:hover { box-shadow: 0 0 0 1px var(--a2ui-border-default); }
.pxp-card[data-on="true"] { box-shadow: 0 0 0 2px var(--a2ui-accent); }
.pxp-cover { aspect-ratio: 16 / 10; display: flex; align-items: center; justify-content: center; color: var(--a2ui-text-secondary); }
.pxp-cover[data-wash="a"] { background: radial-gradient(130% 120% at 30% 20%, var(--px-tint-coral), var(--a2ui-bg-secondary) 70%); }
.pxp-cover[data-wash="b"] { background: radial-gradient(130% 120% at 70% 25%, var(--px-tint-violet), var(--a2ui-bg-secondary) 70%); }
.pxp-card-meta { padding: 10px 12px 12px; }
.pxp-card-name { font-size: var(--a2ui-text-sm); font-weight: var(--a2ui-font-medium); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--a2ui-text-primary); }
.pxp-card-sub { margin-top: 2px; font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); }
/* Folder glyph on list rows (mock parity). */
.pxp-item-icon { display: inline-flex; align-items: center; justify-content: center; width: 26px; flex-shrink: 0; color: var(--a2ui-text-tertiary); }
.pxp-full { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--pxc-border-subtle);
  border-radius: var(--a2ui-radius-md); background: none; color: var(--a2ui-text-tertiary); font-family: inherit;
  font-size: var(--a2ui-text-xs); cursor: pointer; transition: color var(--a2ui-transition-fast), border-color var(--a2ui-transition-fast); }
.pxp-full:hover { color: var(--a2ui-text-primary); border-color: var(--a2ui-border-default); }
.pxp { position: absolute; top: 16px; bottom: 16px; z-index: 25; width: 300px;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--pxc-bg-glass-20);
  backdrop-filter: var(--pxc-glass-filter); -webkit-backdrop-filter: var(--pxc-glass-filter);
  border: 1px solid var(--pxc-border-subtle); border-radius: 16px; box-shadow: none;
  font-family: var(--a2ui-font-family); animation: pxp-in 0.22s cubic-bezier(0.22,1,0.36,1); }
@keyframes pxp-in { from { transform: translateX(-8px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
.pxp-head { display: flex; align-items: center; justify-content: space-between; gap: var(--a2ui-space-2);
  padding: var(--a2ui-space-4) var(--a2ui-space-4) var(--a2ui-space-3); }
.pxp-title { font-size: var(--a2ui-text-sm); font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em; }
.pxp-x { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border: none;
  background: none; color: var(--a2ui-text-tertiary); cursor: pointer; border-radius: var(--a2ui-radius-md); }
.pxp-x:hover { background: var(--a2ui-bg-hover); color: var(--a2ui-text-primary); }
.pxp-new { display: flex; align-items: center; gap: 8px; margin: 0 var(--a2ui-space-3) var(--a2ui-space-3);
  height: 38px; padding: 0 12px; border: 1px dashed var(--a2ui-border-default); border-radius: var(--a2ui-radius-md);
  background: none; color: var(--a2ui-text-secondary); font-family: inherit; font-size: var(--a2ui-text-sm);
  font-weight: var(--a2ui-font-medium); cursor: pointer; transition: color var(--a2ui-transition-fast), border-color var(--a2ui-transition-fast); }
.pxp-new:hover { color: var(--a2ui-text-primary); border-color: var(--a2ui-accent); }
.pxp-list { flex: 1; overflow-y: auto; padding: 0 var(--a2ui-space-2) var(--a2ui-space-3);
  display: flex; flex-direction: column; gap: 1px; }
.pxp-item { position: relative; display: flex; align-items: center; border-radius: var(--a2ui-radius-md);
  transition: background var(--a2ui-transition-fast); }
.pxp-item:hover { background: var(--a2ui-bg-hover); }
.pxp-item[data-on="true"] { background: var(--a2ui-bg-active); }
.pxp-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px;
  border: none; background: none; text-align: left; cursor: pointer; }
.pxp-item-title { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-primary); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.pxp-item-time { font-size: var(--a2ui-text-xs); color: var(--a2ui-text-tertiary); }
.pxp-acts { display: flex; gap: 1px; padding-right: 6px; opacity: 0; transition: opacity var(--a2ui-transition-fast); }
.pxp-item:hover .pxp-acts { opacity: 1; }
.pxp-mini { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: none;
  background: none; color: var(--a2ui-text-tertiary); cursor: pointer; border-radius: var(--a2ui-radius-sm); }
.pxp-mini:hover { background: var(--a2ui-bg-active); color: var(--a2ui-text-primary); }
.pxp-mini--danger:hover { color: var(--a2ui-error, #f87171); }
.pxp-edit { flex: 1; min-width: 0; margin: 5px 8px; padding: 6px 8px; border-radius: var(--a2ui-radius-sm);
  border: 1px solid var(--a2ui-accent); background: var(--a2ui-bg-input); color: var(--a2ui-text-primary);
  font-family: inherit; font-size: var(--a2ui-text-sm); }
.pxp-edit:focus { outline: none; box-shadow: 0 0 0 2px var(--a2ui-accent-subtle); }
.pxp-confirm { display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 10px; width: 100%; }
.pxp-confirm-txt { flex: 1; min-width: 0; font-size: var(--a2ui-text-xs); color: var(--a2ui-text-secondary); }
.pxp-cbtn { height: 24px; padding: 0 9px; border-radius: var(--a2ui-radius-sm); border: none; font-family: inherit;
  font-size: var(--a2ui-text-xs); font-weight: var(--a2ui-font-medium); cursor: pointer; }
.pxp-cyes { background: var(--a2ui-error, #f87171); color: #fff; }
.pxp-cno { background: var(--a2ui-bg-active); color: var(--a2ui-text-secondary); }
.pxp-empty { padding: var(--a2ui-space-4); font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); text-align: center; }
/* Slice 3 — the All·Saved·Drafts filter row (full view). */
.pxp-filter { padding: 0 var(--a2ui-space-6) var(--a2ui-space-3); }
/* Draft chip — drafts show at FULL contrast (row text stays primary); the chip just marks status.
   Neutral, not accent (accent is reserved for actions). */
.pxp-chip-draft { display: inline-flex; align-items: center; height: 17px; padding: 0 7px; margin-left: 8px;
  border-radius: var(--a2ui-radius-full); font-size: 10px; font-weight: var(--a2ui-font-semibold);
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--a2ui-text-secondary);
  background: var(--a2ui-bg-active); border: 1px solid var(--pxc-border-subtle); flex-shrink: 0; }
/* Expiry sits in the row meta, amber — a soft "this is temporary" cue, not an alarm. */
.pxp-expiry { color: var(--a2ui-warning, #fbbf24); }
`;

function relTime(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export interface ProjectsPanelProps {
  /** The active project (thread) id — highlighted in the list. */
  activeId?: string | null;
  onClose: () => void;
  onOpenProject: (id: string, title: string) => void;
  onNewProject: () => void;
  /** Distance from the left edge — clears the floating rail (number px or a CSS length). */
  left: number | string;
}

export function ProjectsPanel({ activeId, onClose, onOpenProject, onNewProject, left }: ProjectsPanelProps) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [full, setFull] = useState(false); // quick (narrow) vs full (wide), same glass panel
  const [view, setView] = useState<'list' | 'grid'>('list'); // full-view layout (mock's list ⇄ grid)
  const [sort, setSort] = useState<ProjectSort>('date');
  const [filter, setFilter] = useState<ProjectFilter>('all'); // All · Saved · Drafts (default All)
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [templateFor, setTemplateFor] = useState<ProjectRow | null>(null); // the Save-as-template dialog

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/threads?user_id=${encodeURIComponent(DEV_USER_ID)}&limit=50`);
      const data = (await res.json()) as { threads?: ProjectRow[] };
      setProjects(Array.isArray(data.threads) ? data.threads : []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const open = (id: string) => {
    // Optimistic "shoots to top" — move the clicked project to the front locally; the server bump
    // (on the next interaction) persists it. Then load the project.
    let title = '';
    setProjects((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit) title = hit.title;
      return hit ? [hit, ...prev.filter((p) => p.id !== id)] : prev;
    });
    // Hand the TITLE up too, so the shell can show which project you're now in.
    onOpenProject(id, title);
  };

  const startEdit = (p: ProjectRow) => {
    setConfirmId(null);
    setEditingId(p.id);
    setEditValue(p.title);
  };
  const saveEdit = async () => {
    const id = editingId;
    const title = editValue.trim();
    setEditingId(null);
    if (!id || !title) return;
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, title } : p)));
    await fetch(`/api/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).catch(() => {});
  };
  // Delete → 10-second Undo toast (soft delete = status flip; Undo flips it back). Confirm FIRST only
  // when a SAVED project holds assets (deleting real work); a draft / empty project deletes straight to
  // the undo toast. Nothing is ever hard-deleted here.
  const requestDelete = (p: ProjectRow) => {
    const isSaved = (p.retention ?? 'saved') === 'saved';
    if (isSaved && (p.asset_count ?? 0) > 0) {
      setConfirmId(p.id); // needs the inline "delete project + its assets?" confirm
      return;
    }
    void performDelete(p);
  };
  const performDelete = async (p: ProjectRow) => {
    setConfirmId(null);
    setProjects((prev) => prev.filter((x) => x.id !== p.id));
    // Deleting the project you're IN → clear the workspace in-state (turns/frame/threadId + the restore
    // key) so it doesn't linger across sections or resurrect on refresh.
    if (activeId === p.id) useChatTurnsStore.getState().reset();
    await fetch(`/api/threads/${p.id}?user_id=${encodeURIComponent(DEV_USER_ID)}`, { method: 'DELETE' }).catch(() => {});
    toastManager.show(`Deleted “${p.title}”`, 'info', 8000, { label: 'Undo', onClick: () => void undoDelete(p) });
  };
  const undoDelete = async (p: ProjectRow) => {
    await fetch(`/api/threads/${p.id}?user_id=${encodeURIComponent(DEV_USER_ID)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    }).catch(() => {});
    load(); // re-pull so it returns to its sorted spot with its assets restored
  };

  // Duplicate (Save As) — a full independent copy; the clone appears in the list on reload.
  const duplicate = async (p: ProjectRow) => {
    const res = await fetch(`/api/threads/${p.id}/duplicate?user_id=${encodeURIComponent(DEV_USER_ID)}`, { method: 'POST' }).catch(() => null);
    if (res?.ok) { toastManager.success(`Duplicated “${p.title}”`); load(); }
    else toastManager.error('Could not duplicate the project');
  };
  const filtered = projects.filter((p) => {
    const ret = p.retention ?? 'saved';
    if (filter === 'saved') return ret === 'saved';
    if (filter === 'drafts') return ret === 'ephemeral';
    return true;
  });
  const sorted = [...filtered].sort((a, b) =>
    sort === 'name' ? a.title.localeCompare(b.title) : b.updated_at - a.updated_at
  );

  return (
    <>
    <div className="pxp" data-full={full ? 'true' : 'false'} style={{ left }}>
      <style>{CSS}</style>
      <div className="pxp-head">
        {full ? (
          <div>
            <h1 className="pxp-h1">Projects</h1>
            <p className="pxp-sub">Every workspace you&rsquo;ve started. Open one to pick up where you left off.</p>
          </div>
        ) : (
          <span className="pxp-title">Projects</span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {full && (
            <>
              <SegmentedControl
                label="Project view"
                value={view}
                onChange={setView}
                options={[
                  { value: 'list', label: 'List view', icon: <Icon name="list" size={16} /> },
                  { value: 'grid', label: 'Grid view', icon: <Icon name="grid" size={16} /> },
                ]}
              />
              <SortMenu label="Sort projects" value={sort} onChange={setSort} options={PROJECT_SORT_OPTIONS} />
            </>
          )}
          <button type="button" className="pxp-full" onClick={() => setFull((f) => !f)}>{full ? 'Compact' : 'Open full view'}</button>
          <button type="button" className="pxp-x" onClick={onClose} aria-label="Close projects">
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>
      {full && (
        <div className="pxp-filter">
          <SegmentedControl
            label="Filter projects"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', icon: <span>All</span> },
              { value: 'saved', label: 'Saved', icon: <span>Saved</span> },
              { value: 'drafts', label: 'Drafts', icon: <span>Drafts</span> },
            ]}
          />
        </div>
      )}
      <button type="button" className="pxp-new" onClick={onNewProject}>
        <Icon name="plus" size={15} /> New project
      </button>
      {loading ? (
        <div className="pxp-list"><div className="pxp-empty">Loading…</div></div>
      ) : sorted.length === 0 ? (
        <div className="pxp-list"><div className="pxp-empty">No projects yet. Start creating and they land here.</div></div>
      ) : full && view === 'grid' ? (
        <div className="pxp-grid">
          {sorted.map((p, i) => (
            <button key={p.id} type="button" className="pxp-card" data-on={activeId === p.id ? 'true' : 'false'} onClick={() => open(p.id)}>
              <div className="pxp-cover" data-wash={i % 2 === 0 ? 'a' : 'b'}>
                <Icon name="folder" size={28} />
              </div>
              <div className="pxp-card-meta">
                <div className="pxp-card-name">{p.title}{isDraftRow(p) && <span className="pxp-chip-draft">Draft</span>}</div>
                <div className="pxp-card-sub">{relTime(p.updated_at)}<MetaTail p={p} /></div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="pxp-list">
          {sorted.map((p) => (
            <div key={p.id} className="pxp-item" data-on={activeId === p.id ? 'true' : 'false'}>
              {editingId === p.id ? (
                <input
                  className="pxp-edit"
                  value={editValue}
                  autoFocus
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveEdit();
                    else if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={() => void saveEdit()}
                />
              ) : confirmId === p.id ? (
                <div className="pxp-confirm">
                  <span className="pxp-confirm-txt">Delete project + its assets?</span>
                  <button type="button" className="pxp-cbtn pxp-cno" onClick={() => setConfirmId(null)}>Keep</button>
                  <button type="button" className="pxp-cbtn pxp-cyes" onClick={() => void performDelete(p)}>Delete</button>
                </div>
              ) : (
                <>
                  <button type="button" className="pxp-item-main" onClick={() => open(p.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--a2ui-space-2)' }}>
                    <span className="pxp-item-icon"><Icon name="folder" size={16} /></span>
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                        <span className="pxp-item-title">{p.title}</span>
                        {isDraftRow(p) && <span className="pxp-chip-draft">Draft</span>}
                      </span>
                      <span className="pxp-item-time">{relTime(p.updated_at)}<MetaTail p={p} /></span>
                    </span>
                  </button>
                  <div className="pxp-acts">
                    <button type="button" className="pxp-mini" title="Duplicate" onClick={() => void duplicate(p)}>
                      <Icon name="copy" size={13} />
                    </button>
                    <button type="button" className="pxp-mini" title="Save as template" onClick={() => setTemplateFor(p)}>
                      <Icon name="save" size={13} />
                    </button>
                    <button type="button" className="pxp-mini" title="Rename" onClick={() => startEdit(p)}>
                      <Icon name="pencil" size={13} />
                    </button>
                    <button type="button" className="pxp-mini pxp-mini--danger" title="Delete" onClick={() => requestDelete(p)}>
                      <Icon name="trash-2" size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    {templateFor && (
      <SaveTemplateDialog
        threadId={templateFor.id}
        onClose={() => setTemplateFor(null)}
        onSaved={() => load()}
      />
    )}
    </>
  );
}

export default ProjectsPanel;
