---
type: skill
title: Sizing heuristics
description: Signals that size a request — transfer (the default) vs propose vs ask. The Operator never generates.
agent: operator
---

# Sizing heuristics

A creative request is a **green light to TRANSFER** — the specialist's Builder is the consult, so you
don't add a scripted step in front of it. Read for signals only to pick the RIGHT route + depth. When
in doubt on a single image, **transfer** (the builder shapes it); only size up to **propose** for a
genuine multi-step pipeline.

## Signals → action

- **A creative subject** ("a red mushroom", "a photoreal Camaro", "a dragon", "an image of a car")
  → **transfer** (`depth: guided`, the default). The Builder opens and shapes the specifics
  (year/trim/color/scene) WITH the user — that IS the consult, no image until they commit. Do NOT
  ask "quick or guided" or interrogate specs first; that's the scripted step to avoid.

- **A simple single-output EDIT** ("make the car red", "remove the background", "swap the sky" — a
  transform on an existing image), OR explicit speed / don't-care ("quickly", "just", "any", "I don't
  care which") → **transfer** with `depth: quick`. One obvious output, nothing to shape → the agent
  renders fast. You still never render — the agent does. (The judgment is OUTPUT VARIANCE: one output →
  quick, many → guided. See [[workflow-diagnosis]].)

- **A whole PIPELINE** — "video", "clip", "scene", "animation", "film", "my childhood", "for my
  story", "consistent across", "series"
  → **propose** the paths (a single still is never a pipeline — that's a transfer). Video wants
  reference/start-end/storyboard images first (see [[cinematic-video-paths]]).

- **Iteration / refinement** — "keep the same", "make it match", "variations of", "edit this",
  "restyle"
  → **transfer** into the workspace where the specialist iterates with references.

- **References mentioned or implied** — "I have photos", "based on this", "attach", "use my"
  → **transfer**; the specialist runs a [[capability-lookup]] and the Builder shows the right,
  model-shaped reference slots.

## The one-line test
> Do I know WHAT the user wants (an image? a video?)?

If yes → **transfer** and let the Builder shape the specifics (that's its job — not yours to ask
upfront). If the deliverable itself is unclear → a single **ask**. If it's a multi-step pipeline →
**propose**. You never render regardless — the choice is only which non-generative route. Your value
is the *diagnosis and the clean handoff*, pushing the winning pattern first — not a scripted
interrogation.

See also [[workflow-diagnosis]].
