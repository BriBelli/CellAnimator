'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import LandingPage from '../components/LandingPage';
import ChatView from '../components/ChatView';
import NavRail from '../components/NavRail';
import DigitalWall from '../components/DigitalWall';
import SettingsPanel from '../components/SettingsPanel';
import AssetsCatalog from '../components/AssetsCatalog';
import ProjectsPanel from '../components/ProjectsPanel';
import { ToastContainer, useToasts } from '../components/Toast';
import AuthProvider from '../components/AuthProvider';
import LoginModalProvider from '../components/LoginModalProvider';
import { PixcelMark } from '../components/ui';
import { useSettings } from '../store/settings-store';
import { useChatTurnsStore, THREAD_STORAGE_KEY } from '../store/chat-turns-store';
import { useModelAgentStore } from '../store/model-agent-store';
import { RES } from '../lib/resolutions';

/** localStorage key holding the last shell screen (stage + medium) so a reload RESTORES where you
 *  were — not a hard bounce back to the splash. Pairs with THREAD_STORAGE_KEY (the active thread). */
const SHELL_STATE_KEY = 'pxs-shell-state';

// Dynamically import Studio component (client-side only for Web Workers)
const Studio = dynamic(() => import('../components/Studio'), {
  ssr: false,
  loading: () => <LoadingScreen />,
});

// A calm, on-brand boot state: just the Pixcel mark breathing on the app background.
// Replaces the old "PXS Studio / v4.0.0 / Loading WebAssembly…" screen (off-brand clutter).
// Tokens-only, sentence case, no version/architecture copy — the mark IS the identity.
function LoadingScreen() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--a2ui-bg-app)',
      }}
    >
      <style>{`@keyframes pxl-boot { 0%, 100% { opacity: 0.65; transform: scale(0.985); } 50% { opacity: 1; transform: scale(1); } }`}</style>
      <PixcelMark
        size={44}
        style={{
          // White (the same tone as the rail's mark) — the breathing dips it to a soft off-white
          // rather than a dim/dark X. Not the accent blue: the boot mark IS the identity.
          color: 'var(--a2ui-text-primary)',
          animation: 'pxl-boot 1.6s var(--a2ui-ease-entrance, ease-in-out) infinite',
        }}
      />
    </div>
  );
}

type Stage = 'splash' | 'chat' | 'studio';

// ── Front-door STAGGERED hand-off lifecycle ─────────────────────────────────────
// The splash → chat move is a paced sequence, NOT a hard swap and NOT a simultaneous
// cross-dissolve: the outgoing view (its wall too) eases opacity 1→0 + recedes over OUT_MS,
// THEN — after a beat — the incoming view eases in over IN_MS, revealing the chat + its
// thinking loader (that reveal is the beat). The chat mounts + starts processing during the
// out-fade, so it reveals already working — an intelligent-interface feel, not a fake snap.
//
// NOTE (next evolution): the DigitalWall is still a SEPARATE instance per view (splash's
// logo-wall vs chat's dormant wall), so the cross-fade dissolves one into the other. The
// deliberate LATER increment is to hoist the wall into ONE persistent instance that merely
// re-tunes (logoScale/intensity) across the hand-off — not built yet.
// Paced splash↔chat hand-off — a STAGGERED sequence, not a cross-dissolve: the outgoing view
// (with its wall) eases OUT first, THEN — after a beat — the incoming view eases IN, revealing
// the chat + its thinking loader (that reveal IS the "processing" beat; nothing fake/timed).
const OUT_MS = 320; // outgoing fades + recedes out
const IN_MS = 380; // incoming eases in (starts after OUT_MS)
const EASE = 'var(--a2ui-ease-entrance)'; // cubic-bezier(0.22, 1, 0.36, 1)

// Splash logo → prompt-bar anchor (the shell computes it from the persistent wall's logo layout).
const PROMPT_GAP = '4rem';
const PROMPT_Y_MIN = '52%';
const PROMPT_Y_MAX = '82%';
const DEFAULT_PROMPT_Y = '72%';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  // The front door is now CHAT: splash → chat (the Operator) → optionally the Studio (IDE).
  const [stage, setStage] = useState<Stage>('splash');
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>();

  // Staggered hand-off state: `outgoing` = the view fading OUT (top layer); `phase`:
  //   'out'  → outgoing fades/recedes, incoming held hidden
  //   'in'   → outgoing gone, incoming eases in (chat + loader reveal)
  //   null   → steady (no transition)
  const [outgoing, setOutgoing] = useState<Stage | null>(null);
  const [phase, setPhase] = useState<'out' | 'in' | null>(null);
  const outTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafId = useRef<number | null>(null);

  // Clear any pending timers on unmount.
  useEffect(() => () => {
    if (outTimer.current) clearTimeout(outTimer.current);
    if (doneTimer.current) clearTimeout(doneTimer.current);
    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
  }, []);

  // Drive the staggered hand-off to `next`: OUT (outgoing fades) → beat → IN (incoming eases in).
  // Reduced motion → instant, still correct.
  const transitionTo = useCallback((next: Stage, prompt?: string, keepPrompt = true) => {
    setStage((current) => {
      if (next === current) return current;
      if (prompt !== undefined) setInitialPrompt(prompt);
      else if (!keepPrompt) setInitialPrompt(undefined);

      if (prefersReducedMotion()) {
        // No motion: swap instantly, no layers.
        setOutgoing(null);
        setPhase(null);
        return next;
      }

      if (outTimer.current) clearTimeout(outTimer.current);
      if (doneTimer.current) clearTimeout(doneTimer.current);
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);

      // 1) OUT — the current view (its wall too) fades + recedes out; the incoming view is
      //    mounted underneath but held hidden.
      setOutgoing(current);
      setPhase('out');
      // 2) after OUT_MS — drop the outgoing layer, then (next frame) flip to 'in' so the incoming
      //    view eases in from hidden, revealing the chat + its loader. The beat is that reveal.
      outTimer.current = setTimeout(() => {
        setOutgoing(null);
        rafId.current = requestAnimationFrame(() => setPhase('in'));
      }, OUT_MS);
      // 3) after the full sequence — back to a plain steady layout.
      doneTimer.current = setTimeout(() => setPhase(null), OUT_MS + IN_MS);
      return next;
    });
  }, []);

  // ── PR-8 persistent shell state (nav + wall + settings live here, not in the views) ──
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [promptY, setPromptY] = useState(DEFAULT_PROMPT_Y);
  const { toasts: toastList, dismiss: dismissToast } = useToasts();
  const splashStyle = useSettings((s) => s.splashStyle);
  const theme = useSettings((s) => s.theme);
  const activeMedium = useChatTurnsStore((s) => s.activeMedium);
  const viewMode = useChatTurnsStore((s) => s.viewMode);
  const setActiveMedium = useChatTurnsStore((s) => s.setActiveMedium);
  const loadThread = useChatTurnsStore((s) => s.loadThread);
  const resetChat = useChatTurnsStore((s) => s.reset);
  const activeThreadId = useChatTurnsStore((s) => s.threadId);
  const threadTitle = useChatTurnsStore((s) => s.threadTitle);
  const setThreadTitle = useChatTurnsStore((s) => s.setThreadTitle);
  // Selecting the derived STRING (not the turns array) keeps the shell from re-rendering on every
  // streaming token — it only changes when the project's first prompt does.
  const firstPrompt = useChatTurnsStore((s) => s.turns[0]?.userPrompt ?? null);

  // RELOAD = RESTORE where you were (persist the workspace across refresh), not a hard bounce to the
  // splash. Reading synchronously in this mount effect means the FIRST post-mount render already
  // shows the right stage — no splash flash (the pre-mount render is the LoadingScreen, not splash).
  // A genuinely fresh visit (no saved state) still lands on the splash front door.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SHELL_STATE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { stage?: Stage; medium?: 'chat' | 'image' | 'video' };
        if (saved.stage === 'chat') {
          setStage('chat');
          if (saved.medium) setActiveMedium(saved.medium);
          const tid = window.localStorage.getItem(THREAD_STORAGE_KEY);
          if (tid) void loadThread(tid);
        }
      }
    } catch {
      /* non-fatal — fall through to the splash */
    }
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the current screen (stage + medium) so a reload can restore it. The active thread id is
  // persisted separately by the chat store (THREAD_STORAGE_KEY).
  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(SHELL_STATE_KEY, JSON.stringify({ stage, medium: activeMedium }));
    } catch {
      /* non-fatal */
    }
  }, [mounted, stage, activeMedium]);

  // Theme applies to <html> from the shell, so it holds across splash + chat (not just in-app).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Wake the Model agent's warm-up view on load. The SERVER already warmed it on boot (instrumentation);
  // this just reads that state (and polls if it's somehow still warming) so the graceful gate + a future
  // status UX have it. Fire-and-forget; Chat never waits on this.
  useEffect(() => {
    void useModelAgentStore.getState().fetchStatus();
  }, []);

  // The persistent wall's logo layout → the splash prompt-bar anchor (logo hero only).
  const handleLogoLayout = useCallback((box: { bottomFrac: number; visible: boolean }) => {
    if (!box.visible) {
      setPromptY(DEFAULT_PROMPT_Y);
      return;
    }
    const belowLogo = `calc(${(box.bottomFrac * 100).toFixed(2)}% + ${PROMPT_GAP})`;
    setPromptY(`clamp(${PROMPT_Y_MIN}, ${belowLogo}, ${PROMPT_Y_MAX})`);
  }, []);

  if (!mounted) {
    return <LoadingScreen />;
  }

  const transitioning = phase !== null;
  const inStudio = stage === 'studio';

  // Nav handlers — the shell owns the ONE persistent rail (stage-aware).
  const navActive = assetsOpen ? 'assets' : stage === 'chat' ? activeMedium : 'chat';
  const handleNavHome = () => {
    setAssetsOpen(false);
    // From a workspace → back to the conversation; from plain chat/splash → the splash.
    if (stage === 'chat' && activeMedium !== 'chat') setActiveMedium('chat');
    else transitionTo('splash', undefined, false);
  };
  // The active project's display name — the title when we know it, else the project's first prompt
  // (a brand-new project is titled server-side from the goal, so the prompt is the honest stand-in).
  const projectName = (threadTitle ?? '').trim() || (firstPrompt ? firstPrompt.trim().slice(0, 48) : '');

  // ONE explicit way to open a project — from the Projects panel or an asset's Details drawer.
  // Always deliberate, and the shell's project chip immediately reflects WHERE you landed.
  const openProject = (id: string, title?: string) => {
    setProjectsOpen(false);
    setAssetsOpen(false);
    setActiveMedium('chat');
    setThreadTitle(title?.trim() ? title : null);
    if (stage !== 'chat') transitionTo('chat');
    void loadThread(id);
  };

  const handleNavSection = (id: string) => {
    // The primary nav is the PHONE MENU — but a BATON HAND-OFF, not a reset. Clicking a section
    // hands you back to the Operator at that section's ROOT ("what do you want to do?"), section
    // aware, WITH THE CURRENT PROJECT'S STATE INTACT (turns + thread survive). The rule: when you'd
    // EXPECT state you get it; only the in-flight workflow FRAME is dropped, which is what returns
    // you to the operator instead of an IDE mid-flight. (A TRANSFER is the opposite: it carries the
    // exact intent forward, in flight, without breaking the workflow.)
    // Also fixes the splash off-by-one — medium + transition happen in ONE click.
    if (id === 'assets') { if (stage === 'splash') transitionTo('chat'); setProjectsOpen(false); setAssetsOpen(true); return; }
    setAssetsOpen(false);
    const medium = id === 'image' || id === 'video' ? id : 'chat';
    // Switch the CURRENT PROJECT'S VIEW to this section (Chat = conversation, Image/Video = that
    // IDE). Keep the project state — do NOT drop the frame; that's what was forcing everything back
    // to Chat. If there's no project, the section shows its fresh/empty state.
    setActiveMedium(medium);
    if (stage !== 'chat') transitionTo('chat');
  };

  // The persistent wall re-tunes by SCENARIO (never disabled): splash+logo = active flare
  // (wordmark); otherwise dormant (subtle, no logo) — present + ready to come alive on intent later.
  const wallLogo = stage === 'splash' && splashStyle === 'logo';

  // Content-only stage for the cross-fading well (studio is a separate full view below).
  const renderContent = (s: Stage) => {
    if (s === 'splash') return <LandingPage onEnter={(p) => transitionTo('chat', p)} promptY={promptY} />;
    if (s === 'chat') return <ChatView initialPrompt={initialPrompt} />;
    return null;
  };

  // Layer styling for the content well. Steady = fill the well; transitioning = staggered fade.
  const layerStyle = (kind: 'incoming' | 'outgoing'): CSSProperties => {
    // Clear the FLOATING rail: this layer is absolute, so `inset:0` (left:0) would sit at the padding-box
    // border — UNDER the rail — ignoring the well's paddingLeft. Offset `left` by the rail space instead,
    // so the full-bleed canvas never tucks under the rail. (Only spacing; the canvas UI is untouched.)
    const fill: CSSProperties = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 'var(--pxs-rail-space)' };
    if (!transitioning) return fill;
    if (kind === 'outgoing') {
      return {
        ...fill, zIndex: 2, pointerEvents: 'none',
        transition: `opacity ${OUT_MS}ms ${EASE}, transform ${OUT_MS}ms ${EASE}`,
        opacity: 0,
        transform: 'translateY(-6px) scale(0.995)',
      };
    }
    const shown = phase === 'in';
    return {
      ...fill, zIndex: 1, pointerEvents: shown ? 'auto' : 'none',
      transition: `opacity ${IN_MS}ms ${EASE}, transform ${IN_MS}ms ${EASE}`,
      opacity: shown ? 1 : 0,
      transform: shown ? 'translateY(0)' : 'translateY(12px)',
    };
  };

  // The product's front door: splash ⇄ chat live inside ONE persistent shell (nav + wall never
  // fade; only the center well cross-fades). The Studio is a separate full view (its own chrome).
  return (
    <AuthProvider>
      <LoginModalProvider>
        {inStudio ? (
          <Studio onHome={() => transitionTo('chat')} initialPrompt={initialPrompt} />
        ) : (
          <div
            className="pxs-shell relative isolate flex h-screen overflow-hidden"
            style={{ background: 'var(--a2ui-bg-app)', color: 'var(--a2ui-text-primary)', fontFamily: 'var(--a2ui-font-family)' }}
          >
            {/* BEHIND everything — the ONE persistent DigitalWall (opaque canvas), so it must sit at a
                NEGATIVE z inside the shell's isolate context or it paints OVER the static nav (a
                positioned z-0 element paints above static siblings). Scenario-tuned; never re-mounts.

                WALL SETTINGS (Apple-esque, subtle, blends — tune these live):
                  pixels=RES.sd  → higher res so the drift is smooth, not chunky-retro
                  effect=plasma  → soft flowing atmosphere (not the radial-pulse LED rings)
                  gridLines=off  → no LED lattice mesh (was the biggest "gross" culprit)
                  fps=30         → smoother motion
                  intensity low  → whisper-faint so it reads as ambient depth, not a screensaver */}
            <div className="pxs-wall pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
              <DigitalWall
                className="absolute inset-0 h-full w-full"
                pixels={RES.sd}
                effect="plasma"
                gridLines={false}
                fps={30}
                showLogo={wallLogo}
                logoScale={0.25}
                intensity={wallLogo ? 0.16 : 0.02}
                onLogoLayout={wallLogo ? handleLogoLayout : undefined}
              />
            </div>

            {/* The ONE persistent NavRail — the anchor, never fades. It FLOATS: `.pxl-rail` is
                absolutely positioned (z-30) against this shell, so it reserves NO layout column and
                the wall + content run full-bleed beneath it. No wrapper div — the rail positions
                itself (see NavRail's RAIL_CSS). */}
            <NavRail
              activeSection={navActive}
              onHome={handleNavHome}
              onSection={handleNavSection}
              onToggleProjects={() => { setAssetsOpen(false); setProjectsOpen((v) => !v); }}
              projectsOpen={projectsOpen}
              onOpenSettings={() => setSettingsOpen(true)}
            />

            {/* Content well — ONLY this cross-fades between splash ⇄ chat. The Assets catalog is a
                full-view overlay ON this well (right of the persistent nav), its own surface.
                paddingLeft clears the FLOATING glass rail (which is absolute + overlays), so content
                auto-adjusts to the nav location instead of hiding beneath it. */}
            <div
              className="pxs-content relative z-10 flex-1 min-w-0 h-full"
              style={{ paddingLeft: 'var(--pxs-rail-space)' }}
            >
              {/* PERSISTENT PROJECT IDENTITY — quiet, always-there, so you always know which project
                  you're in (and can jump to the list). A project you can't name is one you can't trust. */}
              {stage === 'chat' && !assetsOpen && projectName && !(activeMedium !== 'chat' && viewMode === 'ide') && (
                <button
                  type="button"
                  className="pxs-project-chip"
                  onClick={() => setProjectsOpen((v) => !v)}
                  title="Projects"
                  style={{
                    position: 'absolute',
                    top: 'var(--a2ui-space-4)',
                    // Clear the FLOATING rail — the content well's padding box starts at the border (under
                    // the rail), so an absolute child must offset by the rail space or it tucks under it.
                    left: 'calc(var(--pxs-rail-space) + var(--a2ui-space-2))',
                    zIndex: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 28,
                    maxWidth: 320,
                    padding: '0 12px',
                    borderRadius: 'var(--a2ui-radius-full)',
                    border: '1px solid var(--a2ui-border-subtle)',
                    background: 'var(--a2ui-bg-elevated)',
                    color: 'var(--a2ui-text-tertiary)',
                    fontFamily: 'var(--a2ui-font-family)',
                    fontSize: 'var(--a2ui-text-xs)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--a2ui-accent)', flexShrink: 0 }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{projectName}</span>
                </button>
              )}
              <div key={stage} className="pxs-stage" style={layerStyle('incoming')}>{renderContent(stage)}</div>
              {transitioning && outgoing && outgoing !== 'studio' && (
                <div key={outgoing} className="pxs-stage" style={layerStyle('outgoing')}>{renderContent(outgoing)}</div>
              )}
              {assetsOpen && (
                <AssetsCatalog onClose={() => setAssetsOpen(false)} onOpenProject={(id) => openProject(id)} />
              )}
            </div>

            {/* Projects slide-out (Slice 5) — THE THREAD IS THE PROJECT. Docked right of the nav rail. */}
            {projectsOpen && (
              <ProjectsPanel
                left={'calc(var(--pxs-rail-space) - 6px)'}
                activeId={activeThreadId}
                onClose={() => setProjectsOpen(false)}
                onNewProject={() => {
                  setProjectsOpen(false);
                  setAssetsOpen(false);
                  resetChat();
                  setActiveMedium('chat');
                  if (stage !== 'chat') transitionTo('chat');
                }}
                onOpenProject={(id, title) => openProject(id, title)}
              />
            )}

            <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            <ToastContainer toasts={toastList} onDismiss={dismissToast} />
          </div>
        )}
      </LoginModalProvider>
    </AuthProvider>
  );
}
