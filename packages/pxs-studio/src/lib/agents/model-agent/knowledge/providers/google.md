---
provider: google
label: "Google (Gemini / Veo / Imagen / Lyria)"
modalities: [image, video, audio, text]
status: active
envKey: GEMINI_API_KEY
registryTag: gemini
docsUrl: https://ai.google.dev/gemini-api/docs/models
modelsEndpoint: https://generativelanguage.googleapis.com/v1beta/models
---

# Google (Gemini / Veo / Imagen / Lyria)

The backbone. Full-suite emphasis (Codex primary directive) — Gemini image, Veo video, Omni multimodal, Lyria audio. Must not miss Google capabilities.

## What the agent knows
- **Modalities:** image, video, audio, text
- **Roster status:** active
- **Docs (refresh source):** https://ai.google.dev/gemini-api/docs/models

## Models
### Image
- **Nano Banana Pro (Gemini 3 Pro Image)** (`gemini-3-pro-image`) — Nano Banana Pro (gemini-3-pro-image, GA May 2026) — the family flagship. Distinct reference pools, 14 total: up to 10 object refs (high-fidelity), 5 character refs (consistency), and 3 style refs. $0.134/img at 1K-2K, $0.24 at 4K. First pick when a shot needs precise, typed references held together. Verified 2026-08-24 (ai.google.dev docs + pricing). _[tier 3 · refs 14, 7 aspect ratios]_
- **Nano Banana 2 (Gemini 3.1 Flash Image)** (`gemini-3.1-flash-image`) — Nano Banana 2 (gemini-3.1-flash-image, Feb 2026) — the fast tier with real quality: high multi-reference (coherence across ~14 objects / 5 characters per DeepMind) at $0.045-$0.15 by resolution. Per-role reference split not published where we can verify — the research pass owns sourcing it. Verified 2026-08-24 (pricing + API id). _[tier 2 · refs 14, 5 aspect ratios]_
- **Gemini Omni (Google)** (`gemini-omni`) — Native multimodal — interleaved image + audio in one context (the unified renderer). Confirm live span before routing; today a reasoning-forward Omni exemplar. _[tier 3 · omni: image+audio · needs-research]_

### Video
- **Veo 3.1 (Google)** (`veo-3.1`) — Google Veo 3.1 (Mar 2026) — the realism + native-audio flagship: synced dialogue, ambience and SFX in ONE pass at 48kHz, 1080p with 4K upscaling. SCENE EXTENSION chains up to 20 clips for 140s+ narratives, and frames-to-video interpolates between a start and end image — both of which matter more than clip length for film work. Family: quality / fast / lite. Every output carries a mandatory SynthID watermark. Verified 2026-08-29. _[tier 3 · needs-research · native-audio · ≤8s, 720p/1080p/4K]_

### Audio
- **Lyria 2 (Google)** (`lyria-2`) — Google music generation — high-fidelity instrumental + song scoring. Route film score + music beds. _[tier 3 · needs-research · music, ≤120s]_
- **Gemini Omni (Google)** (`gemini-omni`) — Native multimodal — interleaved image + audio in one context (the unified renderer). Confirm live span before routing; today a reasoning-forward Omni exemplar. _[tier 3 · omni: image+audio · needs-research · speech/sfx, ≤60s]_

_Live connection health is tracked separately in `state/health.json` (not here — this file is durable
knowledge, not runtime state)._
