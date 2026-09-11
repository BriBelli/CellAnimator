---
provider: openai
label: "OpenAI (GPT Image / GPT)"
modalities: [image, text]
status: active
envKey: OPENAI_API_KEY
registryTag: openai
docsUrl: https://platform.openai.com/docs/models
modelsEndpoint: https://api.openai.com/v1/models
---

# OpenAI (GPT Image / GPT)

Second primary. Best-in-class multi-subject composition + complex prompt adherence + native editing.

## What the agent knows
- **Modalities:** image, text
- **Roster status:** active
- **Docs (refresh source):** https://platform.openai.com/docs/models

## Models
### Image
- **GPT Image 1.5 (OpenAI)** (`gpt-image-1.5`) — OpenAI flagship (GPT Image 1.5, Dec 2025 — built into the GPT-5 stack, ~4x faster than gpt-image-1). Best-in-class prompt adherence, in-image text, and editing: images.edit accepts up to 16 input images. Reach for it on hero images, legible text, and multi-turn edits. Native batch up to n=10. Verified 2026-08-24 (OpenAI API reference). _[tier 3 · refs 16, 5 aspect ratios]_

_Live connection health is tracked separately in `state/health.json` (not here — this file is durable
knowledge, not runtime state)._
