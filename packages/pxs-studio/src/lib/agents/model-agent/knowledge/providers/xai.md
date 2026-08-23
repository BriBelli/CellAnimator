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
- **Grok Image (xAI)** (`grok-2-image`) — xAI Grok image generation — strong photoreal + expressive character work (Brian rated it a hit for characters where Nano/others faltered). Accepts reference images via images/edits (compose / character-match). _[tier 2 · refs 8, 5 aspect ratios]_

_Live connection health is tracked separately in `state/health.json` (not here — this file is durable
knowledge, not runtime state)._
