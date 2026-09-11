/**
 * THE PROVIDER ROSTER — the deterministic floor of the whole model stack.
 *
 * This is the ONE thing that is hardcoded and STAYS hardcoded: the set of companies whose APIs
 * Pixcel is allowed to call, each with the env key that unlocks it and the live docs the Model
 * agent researches. That's the floor Brian wants deterministic ("just give it the APIs"), and
 * nothing more.
 *
 * EVERYTHING ABOVE THIS LINE IS AUTONOMOUS — which models a provider offers, their versions,
 * capabilities, prices, reference limits, prompt formulas, and the per-model "tricks" (burst,
 * character sheets, motion transfer) are the Model agent's self-refreshing responsibility. They
 * are NEVER hardcoded as truth. Hardcoding the model layer is precisely how photolif died: a
 * static, daily-stale rating file that was wrong the moment it was written and didn't know it.
 *
 * So: give the agent the APIs (this file). It owns the rest (the registry, refreshed against
 * `docsUrl` / `modelsEndpoint` on a TTL — see `staleness.ts`).
 *
 * NO KEYS / NO SPEND live here — this is pure data. `envKey` is a POINTER; only the provider
 * adapter (behind the executor seam) ever reads the actual secret.
 */

/** A media modality a provider can produce. The agent routes by these, then by live capability. */
export type Modality = 'image' | 'video' | 'audio' | 'text' | 'vector';

/** A provider's roster state. `dropped` is a REVERSIBLE flag (constructive-not-destructive) — we
 *  stop routing to it but keep the row, so re-adding is a one-word edit, never an archaeology dig.
 *  `experimental` = known + researched but not yet wired to a live adapter (reason about, don't spend). */
export type ProviderStatus = 'active' | 'experimental' | 'dropped';

/** One company whose API Pixcel can reach. The unit of the roster is the COMPANY + its API — not
 *  a model (models live one layer up, in the self-refreshing registry). */
export interface Provider {
  /** Stable id (also the `ImageProvider` route tag where the two overlap). */
  id: string;
  /** Human label ("Google", "Black Forest Labs"). */
  label: string;
  /** The env var holding this provider's key. Adapters read it; the roster never does. */
  envKey: string;
  /** The live model docs the maintenance agent re-researches on a TTL — the source of freshness. */
  docsUrl: string;
  /** A machine-readable model list where the provider publishes one (GET …/models). Preferred over
   *  scraping `docsUrl` when present: cheaper, structured, exact. Absent → agent reads the docs. */
  modelsEndpoint?: string;
  /** What this provider produces — the coarse routing filter before live capability resolution. */
  modalities: Modality[];
  status: ProviderStatus;
  /** The registry provider TAG this company's models carry (`ImageModel.provider`) when it differs
   *  from the roster `id` — Google's image models are tagged `'gemini'`, not `'google'`. Defaults to
   *  `id`. Bridges roster↔registry without renaming the adapter-facing tag. */
  registryTag?: string;
  /** Why it's here / notable constraint (policy tier, "Flux lives here", "dropped because…"). */
  note?: string;
}

/**
 * The roster. Companies + keys + docs — the deterministic floor. Seeded from Brian's Model Codex
 * (2026-07-17), version-agnostic on purpose: NO model names or versions live here, only the API
 * surface. The Model agent discovers what each provider currently offers.
 *
 * Rostered core (Codex §2): Google, OpenAI, Replicate, xAI, Recraft, Ideogram. Support: Anthropic,
 * Tavily. Forward-looking: Black Forest Labs (Flux direct). Dropped (reversible): Stability, fal.
 */
export const PROVIDERS: Provider[] = [
  {
    id: 'google',
    label: 'Google (Gemini / Veo / Imagen / Lyria)',
    envKey: 'GEMINI_API_KEY',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    modalities: ['image', 'video', 'audio', 'text'],
    status: 'active',
    registryTag: 'gemini',
    note: 'The backbone. Full-suite emphasis (Codex primary directive) — Gemini image, Veo video, Omni multimodal, Lyria audio. Must not miss Google capabilities.',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT Image / GPT)',
    envKey: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/docs/models',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    modalities: ['image', 'text'],
    status: 'active',
    note: 'Second primary. Best-in-class multi-subject composition + complex prompt adherence + native editing.',
  },
  {
    id: 'replicate',
    label: 'Replicate (Flux / specialty / TV-MA)',
    envKey: 'REPLICATE_API_TOKEN',
    docsUrl: 'https://replicate.com/docs',
    modelsEndpoint: 'https://api.replicate.com/v1/models',
    modalities: ['image', 'video', 'audio'],
    status: 'active',
    note: 'Access layer for Flux (dev), open-source specialty, and TV-MA / uncensored models. TV-MA routes MUST pass the spend-cap + policy gate before they are reachable.',
  },
  {
    id: 'xai',
    label: 'xAI (Grok / Grok Imagine)',
    envKey: 'XAI_API_KEY',
    docsUrl: 'https://docs.x.ai/docs/models',
    modelsEndpoint: 'https://api.x.ai/v1/models',
    modalities: ['image', 'text'],
    status: 'active',
    note: 'TV-MA strengths. Gate the same as Replicate TV-MA routes.',
  },
  {
    id: 'recraft',
    label: 'Recraft (SVG / vector / brand)',
    envKey: 'RECRAFT_API_KEY',
    docsUrl: 'https://www.recraft.ai/docs',
    modalities: ['image', 'vector'],
    status: 'active',
    note: 'The vector specialist — native SVG, brand style sets (ties the vector-space scope). Route logos/icons/flat design here.',
  },
  {
    id: 'ideogram',
    label: 'Ideogram (typography)',
    envKey: 'IDEOGRAM_API_KEY',
    docsUrl: 'https://developer.ideogram.ai/api-reference',
    modalities: ['image'],
    status: 'active',
    note: 'The typography specialist — accurate in-image text. Route final ad layouts, t-shirt graphics, signage, wordmarks here.',
  },
  {
    id: 'bfl',
    label: 'Black Forest Labs (Flux direct)',
    envKey: 'BFL_API_KEY',
    docsUrl: 'https://docs.bfl.ml/quick_start/introduction',
    modalities: ['image'],
    status: 'dropped',
    note: 'DROPPED (Brian, 2026-07-26, reversible) — no direct BFL key; Flux is reached via Replicate (the fallback provider for gaps outside the direct-company APIs). Flip to experimental/active + add BFL_API_KEY to wire direct.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude — reasoning)',
    envKey: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    modelsEndpoint: 'https://api.anthropic.com/v1/models',
    modalities: ['text'],
    status: 'active',
    note: 'Support model — the brains behind the agents (Operator / Image / Model). Not a media generator.',
  },
  {
    id: 'tavily',
    label: 'Tavily (web grounding)',
    envKey: 'TAVILY_API_KEY',
    docsUrl: 'https://docs.tavily.com',
    modalities: ['text'],
    status: 'active',
    note: 'Support model — web search / grounding for the platform layer (intent research), NOT a style-exemplar drawer.',
  },
  // ── Dropped (Codex §2). Kept as REVERSIBLE rows — flip status to re-enable, never delete. ──
  {
    id: 'stability',
    label: 'Stability AI',
    envKey: 'STABILITY_API_KEY',
    docsUrl: 'https://platform.stability.ai/docs',
    modalities: ['image'],
    status: 'dropped',
    note: 'Dropped — current foundation models match or exceed it (incl. upscaling). Reversible.',
  },
  {
    id: 'fal',
    label: 'fal',
    envKey: 'FAL_API_KEY',
    docsUrl: 'https://fal.ai/models',
    modelsEndpoint: 'https://fal.ai/api/models?keywords=',
    modalities: ['image', 'video'],
    status: 'active',
    note:
      'ACTIVE and primary for VIDEO: Seedance, Kling and Happy Horse all render through it, and it ' +
      'publishes an OpenAPI schema per endpoint (which is how several adapter bugs were caught before ' +
      'they shipped). It was marked "dropped" from the original roster while simultaneously being the ' +
      'only route to three working models — the sweep skipped it on that basis, which is why Seedance ' +
      '2.5 went unnoticed. NOTE: its endpoint is a KEYWORD SEARCH, not a full listing, so it is swept ' +
      'per model family (see model-succession).',
  },
];

/** Look a provider up by id. */
export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** The registry provider tag this company's models carry (bridges roster id → `ImageModel.provider`). */
export function registryTag(p: Provider): string {
  return p.registryTag ?? p.id;
}

/** Providers we actively route to (status 'active'). Experimental/dropped are excluded from spend
 *  but remain in `PROVIDERS` for the agent to reason + report about ("keeps up with the models"). */
export function activeProviders(): Provider[] {
  return PROVIDERS.filter((p) => p.status === 'active');
}

/** Active providers that can produce a given modality — the coarse routing filter. */
export function providersForModality(modality: Modality): Provider[] {
  return activeProviders().filter((p) => p.modalities.includes(modality));
}

/** Whether a provider's key is present in the environment (a "which providers are live?" check).
 *  The ONE place the roster is allowed near a secret — a boolean presence test, never the value. */
export function providerKeyPresent(p: Provider): boolean {
  const v = process.env[p.envKey];
  return typeof v === 'string' && v.trim().length > 0;
}

/** The distinct env keys the active roster depends on (for a startup "which keys are set?" report). */
export function rosterEnvKeys(): string[] {
  return Array.from(new Set(activeProviders().map((p) => p.envKey)));
}
