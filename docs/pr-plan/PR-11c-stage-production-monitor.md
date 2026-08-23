# PR-11c — Stage production monitor: status chips, shimmer tiles, Stream ↔ Grouped

> Part of [Fan-out Visibility](./FANOUT-VISIBILITY.md). Consumes the 11a spine. The stage is the
> digital-media surface — professional monitoring, not decoration.

## Why

The stage already paints all planned model columns with loaders (`gen_plan`), but a column can't say
*how* it's doing: no terminal state (a failed model's loaders just vanish when `gen_done` clears the
plan), pending tiles are a bare spinner + label, and results can only be viewed grouped by model.
The POC proved the Stream-order ↔ Grouped-by-model split toggle is how you watch a fan live AND
compare models after.

## Steps

1. **Per-column status chip** (`components/chat/ImageStage.tsx`): in each group head, a state chip
   fed by the fan map — spinner while running, ✓ on done (with `delivered/n` if short), ⚠ on failed.
   A failed column KEEPS its slot: pending loaders are replaced by one calm failure tile with the
   plain-words reason — never a silent disappearance.
2. **Shimmer pending tiles**: thumbnail-shaped placeholder (same fixed tile size) with a shimmer
   sweep + model label + honest phase text from lifecycle events ("sent" → "waiting on <provider>" →
   tiles arriving "2 of 3"). No fake progress bars per image — phases only, as far as adapters
   honestly know. Reduced-motion → static.
3. **Stream ↔ Grouped toggle**: split icon-button in the Results header (POC pattern). Grouped =
   today's ranked model columns (default — decision closure). Stream = arrival-order flex-wrap of
   uniform tiles, each with its model badge, loaders mixed in while generating. Preference persists
   (ui slice / localStorage). Viewer keeps walking the global index in both views.
4. **Score/why surfacing**: group head's `#rank` chip gains the pick's "why" as a tooltip/subline so
   the ranking teaches trust (data already flows from 11a's `routed`).

## Out of scope

Chat panel (11b). Bento/empty-state changes. Video stage beyond shared components. Re-run/retry
actions on failed columns (backlog — the slot + reason make room for it).

## Verify

- 3×3 with one dead key: three columns w/ chips, shimmer tiles show phases, failed column shows ⚠ +
  reason and keeps its slot after the run; other columns tick to ✓.
- Toggle Stream ↔ Grouped mid-run and after — no layout jump, preference survives reload, viewer
  navigation intact. `tsc --noEmit` clean.
