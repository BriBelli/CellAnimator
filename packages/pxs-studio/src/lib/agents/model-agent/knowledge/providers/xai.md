---
provider: xai
label: "xAI (Grok / Grok Imagine)"
modalities: [image, text]
status: active
envKey: XAI_API_KEY
registryTag: xai
docsUrl: https://docs.x.ai/docs/models
modelsEndpoint: https://api.x.ai/v1/models
---

# xAI (Grok / Grok Imagine)

TV-MA strengths. Gate the same as Replicate TV-MA routes.

## What the agent knows
- **Modalities:** image, text
- **Roster status:** active
- **Docs (refresh source):** https://docs.x.ai/docs/models

## Models
### Image
- **Grok Imagine Image 2.0 (xAI)** (`grok-imagine-image-2.0`) — xAI Grok Imagine Image 2.0 (shipped 2026-08-07) — typography-aware: plans layout/text before painting, so infographics, posters, and title screens hold structure. xAI reports #2 on Arena for BOTH text-to-image and editing. Editing/compositing takes up to 3 source images. Still strong expressive characters (Brian rated the Grok line a hit for characters). Verified 2026-08-24 (x.ai news + API docs). _[tier 3 · refs 3, 5 aspect ratios]_

_Live connection health is tracked separately in `state/health.json` (not here — this file is durable
knowledge, not runtime state)._
