# PR-11b — Chat command center: FanStatus panel + persistent thought reel

> Part of [Fan-out Visibility](./FANOUT-VISIBILITY.md). Consumes the 11a spine. The chat pane is the
> high-level "IDE thought" surface — global process, health checks, statuses, readable at a glance.

## Why

The POC proved two chat surfaces we don't have:

- A **ROUTING / fan status card**: one row per model (glyph · label · progress bar · 3/3), amber on
  failure with the honest reason, footer "12/12 delivered". Today a fan renders with no per-model
  status anywhere in chat.
- A **thought record that survives the turn**: today the step reel vanishes on `done`
  (`MessageTurn.tsx` hides it once the result lands). The POC keeps a collapsed "Reasoning (N)"
  with per-step detail, elapsed time ("Thinking… 6s"), and model attribution
  ("Generating response — <model>") — expandable after the fact.

## Steps

1. **FanStatus card** (`components/chat/FanStatus.tsx`): renders the turn's fan map. Header
   "N models · M images planned" + the routing one-liner. Per-model row: label, `delivered/n`
   progress bar, state glyph (spinner → ✓ / ⚠), the pick's "why" as a hover/subline, failed rows
   amber with the `GenErrorReason` label mapped to plain words (no key · moderated · timed out ·
   rate limited). Footer: "9/9 delivered" or "6/9 — 1 model failed". Claude Design tokens only;
   glass card per the quality bar.
2. **Mount + persist**: shown in the turn while generating AND after done (it IS the record of the
   run); reloaded threads repaint it from the persisted fan summary. Sits alongside the step reel,
   above the text.
3. **Thought reel keeps its record**: after `done`, collapse the reel to a single "Reasoning (N) ·
   Xs" row that expands to the full step history (steps + details + reasoning prose already exist on
   `ThinkingStep`). Add per-step elapsed time (stamp on start/done in the store) and a model
   attribution line for the specialist leg.
4. **Loading setting governs density** (already exists — extend, don't add): `detailed` = full
   FanStatus card + reel record; `simple` = compact one-line summary ("3 models · 9 images · ✓")
   with the card behind an expand. Never hide failures in either mode.

## Out of scope

Stage changes (11c). New settings axes — `LoadingMode` already exists. Cost breakdown per model
(future; spend metering already accumulates globally).

## Verify

- 3×3 render: rows fill live, bars advance per tile, footer counts up; kill a key → amber row with
  reason, run still completes. Collapse/expand the reasoning record after done; elapsed times shown.
- Reload the thread → card + reasoning record repaint. `simple` mode compacts, still shows failures.
- `tsc --noEmit` clean.
