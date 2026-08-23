/**
 * AGENT MODEL CONFIG — the ONE place that names which Claude model each agent BRAIN uses.
 *
 * The principle (Brian's "model locked to best, above the user", made precise):
 *   • FLOOR — every brain defaults to the best model that earns its cost. A user can never drop BELOW
 *     this and degrade the output. That's the quality floor, locked.
 *   • OPT-UP — a role can be raised to a premium brain (e.g. Fable) and the cost owned by whoever chose
 *     it. Never below the floor. A floor with a backdoor, not a cage.
 *
 * Today the lever is a per-role ENV override, so we can PILOT one model on one role (Fable on the image
 * agent's prompt craft) WITHOUT a fleet-wide swap — reversible by deleting the env var. When the pilot
 * proves out, the same map becomes the source for a user-facing "reasoning model" dropdown (Cursor-style,
 * user pays for the upgrade): swap the env read for a per-request/per-user selection, floor still enforced.
 *
 * Model ids are the exact strings the Anthropic SDK expects — see the claude-api skill. Fable
 * (`claude-fable-5`) has thinking always-on (adaptive is fine; never send disabled/sampling params) and
 * costs ~2× Opus/token on a ~+30% tokenizer, so it is an OPT-UP, never a silent default.
 */

/** The locked quality FLOOR — the best cost-justified default. Overrides may only go UP from here. */
export const MODEL_FLOOR = 'claude-opus-4-8';

/** Read a per-role override from env, else the floor. Trimmed; empty → floor. */
function role(envVar: string): string {
  const v = process.env[envVar]?.trim();
  return v && v.length > 0 ? v : MODEL_FLOOR;
}

/**
 * Per-role agent brains. Each defaults to the floor; each is independently overridable so a pilot on
 * ONE role never touches the others. The image agent's prompt craft is the first pilot target — it is
 * where art quality is actually decided.
 */
export const AGENT_MODELS = {
  /** Front-door Operator (classify / decide the OODA verdict) — interactive, latency-sensitive. */
  operator: role('PIXCEL_MODEL_OPERATOR'),
  /** The IMAGE AGENT's brain — crafts the model-ready prompt + shapes the builder. Where craft lives.
   *  THE Fable pilot target: set PIXCEL_MODEL_IMAGE_PROMPT=claude-fable-5 to trial it here alone. */
  imageAgent: role('PIXCEL_MODEL_IMAGE_PROMPT'),
  /** Gate-2 model RANKER — the cross-validation reasoning over the roster shortlist. */
  ranker: role('PIXCEL_MODEL_RANKER'),
  /** Capability RESEARCH extraction — offline, self-maintaining registry. */
  research: role('PIXCEL_MODEL_RESEARCH'),
  /** Registry MAINTENANCE reasoning — offline. */
  maintenance: role('PIXCEL_MODEL_MAINTENANCE'),
} as const;

export type AgentRole = keyof typeof AGENT_MODELS;
