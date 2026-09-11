---
provider: replicate
label: "Replicate (Flux / specialty / TV-MA)"
modalities: [image, video, audio]
status: active
envKey: REPLICATE_API_TOKEN
registryTag: replicate
docsUrl: https://replicate.com/docs
modelsEndpoint: https://api.replicate.com/v1/models
---

# Replicate (Flux / specialty / TV-MA)

Access layer for Flux (dev), open-source specialty, and TV-MA / uncensored models. TV-MA routes MUST pass the spend-cap + policy gate before they are reachable.

## What the agent knows
- **Modalities:** image, video, audio
- **Roster status:** active
- **Docs (refresh source):** https://replicate.com/docs

## Models
### Image
- **FLUX.2 [pro] (Replicate)** (`flux-2-pro`) — Black Forest Labs FLUX.2 [pro] via Replicate — photoreal flagship with true MULTI-REFERENCE: composes/edits from up to 8 reference images, index-addressable ("the person from image 1 in the outfit from image 4"), strong character + product consistency. Verified 2026-08-24 from the Replicate model page. Route heavy in-image text to gpt-image-1 / ideogram. _[tier 3 · refs 8, 9 aspect ratios]_
- **FLUX.2 [dev] (Replicate)** (`flux-2-dev`) — Black Forest Labs FLUX.2 [dev] via Replicate — the affordable FLUX.2, same MULTI-REFERENCE stack (up to 8 refs + editing) at a fraction of pro cost. Great for reference-driven fan-outs and exploration. Verified 2026-08-24 from Replicate. _[tier 2 · refs 8, 9 aspect ratios]_

### Audio
- **MusicGen (Replicate)** (`musicgen`) — Open music + SFX generation, fast + cheap. Route quick beds, loops, and sound effects. _[tier 1 · needs-research · music/sfx, ≤30s]_

_Live connection health is tracked separately in `state/health.json` (not here — this file is durable
knowledge, not runtime state)._
