# PR-11a — Fan event spine: per-model lifecycle on the wire

> Part of [Fan-out Visibility](./FANOUT-VISIBILITY.md). The foundation both UX PRs consume.
> Includes the `model_error` bug fix — worth merging even if the UX slips.

## Why

The coordinator already knows everything (`model_start`, per-model tiles, `model_error`, `notice`)
but the image agent drops `model_start` and flattens `model_error` into a turn-level `gen_error`,
which the store treats as fatal: `generating: false` + turn error while surviving models are still
streaming. The client can only *infer* pending = planned − arrived, so "still cooking" and "silently
dead" look identical.

## Steps

1. **Coordinator** (`lib/engine/coordinator.ts`): add `model_done { modelId, delivered, ms }` when a
   model's adapter stream settles; include `modelId` + per-model index on `tile` events. Carry each
   pick's `why` (selection already computes it) into the `routed` event's model entries.
2. **Image agent** (`lib/agents/image-agent.ts`): forward the lifecycle instead of flattening —
   `fan_model { modelId, label, state: 'running'|'done'|'failed', n, delivered?, reason?, ms? }`
   events over SSE (both the chat-turn and image-agent routes). `gen_plan` entries gain
   `modelId` + `why`. Turn-level `gen_error` is reserved for TOTAL failure: routing failed or zero
   images produced.
3. **Store** (`store/chat-turns-store.ts`): grow `genPlan` into a fan map on the turn —
   `fan: { [modelId]: { label, n, delivered, state, reason?, why?, ms? } }` reduced from
   `gen_plan` + `fan_model` + `image` events. A `fan_model failed` NEVER clears `generating` or sets
   the turn error. Keep the arrived-only fallback for reloaded finished turns (no plan → group by
   what persisted), preserving the 360° reload behavior.
4. **Persistence**: store the final fan map in the interaction record (wherever images/notices
   persist today) so a reloaded thread can repaint the panel — summary only, not the event stream.

## Out of scope

New UI (11b/11c). Retry actions. Adapter changes beyond timing capture.

## Verify

- Remove one provider key, render 3×3: surviving models stream to completion, `generating` stays
  true until the last model settles, the failed model carries `state: 'failed', reason: 'no_key'`,
  the turn ends `done` with a notice — not an error.
- Reload the thread: fan summary reconstructed. `tsc --noEmit` clean.
