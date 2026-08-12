'use client';

/* ─────────────────────────────────────────────────────────────────────────────
 * ChatView — the chat-orchestrator front door (PR-4a: design-true shell).
 *
 * The splash prompt lands HERE (the Operator conversation), rendered ABOVE the
 * persistent <DigitalWall> (z-0) so the same LED-wall backdrop continues behind the
 * chat. Each turn is composed on the PR-2 primitives via <MessageTurn>: the user
 * bubble, the assistant identity badge ("Opus 4.8"), the pre-text plan rows, the
 * streamed text + a blinking block cursor, the stub A2UI options (Button/Card), and
 * follow-up suggestion chips. A <Composer> at the bottom sends follow-up turns.
 *
 * Rebuilt to the Claude Design standard (PR-4a): the bespoke CHAT_CSS promptbar /
 * option / chip / user-bubble rules are gone — everything routes through the
 * tokens-only primitives. The chat column is HARD-CAPPED at --a2ui-chat-max-width
 * (rule #8, never full-bleed); the wall stays full-bleed behind at z-0.
 *
 * PR-4a wires the bones only: option choices that pick a medium enter the full
 * Studio; other choices / suggestions continue the chat. DB persistence + edit /
 * delete / regenerate land in PR-4b.
 * ───────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatTurnsStore, a2uiSurface, type A2UIReferencesBlock, type A2UIBuilderBlock } from '../store/chat-turns-store';
import { useSettings } from '../store/settings-store';
import { Composer, Icon, SegmentedControl, type ComposerAttachment } from './ui';
import { MessageTurn } from './chat/MessageTurn';
import { ImageStage, type StageImage } from './chat/ImageStage';
import { VideoWorkspace } from './chat/VideoWorkspace';
import { RenderConfig } from './chat/RenderConfig';
import { toastManager } from './Toast';
import { PromptGuidePanel } from './chat/PromptGuidePanel';
import { BuilderPanel } from './chat/BuilderPanel';
import { PromptString } from './chat/PromptString';
import { GreetingHero } from './GreetingHero';
import { scoreBuilder } from '../lib/prompt-score';
import { isModelAgentBlockingNow } from '../store/model-agent-store';

/** The fresh-section greeting. Every section STARTS as the conversation, so an empty section must
 *  read as an invitation to talk — never a blank canvas. Same lockup as the splash (identical
 *  treatment), only the copy is section-aware: you've already told us the medium by being here. */
const EMPTY_GREETING: Record<'chat' | 'image' | 'video', { title: string; subtitle: string }> = {
  chat: { title: 'What are we making today?', subtitle: "Let's take your idea to the next level." },
  image: {
    title: 'What image are we making?',
    subtitle: 'Describe it, or bring a reference.',
  },
  video: {
    title: 'What video are we making?',
    subtitle: 'Describe the shot, or bring a reference.',
  },
};

interface Props {
  /** The prompt typed on the splash (front door). Auto-sent once on mount. */
  initialPrompt?: string;
}

/** The chat column cap (rule #8 — capped, never full-bleed). */
const COLUMN_STYLE = { maxWidth: 'var(--a2ui-chat-max-width)' } as const;

/* CONTENT-ONLY (PR-8): the persistent NavRail + DigitalWall + SettingsPanel live in the shell
   (app/page.tsx). This renders only the conversation / workspace over that shell; the shell's
   dormant wall shows behind (no local backdrop). */
export default function ChatView({ initialPrompt }: Props) {
  const turns = useChatTurnsStore((s) => s.turns);
  const activeMedium = useChatTurnsStore((s) => s.activeMedium);
  const activeFrame = useChatTurnsStore((s) => s.activeFrame);
  const threadId = useChatTurnsStore((s) => s.threadId);
  const setActiveMedium = useChatTurnsStore((s) => s.setActiveMedium);
  const viewMode = useChatTurnsStore((s) => s.viewMode);
  const setViewMode = useChatTurnsStore((s) => s.setViewMode);
  const send = useChatTurnsStore((s) => s.send);
  const loadThread = useChatTurnsStore((s) => s.loadThread);
  const deleteTurn = useChatTurnsStore((s) => s.deleteTurn);
  const reset = useChatTurnsStore((s) => s.reset);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);
  // THE TRANSITION (splash→workspace): the workspace fades/rises in as one piece (exploration hold),
  // then the Prompt Guide + center prompt SNAP in the instant the real builder data lands (the payoff).
  // Each entrance is gated to its FIRST appearance via these refs so a later collapse/re-open never
  // re-animates (that would be the jitter Brian rejects). No timers — the motion covers REAL work.
  const guideEnteredRef = useRef(false);
  const promptEnteredRef = useRef(false);

  // The workspace splits into TWO right panels: the Build/Guide panel (the living artifact — the
  // Model agent) and the Agent panel (the conversation with the specialist). The Agent is
  // COLLAPSIBLE; the Build panel is drag-resizable. The center canvas stays free for creations.
  const [rightWidth, setRightWidth] = useState(460); // Build/Guide panel width (resizable)
  const [agentWidth, setAgentWidth] = useState(360); // Agent panel width (resizable)
  // The "big three" surfaces are all collapsible: the Build/Guide (Prompt guide) panel, the Agent
  // panel, and the center prompt — toggle any off in a viewport where you don't want it.
  const [buildOpen, setBuildOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [promptOpen, setPromptOpen] = useState(true);
  // ONE generic column resizer — the handle sits on a panel's LEFT edge, so dragging LEFT widens it.
  // Both the Build/Guide and the Agent panel use it (identical feel), each with its own bounds.
  const resizeStart = useRef<{ x: number; w: number; set: (w: number) => void; min: number; max: number } | null>(null);
  const onResizeMove = useCallback((e: MouseEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    s.set(Math.max(s.min, Math.min(s.max, s.w - (e.clientX - s.x))));
  }, []);
  const onResizeUp = useCallback(() => {
    resizeStart.current = null;
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [onResizeMove]);
  const startResize = useCallback(
    (e: React.MouseEvent, w: number, set: (w: number) => void, min: number, max: number) => {
      resizeStart.current = { x: e.clientX, w, set, min, max };
      window.addEventListener('mousemove', onResizeMove);
      window.addEventListener('mouseup', onResizeUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    },
    [onResizeMove, onResizeUp]
  );

  // showActions gates the MessageActions footer per turn. (Theme is applied to <html> by the shell.)
  const showActions = useSettings((st) => st.showActions);

  // On mount, run exactly once (sent-once ref):
  //  • a splash prompt present → send it (a NEW conversation).
  //  • otherwise, if a thread id was persisted last session → RESTORE it from the SQLite store,
  //    so a plain reload / reopening chat brings the last conversation back.
  useEffect(() => {
    if (sentInitial.current) return;
    const p = initialPrompt?.trim();
    if (p) {
      // Fresh conversation from the splash → reset first so this starts a NEW thread
      // (never appends onto a thread left over from an earlier chat this session).
      sentInitial.current = true;
      reset();
      send(p);
      return;
    }
    if (typeof window === 'undefined') return;
    const storedId = window.localStorage.getItem('pxs-chat-thread');
    if (storedId) {
      sentInitial.current = true;
      void loadThread(storedId);
    }
  }, [initialPrompt, send, loadThread, reset]);

  // Keep the conversation scrolled to the latest as it streams in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const submit = useCallback(
    (text: string, attachments?: ComposerAttachment[]) => {
      const t = text.trim();
      // Keep the URL + its saved-asset id aligned (@-mentioned refs carry an assetId → real lineage).
      const valid = (attachments ?? []).filter((a) => a.dataUrl);
      const refs = valid.map((a) => a.dataUrl);
      const refIds = valid.map((a) => a.assetId ?? null);
      if (!t && refs.length === 0) return;
      // GRACEFUL GATE — a creative section holds EXECUTION only when we KNOW the agent is still warming
      // (Chat never gates; unknown/ready → proceed, since the server warmed on boot). Draft is kept;
      // the warm-up settles in ~a second, then the user just sends again. Never a hard error.
      if (useChatTurnsStore.getState().activeMedium !== 'chat' && isModelAgentBlockingNow()) {
        toastManager.info('The model agent is warming up — one moment…');
        return;
      }
      // Attach the CURRENT builder state (read live from the store) → an Agent-panel message becomes a
      // COLLABORATION: the agent can edit the parts / answer, not just render. No builder (chat home)
      // → plain send to the Operator. The Build panel's Render button bypasses this (it always renders).
      const s = useChatTurnsStore.getState();
      let builderState: { parts: { id: string; label: string; value: string }[] } | undefined;
      for (let i = s.turns.length - 1; i >= 0; i--) {
        const b = s.turns[i].a2ui;
        if (b && b.kind === 'builder') {
          builderState = { parts: (b as A2UIBuilderBlock).parts.map((p) => ({ id: p.id, label: p.label, value: s.partValues[p.id] ?? '' })) };
          break;
        }
      }
      send(t, refs, builderState, refIds);
      setDraft('');
    },
    [send]
  );

  // The section's LENS is the shared [Chat | IDE] pill (viewMode) — written by BOTH the user (the pill)
  // and the agent (the transfer effect below flips it to 'ide' when work lands). IDE only applies to a
  // creative section; chat home is always the conversation. Default 'chat' → an empty section reads as
  // an invitation to talk (the approved flow), and the agent surfaces the IDE the moment it has work.
  const showIde = activeMedium !== 'chat' && viewMode === 'ide';
  const workspaceMedium: 'image' | 'video' = activeMedium === 'video' ? 'video' : 'image';

  // Every generated image across the conversation, newest first — the workspace stage's content.
  const stageImages: StageImage[] = [...turns]
    .reverse()
    .flatMap((t) => t.images.map((img) => ({ ...img, turnId: t.id })));
  const generating = turns.some((t) => t.generating);

  const openWorkflow = useCallback(
    (medium: 'image' | 'video') => setActiveMedium(medium),
    [setActiveMedium]
  );

  // SLOTS-NOT-SCREENS: the latest 'controls'-surface block (the model/reference guide) is lifted
  // out of the message scroll into the workspace's Prompt Guide panel. Scan newest-first so the
  // panel always reflects the CURRENT pass. Only references blocks route to controls today.
  const controlsBlock = [...turns]
    .reverse()
    .map((t) => t.a2ui)
    .find((b): b is A2UIReferencesBlock => b != null && a2uiSurface(b) === 'controls') ?? null;

  // The center Prompt Builder (canvas surface) — the latest structured consult + its source turn (so
  // a new consult remounts the panel with fresh shaping state). PR-10a.
  const builder = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const b = turns[i].a2ui;
      if (b && b.kind === 'builder' && a2uiSurface(b) === 'canvas') {
        return { block: b as A2UIBuilderBlock, turnId: turns[i].id };
      }
    }
    return null;
  })();
  // Rehydrate the Build panel's attached references (Slice 2) from the most recent turn that carried
  // any — on reload these come from the persisted in-state upload assets (loadThread → userImages).
  const latestRefs = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const u = turns[i].userImages;
      if (Array.isArray(u) && u.length > 0) return u;
    }
    return undefined;
  })();

  // SHARED part-values live in the STORE now (lifted for the two-way binding AND the coupling — the
  // Agent writes to the same source via `part_edit`). Seed from iteration-zero when a NEW builder
  // arrives (the store guards against re-seeding); the honest score is computed here and shared.
  const partValues = useChatTurnsStore((s) => s.partValues);
  const setPartValue = useChatTurnsStore((s) => s.setPartValue);
  const seedBuilder = useChatTurnsStore((s) => s.seedBuilder);
  const lastEdit = useChatTurnsStore((s) => s.lastEdit);
  useEffect(() => {
    if (builder) seedBuilder(builder.turnId, Object.fromEntries(builder.block.parts.map((p) => [p.id, p.value ?? ''])));
  }, [builder, seedBuilder]);
  const builderScore = useMemo(
    () =>
      builder
        ? scoreBuilder(builder.block.parts.map((p) => ({ id: p.id, weight: p.weight ?? 1, value: partValues[p.id] ?? '', anchors: [] })))
        : null,
    [builder, partValues]
  );

  // AGENT TRANSFER — when the agent produces work (a NEW builder turn, or an epistemic frame on
  // reopen), flip the shared lens to IDE: "you gave me a car → here's the workspace". Fires ONCE per
  // new work item (keyed by turnId/frame), so if the user flips back to Chat it is NOT yanked away —
  // it only re-fires when genuinely-new work arrives. The agent WRITES viewMode here; it never reads
  // it as permission (the anti-cage contract). A fresh section with no work stays 'chat' (the default).
  const lastWorkKey = useRef<string | null>(null);
  useEffect(() => {
    const key = builder?.turnId ?? (activeFrame ? `frame:${activeFrame.subject ?? activeFrame.goal}` : null);
    if (key && key !== lastWorkKey.current) {
      lastWorkKey.current = key;
      setViewMode('ide');
    }
  }, [builder, activeFrame, setViewMode]);
  // Save a generated tile → the Assets catalog (promote in-state → first-class), with metadata
  // prefilled from the live workflow (title = subject, the assembled prompt, model, thread).
  const onSaveAsset = useCallback(
    async (img: StageImage): Promise<boolean> => {
      const prompt = builder
        ? builder.block.parts.map((p) => (partValues[p.id] ?? '').trim()).filter(Boolean).join(', ')
        : undefined;
      try {
        const res = await fetch('/api/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: img.url,
            model_label: img.modelLabel,
            kind: 'image',
            source: 'generated',
            title: activeFrame?.subject || activeFrame?.goal,
            prompt: prompt || undefined,
            thread_id: threadId ?? undefined,
          }),
        });
        if (!res.ok) throw new Error('save failed');
        toastManager.success('Saved to Assets');
        return true;
      } catch {
        toastManager.error('Could not save to Assets');
        return false;
      }
    },
    [builder, partValues, activeFrame, threadId]
  );

  // Click a clause in the center prompt → focus that part's field in the Build panel (two-way binding).
  const focusPart = useCallback((id: string) => {
    const el = document.getElementById(`pxc-field-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (el as HTMLTextAreaElement).focus();
    }
  }, []);

  // The conversation (scrollable turns + composer) — shared by the chat column and the workspace's
  // right pane. `capped` centers it under the chat-width cap (chat home); the pane fills its column.
  const conversation = (capped: boolean) => (
    <div className="relative z-10 flex-1 flex flex-col min-h-0">
      {/* EMPTY state → centre the greeting by centring the scroll container itself (two lines, no
          min-height guesswork). Scoped to empty ONLY: with content, `align-items: center` would also
          centre a real conversation and can clip the top of tall content out of scroll reach. */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={turns.length === 0 ? { display: 'flex', alignItems: 'center' } : undefined}
      >
        <div className={capped ? 'mx-auto w-full px-6 py-8' : 'w-full px-5 py-6'} style={capped ? COLUMN_STYLE : undefined}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--a2ui-space-6)' }}>
            {turns.length === 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                }}
              >
                <GreetingHero
                  title={EMPTY_GREETING[activeMedium].title}
                  subtitle={EMPTY_GREETING[activeMedium].subtitle}
                  size={capped ? 'splash' : 'compact'}
                />
              </div>
            )}
            {turns.map((t, i) => {
              const isLast = i === turns.length - 1;
              const isDone = t.status === 'done';
              // Delete + regenerate act on the LAST turn only. Delete additionally
              // requires a persisted turn (has an interactionId). Copy is on every done turn.
              const canDelete = isLast && isDone && Boolean(t.interactionId);
              const canRegenerate = isLast && isDone && Boolean(t.userPrompt);
              return (
                <MessageTurn
                  key={t.id}
                  turn={t}
                  showActions={showActions}
                  // In the workspace (uncapped) the controls card is lifted to the Prompt Guide
                  // panel, so suppress it inline. Chat home (capped) has no panel → render inline.
                  renderControlsInline={capped}
                  onSuggestion={submit}
                  onOpenWorkflow={openWorkflow}
                  // Copy the assistant text to the clipboard (silent on failure).
                  onCopy={() => navigator.clipboard.writeText(t.text).catch(() => {})}
                  // Regenerate = re-send this turn's userPrompt → appends a fresh turn.
                  // NOTE: this SPENDS a model call (expected for a regenerate button).
                  onRegenerate={canRegenerate ? () => send(t.userPrompt) : undefined}
                  onDelete={canDelete ? () => deleteTurn(t.interactionId!) : undefined}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Composer — the PR-2 primitive, column-capped in chat, pane-width in the workspace. */}
      <div className={capped ? 'shrink-0 px-6 pb-6 pt-2' : 'shrink-0 px-5 pb-5 pt-2'}>
        <div className={capped ? 'mx-auto w-full' : 'w-full'} style={capped ? COLUMN_STYLE : undefined}>
          {/* Attach is enabled EVERYWHERE, including the front door: the Operator carries whatever the
              user brings (prompt + references) and transfers it to the specialist — it never gatekeeps.
              References persist on the turn (chat-turn route) so they ride along + rehydrate on reload. */}
          <Composer value={draft} onChange={setDraft} onSubmit={submit} attachEnabled />
          {/* The fan-out picker — models · images · aspect. On the composer bar (where you render from),
              so it's always in reach. Image/video sections only (chat home doesn't generate). */}
          {activeMedium !== 'chat' && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <RenderConfig />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="relative flex min-w-0 h-full w-full"
      style={{ color: 'var(--a2ui-text-primary)', fontFamily: 'var(--a2ui-font-family)' }}
    >
      <style>{`
        .pxs-resize { width: 7px; cursor: col-resize; position: relative; background: transparent; }
        .pxs-resize::after { content: ''; position: absolute; inset: 0 3px; border-radius: 2px; background: var(--a2ui-border-default); opacity: 0; transition: opacity var(--a2ui-transition-fast); }
        .pxs-resize:hover::after, .pxs-resize:active::after { opacity: 1; }
        .pxs-agent-head { display: flex; align-items: center; justify-content: space-between; padding: var(--a2ui-space-3) var(--a2ui-space-4); border-bottom: 1px solid var(--a2ui-border-subtle); }
        .pxs-agent-title { display: flex; align-items: center; gap: var(--a2ui-space-2); font-size: var(--a2ui-text-sm); font-weight: var(--a2ui-font-semibold); color: var(--a2ui-text-secondary); }
        .pxs-agent-title svg { color: var(--pxs-accent-text); }
        .pxs-agent-head button { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: none; background: none; color: var(--a2ui-text-tertiary); cursor: pointer; border-radius: var(--a2ui-radius-md); }
        .pxs-agent-head button:hover { background: var(--a2ui-bg-hover); color: var(--a2ui-text-primary); }
        .pxs-agent-tab { width: 42px; display: flex; align-items: flex-start; justify-content: center; padding-top: var(--a2ui-space-4); border: none; border-left: 1px solid var(--a2ui-border-subtle); background: var(--a2ui-bg-app); color: var(--a2ui-text-tertiary); cursor: pointer; transition: color var(--a2ui-transition-fast), background var(--a2ui-transition-fast); }
        .pxs-agent-tab:hover { color: var(--pxs-accent-text); background: var(--a2ui-bg-hover); }
        .pxs-prompt-wrap { position: relative; }
        .pxs-prompt-close { position: absolute; top: -10px; right: -10px; z-index: 2; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: var(--a2ui-radius-full); border: 1px solid var(--pxs-border-subtle); background: var(--a2ui-bg-elevated); color: var(--a2ui-text-tertiary); cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.3); transition: color var(--a2ui-transition-fast), background var(--a2ui-transition-fast); }
        .pxs-prompt-close:hover { color: var(--a2ui-text-primary); background: var(--a2ui-bg-hover); }
        .pxs-prompt-show { height: 30px; padding: 0 14px; border-radius: var(--a2ui-radius-full); border: 1px solid var(--pxs-border-subtle); background: var(--a2ui-glass-dark, rgba(20,22,28,0.82)); backdrop-filter: blur(10px); color: var(--a2ui-text-secondary); font-family: var(--a2ui-font-family); font-size: var(--a2ui-text-sm); cursor: pointer; transition: color var(--a2ui-transition-fast), border-color var(--a2ui-transition-fast); }
        .pxs-prompt-show:hover { color: var(--a2ui-text-primary); border-color: var(--a2ui-border-default); }

        /* The shared [Chat | IDE] lens pill — floats top-centre of a creative section, over both the
           chat column and the IDE. z above the panel headers so it's always reachable. */
        .pxs-viewpill { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 35; }
        .pxs-viewpill-seg { display: inline-flex; align-items: center; gap: 6px; }

        /* ── THE TRANSITION ─────────────────────────────────────────────────────────────
           Exploration hold: the workspace arrives as one calm piece (fade + a short rise),
           reading as the agency taking the wheel — not a hard layout snap. */
        @keyframes pxs-ws-enter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .pxs-ws-enter { animation: pxs-ws-enter 400ms var(--a2ui-ease-entrance) both; }
        /* The SNAP: when the real builder data lands, the Prompt Guide MATERIALIZES on a weighted
           ease-out-expo — a short rise + a hair of scale, precise and solid ("real dimensions of data"
           arriving). Rise/scale (not a lateral slide) so it can't flash a horizontal scrollbar. */
        @keyframes pxs-guide-snap { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .pxs-guide-snap { animation: pxs-guide-snap 480ms cubic-bezier(0.16, 1, 0.3, 1) both; transform-origin: top right; }
        /* The center prompt settles up into place a beat behind the guide. */
        @keyframes pxs-prompt-enter { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .pxs-prompt-enter { animation: pxs-prompt-enter 440ms 60ms var(--a2ui-ease-entrance) both; }
        @media (prefers-reduced-motion: reduce) {
          .pxs-ws-enter, .pxs-guide-snap, .pxs-prompt-enter { animation: none; }
        }
      `}</style>
      {/* The shared lens pill — only in a creative section (chat home is always the conversation). */}
      {activeMedium !== 'chat' && (
        <div className="pxs-viewpill">
          <SegmentedControl
            label="Section view"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'chat', label: 'Chat', icon: <span className="pxs-viewpill-seg"><Icon name="message-square" size={14} /> Chat</span> },
              { value: 'ide', label: 'IDE', icon: <span className="pxs-viewpill-seg"><Icon name="sparkles" size={14} /> IDE</span> },
            ]}
          />
        </div>
      )}
      {showIde ? (
        workspaceMedium === 'video' ? (
          /* VIDEO IDE — the storyboard + scene-builder scaffold (Agent reuses the same conversation). */
          <VideoWorkspace renderConversation={() => conversation(false)} />
        ) : (
        /* ── IMAGE WORKSPACE surface — the transfer lands here: center stage (generated images LARGE) +
              the conversation continuing in a right pane. This is what makes a transfer read as a
              WORKFLOW, not a dead-end in the chat scroll. ── */
        <div className="relative flex-1 flex min-w-0 pxs-ws-enter">
          {/* CENTER canvas — the CREATIONS (gallery) + the floating color-coded PROMPT (a live view
              of the Build panel; click a clause to edit it there). */}
          <div className="relative flex-1 flex min-w-0">
            <ImageStage
              images={stageImages}
              onSaveAsset={onSaveAsset}
              generating={generating}
              medium={workspaceMedium}
              contextLabel={activeFrame?.subject || activeFrame?.goal}
            />
            {builder && builderScore && promptOpen && (
              <div className="absolute inset-x-0 bottom-0 flex justify-center px-6 pb-6" style={{ pointerEvents: 'none' }}>
                <div
                  className={`pxs-prompt-wrap${promptEnteredRef.current ? '' : ' pxs-prompt-enter'}`}
                  style={{ pointerEvents: 'auto', width: '100%', maxWidth: 760 }}
                  onAnimationEnd={() => { promptEnteredRef.current = true; }}
                >
                  <button type="button" className="pxs-prompt-close" onClick={() => setPromptOpen(false)} title="Hide the prompt">
                    <Icon name="x" size={13} />
                  </button>
                  <PromptString parts={builder.block.parts} values={partValues} score={builderScore} onValueChange={setPartValue} onEditPart={focusPart} />
                </div>
              </div>
            )}
            {builder && builderScore && !promptOpen && (
              <div className="absolute inset-x-0 bottom-0 flex justify-center pb-5" style={{ pointerEvents: 'none' }}>
                <button type="button" className="pxs-prompt-show" style={{ pointerEvents: 'auto' }} onClick={() => setPromptOpen(true)}>
                  Show prompt
                </button>
              </div>
            )}
          </div>

          {/* BUILD / GUIDE (Prompt guide) panel — the living ARTIFACT: parts, live score, the document
              you edit. Collapsible (like the Agent) + drag-resizable. */}
          {builder && builderScore && buildOpen && (
            <>
              <div role="separator" aria-orientation="vertical" title="Drag to resize" onMouseDown={(e) => startResize(e, rightWidth, setRightWidth, 340, 760)} className="pxs-resize shrink-0" />
              <aside
                className={`shrink-0 flex flex-col min-h-0${guideEnteredRef.current ? '' : ' pxs-guide-snap'}`}
                onAnimationEnd={() => { guideEnteredRef.current = true; }}
                style={{ width: rightWidth, borderLeft: '1px solid var(--a2ui-border-subtle)', background: 'var(--a2ui-bg-app)' }}
              >
                <div className="pxs-agent-head">
                  <span className="pxs-agent-title">
                    <Icon name="sparkles" size={15} /> Prompt guide
                    {builder.block.title.includes('·') && (
                      <span style={{ color: 'var(--a2ui-text-tertiary)', fontWeight: 'var(--a2ui-font-normal)' }}>
                        {' · '}{builder.block.title.split('·').slice(1).join('·').trim()}
                      </span>
                    )}
                  </span>
                  <button type="button" onClick={() => setBuildOpen(false)} title="Collapse the Prompt guide">
                    <Icon name="x" size={15} />
                  </button>
                </div>
                <BuilderPanel
                  key={builder.turnId}
                  block={builder.block}
                  values={partValues}
                  score={builderScore}
                  onValueChange={setPartValue}
                  highlight={lastEdit}
                  busy={generating}
                  initialRefs={latestRefs}
                  onRender={(prompt, references) => {
                    // Same graceful gate as submit — Render is a creative-section execute path.
                    if (isModelAgentBlockingNow()) {
                      toastManager.info('The model agent is warming up — one moment…');
                      return;
                    }
                    send(prompt, references);
                  }}
                />
              </aside>
            </>
          )}
          {builder && builderScore && !buildOpen && (
            <button type="button" className="pxs-agent-tab shrink-0" onClick={() => setBuildOpen(true)} title="Open the Prompt guide">
              <Icon name="sparkles" size={17} />
            </button>
          )}

          {/* AGENT panel — the CONVERSATION with the specialist (the other output channel of the same
              agent). Collapsible; folds to a slim tab when you just want to build. */}
          {agentOpen ? (
            <>
              <div role="separator" aria-orientation="vertical" title="Drag to resize" onMouseDown={(e) => startResize(e, agentWidth, setAgentWidth, 300, 620)} className="pxs-resize shrink-0" />
            <aside
              className="shrink-0 flex flex-col min-h-0"
              style={{ width: agentWidth, borderLeft: '1px solid var(--a2ui-border-subtle)', background: 'var(--a2ui-bg-app)' }}
            >
              <div className="pxs-agent-head">
                <span className="pxs-agent-title"><Icon name="message-square" size={15} /> Agent</span>
                <button type="button" onClick={() => setAgentOpen(false)} title="Collapse the Agent panel">
                  <Icon name="x" size={15} />
                </button>
              </div>
              {controlsBlock && !builder && <PromptGuidePanel block={controlsBlock} />}
              {conversation(false)}
            </aside>
            </>
          ) : (
            <button type="button" className="pxs-agent-tab shrink-0" onClick={() => setAgentOpen(true)} title="Open the Agent panel">
              <Icon name="message-square" size={17} />
            </button>
          )}
        </div>
        )
      ) : (
        /* Chat column — floats over the shell's dormant DigitalWall (no local backdrop). */
        <div className="relative flex-1 flex flex-col min-w-0">{conversation(true)}</div>
      )}
    </div>
  );
}
