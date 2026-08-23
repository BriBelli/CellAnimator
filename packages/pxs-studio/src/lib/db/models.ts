/**
 * DB MODELS — the record shapes + constants for the chat data layer (PR-3).
 *
 * ONE logical table per entity, discriminated by a `category` attribute (Decision 1):
 * Thread / Interaction / Prompt / Usage / UserRecord all extend {@link BaseRecord}.
 * Every record carries `user_id` (the Auth0 subject; dev default `'dev-user'`).
 *
 * These are PURE types + constants — no React, no Next, no DOM — so the whole db/
 * layer runs under `node:test`. The server route imports them at the nodejs runtime.
 */

/**
 * Lifecycle status. Only `active` records are user-visible; the rest are audit/terminal.
 *
 * `inactive` is the output of the per-interaction edit/delete CASCADE — downstream turns are
 * superseded (programmatically) when a turn is edited or deleted. `archived` is RESERVED: an
 * explicit, thread/project-level cold-storage concept for a future two-tier active-DB / archive-DB
 * (partitioned by last-viewed) — NOT the per-interaction cascade. Defined now, unused for it.
 */
export type RecordStatus =
  | 'active'
  | 'pending'
  | 'edited'
  | 'deleted'
  | 'inactive'
  /** RESERVED — explicit thread/project cold-storage (future two-tier DB); NOT the cascade. */
  | 'archived'
  | 'failed'
  | 'cancelled';

/** The entity discriminator on every record. */
export type RecordCategory =
  | 'thread'
  | 'interaction'
  | 'prompt'
  | 'recipe_save'
  | 'usage'
  | 'user'
  | 'asset'
  | 'model_refresh'
  | 'model_card';

/** Fields carried by EVERY record, regardless of category. Timestamps are ms epoch. */
export interface BaseRecord {
  id: string;
  /** Auth0 subject. Dev default: `'dev-user'`. */
  user_id: string;
  category: RecordCategory;
  status: RecordStatus;
  created_at: number;
  updated_at: number;
}

/**
 * A conversation thread — i.e. a PROJECT (the editable workspace / the "PSD"). `context` is the
 * living-context memory/summary (Decision 6-adjacent). See docs/pr-plan/PROJECT-MODEL.md.
 */
export interface Thread extends BaseRecord {
  category: 'thread';
  title: string;
  context?: string;
  /**
   * Retention tier — the draft/saved distinction for PROJECTS (mirrors `Asset.retention`). A project is
   * born 'ephemeral' (a DRAFT: it persists so work is never lost, but it's GC-eligible and doesn't
   * clutter the saved list), and is promoted to 'saved' (durable, named, first-class) by a DELIBERATE
   * act OR the instant it produces its first asset. Enforcement (GC / list filtering) is a later slice;
   * the field + population land now. Absent = treat as 'ephemeral' (back-compat for pre-field threads).
   */
  retention?: 'ephemeral' | 'saved';
  /** Set when a project is promoted ephemeral → saved (ms epoch). Absent = never promoted (still a draft). */
  promoted_at?: number;
  /** When an ephemeral project becomes GC-eligible (ms epoch, ephemeral only). The 14-day sweep reads
   *  this; a saved project has none. Absent on an ephemeral row = swept by the later GC default. */
  expires_at?: number;
  /**
   * Provenance for the verbs (docs/pr-plan/PROJECT-MODEL.md + OBJECT-MODEL-HANDOFF §2). `cloned_from_thread_id`:
   * a Duplicate (Save-As) — a full independent copy. `seeded_from`: a New-from-template or Open-as-project —
   * the Recipe/Asset this workspace was seeded from (a SEED, not a fork: no upstream merge edge). The tagged
   * shape is deliberate (settled §7): a bare id can't say whether it points at an Asset or a Recipe without a
   * lookup. Both are informational lineage, never a live link. Absent = an original project.
   */
  cloned_from_thread_id?: string;
  seeded_from?: { kind: 'asset' | 'recipe'; id: string };
}

/**
 * One model's settled record in a fan-out render — the run's per-model receipt (what was asked,
 * what landed, how it ended, why it was picked). Persisted on the interaction so a reloaded thread
 * repaints the fan status panel — the record of the run, not just its images (360° round-trip).
 */
export interface FanModelSummary {
  model_id: string;
  label: string;
  /** Images this model was asked for. */
  n: number;
  /** Images it actually landed. */
  delivered: number;
  state: 'done' | 'failed';
  /** Failure reason (adapter taxonomy or message) — only on 'failed'. */
  reason?: string;
  /** The selection rationale this model was picked by. */
  why?: string;
  /** Wall-clock ms from dispatch to settle. */
  ms?: number;
}

/** One user↔assistant exchange within a thread. */
export interface Interaction extends BaseRecord {
  category: 'interaction';
  thread_id: string;
  model: string;
  prompt: {
    text: string;
    attachments?: string[];
    /** INPUT tokens this turn's prompt consumed. Pairs with `response.tokens_used` (output). */
    tokens?: number;
  };
  response: {
    text: string;
    /** OUTPUT tokens the model generated (NOT input — the prompt's input lives on `prompt.tokens`). */
    tokens_used: number;
    a2ui: unknown | null;
    /** Stamped from {@link A2UI_VERSION} on every stored a2ui snapshot (Decision 4). */
    a2ui_version: string;
    /** The fan-out's per-model summary — present when this turn ran a render. */
    fan?: FanModelSummary[];
  };
  /** The Prompt entity this interaction was launched from (recipe-IP; Decision 2). */
  source_prompt_id?: string;
  /** Set on an edit-replacement interaction → the interaction it superseded (Decision 6). */
  parent_interaction_id?: string;
}

/**
 * A first-class, reusable prompt — i.e. a RECIPE (recipe-IP; Decision 2). The reusable *method*, no
 * pixels (OBJECT-MODEL-HANDOFF §1: the third noun). E.g. the Character Reference Sheet template.
 */
export interface Prompt extends BaseRecord {
  category: 'prompt';
  /** Display label — BLOCKING: a Recipe cannot be surfaced as a saved Tool/Template without it. */
  name: string;
  text: string;
  tags?: string[];
  /** The prompt's own token size — a recipe-IP metric ("quality > tokens, trim only fat"). */
  tokens?: number;
  /** Which project (Thread) this recipe was extracted from — "Save as template" provenance. */
  source_thread_id?: string;
  /** The `[SLOT]` variables a template exposes (e.g. CHARACTER DESCRIPTION, CLOTHING). Drives the fill UI. */
  variables?: string[];
  /** ORIGIN classification — drives auth AND search/filter. 'user' = the owner's own (Save as template);
   *  'community' = submitted by others (future state); 'pixcel' built-ins are code-side starters, not DB
   *  rows, but the value exists here so a promoted/curated recipe can carry it. Absent → 'user'. */
  scope?: 'pixcel' | 'user' | 'community';
}

/**
 * A user's "love"/save of a Recipe — a FAVORITE POINTER, not a copy. One row per (user, recipe); the
 * user's readily-available Recipes = their own (`scope:user`) PLUS everything they've saved (any scope).
 * `recipe_id` may point at a Prompt id or a built-in starter id. Un-loving is a status flip to 'deleted'.
 */
export interface RecipeSave extends BaseRecord {
  category: 'recipe_save';
  recipe_id: string;
}

/** Per-interaction metering row: tokens + cost (Decision 3). */
export interface Usage extends BaseRecord {
  category: 'usage';
  interaction_id: string;
  input_tokens: number;
  output_tokens: number;
  /** Non-token external spend for this interaction (image/video generation cost, USD). */
  gen_cost_usd: number;
  /** Total cost = token cost + gen_cost_usd. */
  cost_usd: number;
}

/**
 * A generated (or uploaded) MEDIA ASSET — the durable artifact a generation produced. Metadata-first:
 * the record IS the asset's identity + provenance; the bytes ride on `url`/`data`.
 *
 * SLICE 1 (persistence backbone) populates the core + provenance + the model output `url` so images
 * survive reload. Later slices enrich: Slice 2 the full recipe (parts/formula/score) + `tags` +
 * `parent_asset_id` lineage; Slice 3 hardens `url` (which may be an EXPIRING provider URL) into
 * durable bytes; Slice 4 the WP editorial fields via the Asset Details drawer.
 */
export interface Asset extends BaseRecord {
  category: 'asset';
  /** What the asset IS (drives the renderer). Slice 1 persists 'image'. */
  kind: 'image' | 'video' | 'pixel' | 'vector';
  /** Where it came from (Slice 2). 'generated' = a Pixcel render; 'upload' = a user-attached reference. */
  source?: 'generated' | 'upload';
  /**
   * Retention tier (Slice 2 — THE rule): anything born in a chat (generations AND attached references)
   * is 'ephemeral' (in-state: visible in history, GC-eligible, doesn't permanently count against quota).
   * It becomes 'saved' (first-class, durable, quota'd) only by a DELIBERATE act — an explicit upload in
   * the Asset location or a Save. Enforcement (GC/quota) lands in a later slice; the field lands now.
   */
  retention?: 'ephemeral' | 'saved';
  /** When an ephemeral asset becomes GC-eligible (ms epoch). Unset = swept by the later GC policy. */
  expires_at?: number;
  /** Lineage EDGES: the reference assets that produced this generation (the many-to-many web the node
   *  tree renders). Distinct from `parent_asset_id` (single-parent edit/version lineage). */
  reference_asset_ids?: string[];
  /** Provenance — which conversation/turn produced it (the FKs the gallery + hydrate query on). */
  thread_id: string;
  interaction_id: string;
  /** The model output. May be a data: URL or an expiring provider https URL (hardened in Slice 3). */
  url: string;
  /** Small JSON substrate (e.g. a PXSFrame) stored inline when the kind carries one. */
  data?: unknown;
  /** The model that produced it (label now; id + full recipe in Slice 2). */
  model_label?: string;
  model?: string;
  /** Position within its generation batch (tile index). */
  index?: number;
  /** The prompt/recipe that produced it (a string now; structured recipe in Slice 2). */
  prompt?: string;
  /** Realized generation spend attributable to this asset (USD). */
  gen_cost_usd?: number;
  /** Flat "what it is" tags (Slice 2+). */
  tags?: string[];
  /** Lineage: an edit/variation points to the asset it derived from — a version DAG, never overwrite. */
  parent_asset_id?: string;
  /** WordPress-style editorial metadata (Slice 4 drawer). */
  title?: string;
  alt_text?: string;
  caption?: string;
  description?: string;
}

/** The per-user record holding the running spend totals + the hard cap (Decision 3). */
export interface UserRecord extends BaseRecord {
  category: 'user';
  running_input_tokens: number;
  running_output_tokens: number;
  running_cost_usd: number;
  hard_cap_usd: number;
}

/**
 * The persisted outcome of ONE provider's registry refresh (the living overlay on the seed catalog).
 * System-scoped (not per end-user). Id is stable: `model_refresh:<provider>` — upserted each pass, so
 * `checked_at` is the freshness the due-check reads (keeps the seed const immutable — the DB holds the
 * living freshness + discoveries, layered on top). See `agents/model-refresh-runner.ts`.
 */
export interface ModelRefreshRecord extends BaseRecord {
  category: 'model_refresh';
  /** Roster provider id checked (e.g. 'google', 'openai'). */
  provider: string;
  /** Epoch ms of the last SUCCESSFUL reconcile — the effective freshness for this provider's models. */
  checked_at: number;
  /** Curated registry ids confirmed present in the live listing this pass. */
  confirmed: string[];
  /** Live models with no curated match — research candidates the maintenance agent must vet. */
  discovered: { id: string; label?: string }[];
  /** Curated ids not found live this pass — flagged for review; NEVER auto-retired. */
  unconfirmed: string[];
}

/**
 * The living per-model record — the maintenance layer that CLOSES the self-maintaining loop. Two
 * origins: a `discovered` card is a model the refresh worker found live and the maintenance agent
 * researched into a routable record (`card` = a full ImageModel); a `seed_override` card annotates a
 * SEED model without mutating the const — today only to retire a persistent ghost (`card` = null).
 * Id is stable: `model_card:<model_id>`. System-scoped. Retirement is REVERSIBLE + evidence-based
 * (`miss_count` across passes), never an LLM guess.
 */
export interface ModelCard extends BaseRecord {
  category: 'model_card';
  /** The registry model id this card is for (matches ImageModel.id). */
  model_id: string;
  /** Roster provider id. */
  provider: string;
  /** The researched ImageModel for a discovery; null for a pure seed_override (e.g. a retirement). */
  card: unknown | null;
  origin: 'discovered' | 'seed_override';
  /** How trusted the research is. Below 'high' → kept out of routing (preview/needsResearch). */
  confidence: 'low' | 'medium' | 'high';
  /** A seed model retired after repeated misses. Reversible — cleared when it reappears live. */
  retired?: boolean;
  /** Consecutive refresh passes a seed model was unconfirmed (evidence toward retirement). */
  miss_count?: number;
  researched_at: number;
  /** Where the research was grounded (docs url / listing) — provenance. */
  source?: string;
}

/** Union of every stored record shape. */
export type AnyRecord =
  | Thread
  | Interaction
  | Prompt
  | Usage
  | UserRecord
  | Asset
  | ModelRefreshRecord
  | ModelCard;

/** Stamped on every stored a2ui snapshot so the renderer can version-gate (Decision 4). */
export const A2UI_VERSION = 'a2ui-v1';

/**
 * Opus 4.8 pricing (USD per token). Source of truth for cost math.
 * Input $5 / 1M tokens, output $25 / 1M tokens.
 */
export const INPUT_USD_PER_TOKEN = 5 / 1_000_000;
export const OUTPUT_USD_PER_TOKEN = 25 / 1_000_000;

/** Dev default user id when no Auth0 subject is present. */
export const DEV_USER_ID = 'dev-user';
