# Fan-out Visibility — full status through every step of a multi-model render

> Parent plan for **PR-11a / 11b / 11c**. Branch `feature/multi-model-fanout`. Companion to
> [MODEL-REGISTRY.md](./MODEL-REGISTRY.md) (selection is done; this is making the *run* visible).

## Why

A 3-model × 3-image render must never read as a blank screen with images popping in. The user needs
**four-inch visibility** into every image: which models were picked (and why), each model's API call
represented visually, per-model progress, and honest per-model failure — without one dead model
nuking the whole run's status (which is a live bug today: `model_error` flattens to a turn-level
`gen_error` at `chat-turns-store.ts` and kills `generating` while other models are still streaming).

The proven reference is the POC's UX: a per-model ROUTING panel with progress bars and "12/12
delivered" in chat, a Stream-order ↔ Grouped-by-model toggle on results, and a thought reel that
survives the turn as an expandable "Reasoning (N)" record with timings and model attribution.

## Goal

Two synchronized surfaces off ONE per-model event spine:

- **Chat = command center** — the high-level thought process: routing picks + why, per-model status
  rows with progress bars, failures in amber with honest reasons, a persistent reasoning record.
- **Stage = production monitor** — per-column live status chips, thumbnail-shaped shimmer
  placeholders, failed columns that keep their slot, Stream ↔ Grouped toggle.

## The PRs

| PR | Scope | File |
| --- | --- | --- |
| 11a | Event spine: per-model lifecycle on the wire + the `model_error` bug fix | [PR-11a-fan-event-spine.md](./PR-11a-fan-event-spine.md) |
| 11b | Chat command center: FanStatus panel + persistent thought/reasoning reel | [PR-11b-chat-command-center.md](./PR-11b-chat-command-center.md) |
| 11c | Stage production monitor: status chips, shimmer tiles, Stream↔Grouped toggle | [PR-11c-stage-production-monitor.md](./PR-11c-stage-production-monitor.md) |

11a is the foundation and merges first; 11b and 11c are independent consumers of it.

## Already in place (don't rebuild)

- `gen_plan` streamed at routing time → the stage already paints one loader column per model.
- The POC's **Loading: Simple | Detailed** setting already exists (`settings-store.ts` `LoadingMode`)
  with the single-row reel + expand in `ThinkingIndicator.tsx`. 11b extends it; it is not new.
- The coordinator already emits `model_start` / `model_error` per model and `notice` for best-effort
  shortfalls; the `GenErrorReason` taxonomy in `executor.ts` gives honest failure labels.

## Out of scope

- Provider-side progress percentages per image (most APIs don't stream them — we show honest phases,
  not fake progress).
- Retry-a-failed-model action (backlog; the spine makes it possible later).
- Video-path parity beyond what falls out of shared components.

## Verify (end state)

3 models × 3 images with one provider's key removed: all three columns appear instantly, two stream
tiles while the third shows a failed state with its reason, chat shows per-model progress bars
reaching "6/9 delivered — 1 model failed (no key)", the turn completes as a success with a notice,
and reloading the thread reconstructs the panel. `tsc --noEmit` clean.
