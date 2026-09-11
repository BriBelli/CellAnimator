---
provider: fal
label: "fal"
modalities: [image, video]
status: dropped
envKey: FAL_API_KEY
registryTag: fal
docsUrl: https://fal.ai/models
---

# fal

Dropped unless specifically required (avoid juggling). NOTE: the current image registry still routes Flux via fal — re-activate or migrate those routes to Replicate/BFL before removing.

## What the agent knows
- **Modalities:** image, video
- **Roster status:** dropped
- **Docs (refresh source):** https://fal.ai/models

## Models
### Video
- **Seedance 2.0 (ByteDance)** (`seedance-2`) — ByteDance Seedance 2.0 (Feb 2026) — currently #1 on Artificial Analysis WITH audio. Takes an unusually rich input set: 9 images + 3 clips + 3 audio inputs in one generation, 4-15s, up to 4K. On fal (text-to-video · image-to-video · reference-to-video, each with a Fast tier) and Replicate. Verified 2026-08-29; was seeded as a tier-2 "fast, stylized" model, which badly understated it. _[tier 3 · native-audio · ≤15s, 480p/720p/1080p/4K]_
- **Kling 3.0 (Kuaishou)** (`kling-3`) — Kling 3.0 (Feb 2026) — the STORYBOARD model: a multi-shot mode that renders 1-6 shots from one prompt (15s total) with a shared audio timeline, plus native joint audio and lip-sync across Mandarin, English, Japanese, Korean and Spanish with no separate pass. Directly serves sequence work rather than single clips. Audio adds ~$0.056/s, voice control ~$0.028/s. Verified 2026-08-29 — the earlier seed had nativeAudio FALSE, which was wrong and would have routed every dialogue shot away from it. _[tier 3 · native-audio · ≤15s, 720p/1080p]_
- **Happy Horse 1.1 (Alibaba)** (`happy-horse-1.1`) — Alibaba Happy Horse 1.1 — the 1.x line took #1 on Artificial Analysis WITHOUT audio and roughly tied #1 with it. A unified 15B transformer with joint audio-video, multilingual lip-sync and 1080p, plus a video-EDIT endpoint the rest of the roster lacks. The widest aspect range here (21:9 through 9:21). $0.14/s at 720p, $0.28/s at 1080p. Verified 2026-08-31 — the July seed had neither this model NOR its 1.0 predecessor, and we seeded 1.0 before finding 1.1 was live. _[tier 3 · native-audio · ≤15s, 720p/1080p]_

_Live connection health is tracked separately in `state/health.json` (not here — this file is durable
knowledge, not runtime state)._
