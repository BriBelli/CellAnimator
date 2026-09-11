/**
 * THE REFRESH WORKER — what makes the registry SELF-MAINTAINING instead of hand-authored.
 *
 * Runs out-of-band (never in a user's turn — see staleness.ts for why): pick the providers whose
 * records have passed their TTL, fetch each provider's LIVE model listing, and reconcile it against
 * our curated shard. The result restamps what's still there, surfaces genuinely-new models as
 * research candidates, and FLAGS (never auto-retires) curated models it can't find.
 *
 * Why conservative? A provider's live id ('gemini-2.5-flash-image-preview') rarely equals our
 * registry slug, and matching is fuzzy. Auto-retiring on a missed string-match would
 * silently delete curated craft; auto-adding raw ids would fill the catalog with unvetted routes.
 * So the deterministic pass only does what's SAFE — confirm, discover, flag — and leaves the
 * judgment calls (enrich a discovered model, retire a vanished one) to the maintenance agent.
 *
 * I/O is injected (`RefreshDeps.fetchLive`), so the reconcile logic is pure + deterministic (`now`
 * passed in) and fully unit-tested with no network. The real network `fetchProviderModels` lives
 * here too but is only reached through the default deps.
 */

import type { ImageModel } from './model-registry';
import { PROVIDERS, registryTag, providerKeyPresent, type Provider } from './provider-roster';
import { isDueForRefresh, DEFAULT_TTL_HOURS } from './staleness';

/** A model as a provider's live listing reports it (normalized across provider response shapes). */
export interface LiveModel {
  /** The provider's canonical model id (e.g. 'gemini-3-pro-image', 'gpt-image-1.5'). */
  id: string;
  /** Human display name where the provider gives one. */
  label?: string;
}

/** The outcome of reconciling one provider's live listing against our curated shard. Persistence of
 *  this result (restamp / add candidates / review flags) lands in the registry-store slice; for now
 *  it's the honest, testable diff the maintenance step consumes. */
export interface ReconcileResult {
  /** Roster provider id checked. */
  provider: string;
  /** Registry ids of curated models CONFIRMED present in the live listing → restamp their freshness. */
  confirmed: string[];
  /** Live models with NO curated match — research candidates (would land as `needsResearch`). */
  discovered: LiveModel[];
  /** Registry ids curated but NOT found live — FLAG for the agent to review; never auto-retired. */
  unconfirmed: string[];
  /** ISO date (YYYY-MM-DD) the check ran. */
  checkedAt: string;
}

export interface RefreshDeps {
  /** Epoch ms — injected so reconcile is deterministic + testable. */
  now: number;
  /** Fetch a provider's live model list; null when unavailable (no key, network error, no endpoint). */
  fetchLive: (provider: Provider) => Promise<LiveModel[] | null>;
  /** Freshness window; defaults to 24h. */
  ttlHours?: number;
}

/** Normalize an id/label for fuzzy comparison: lowercase, drop a leading 'models/' (Google), trim. */
function norm(s: string): string {
  return s.toLowerCase().replace(/^models\//, '').trim();
}

/** Does a curated key (our providerModelId or slug) correspond to this live model? Conservative but
 *  tolerant of version/preview suffixes: exact, or one id is a substring of the other (with a length
 *  guard so a 3-char slug can't spuriously match everything), or the label lines up. Used ONLY for
 *  the low-stakes "still exists?" confirmation and to avoid re-discovering a curated model. */
export function curatedMatchesLive(curatedKey: string, live: LiveModel): boolean {
  const ck = norm(curatedKey);
  if (ck.length < 3) return false;
  const lid = norm(live.id);
  if (lid === ck) return true;
  if (lid.includes(ck) || (ck.length >= 6 && ck.includes(lid) && lid.length >= 6)) return true;
  if (live.label) {
    const ll = norm(live.label);
    if (ll === ck || ll.includes(ck)) return true;
  }
  return false;
}

/**
 * Reconcile one provider's live listing against the current catalog. Pure + deterministic.
 * Only touches models whose `provider` tag matches `registryProviderTag` (the roster↔registry bridge).
 */
export function reconcile(
  current: ImageModel[],
  live: LiveModel[],
  providerId: string,
  registryProviderTag: string,
  now: number
): ReconcileResult {
  const checkedAt = new Date(now).toISOString().slice(0, 10);
  const curated = current.filter((m) => m.provider === registryProviderTag);
  const confirmed: string[] = [];
  const unconfirmed: string[] = [];
  const matchedLiveIds = new Set<string>();

  for (const c of curated) {
    const key = c.providerModelId || c.id;
    const hit = live.find((l) => curatedMatchesLive(key, l));
    if (hit) {
      confirmed.push(c.id);
      matchedLiveIds.add(hit.id);
    } else {
      unconfirmed.push(c.id);
    }
  }

  // Discovered = live models that matched no curated model at all (not already claimed, and no
  // curated key corresponds to them). These are the "new model dropped" candidates.
  const discovered = live.filter(
    (l) => !matchedLiveIds.has(l.id) && !curated.some((c) => curatedMatchesLive(c.providerModelId || c.id, l))
  );

  return { provider: providerId, confirmed, discovered, unconfirmed, checkedAt };
}

/**
 * Which providers are DUE for a structural refresh: active, has a `modelsEndpoint` (docs-scrape
 * providers are handled by a later slice), and at least one of its curated models is past TTL.
 */
export function providersDue(
  providers: Provider[],
  models: ImageModel[],
  now: number,
  ttlHours: number = DEFAULT_TTL_HOURS
): Provider[] {
  return providers.filter((p) => {
    if (p.status !== 'active' || !p.modelsEndpoint) return false;
    const tag = registryTag(p);
    return models.some((m) => m.provider === tag && isDueForRefresh(m.sourceRefreshedAt, now, ttlHours));
  });
}

/**
 * Run one refresh pass: reconcile every due provider. Returns the per-provider diffs. Never throws
 * (a provider that fails to fetch is simply skipped this pass — it stays due for the next one).
 * PERSISTENCE of the diffs is the next slice; today the caller logs / inspects them.
 */
export async function runRegistryRefresh(models: ImageModel[], deps: RefreshDeps): Promise<ReconcileResult[]> {
  const ttl = deps.ttlHours ?? DEFAULT_TTL_HOURS;
  const due = providersDue(PROVIDERS, models, deps.now, ttl);
  const results: ReconcileResult[] = [];
  for (const p of due) {
    let live: LiveModel[] | null = null;
    try {
      live = await deps.fetchLive(p);
    } catch {
      live = null;
    }
    if (!live) continue; // couldn't reach it — leave due for next pass, don't fabricate a diff
    results.push(reconcile(models, live, p.id, registryTag(p), deps.now));
  }
  return results;
}

// ── Real network fetch (only reached via default deps; unit tests inject a fake) ─────────────────

/** Pull a provider's live model listing over the network, normalized to `LiveModel[]`. Best-effort:
 *  returns null on missing key, non-200, or any parse error — the worker treats null as "skip". */
export async function fetchProviderModels(provider: Provider): Promise<LiveModel[] | null> {
  const endpoint = provider.modelsEndpoint;
  if (!endpoint || !providerKeyPresent(provider)) return null;
  const key = process.env[provider.envKey] as string;
  try {
    let url = endpoint;
    const headers: Record<string, string> = {};
    switch (provider.id) {
      case 'google':
        url = `${endpoint}?key=${encodeURIComponent(key)}&pageSize=200`;
        break;
      case 'anthropic':
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'replicate':
        headers['Authorization'] = `Token ${key}`;
        break;
      default: // openai + OpenAI-compatible
        headers['Authorization'] = `Bearer ${key}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return normalizeModelList(provider.id, json);
  } catch {
    return null;
  }
}

/** Map each provider's response shape onto `LiveModel[]`. Defensive — unknown shape → []. */
export function normalizeModelList(providerId: string, json: unknown): LiveModel[] {
  const j = json as Record<string, unknown>;
  const pick = (arr: unknown, map: (o: Record<string, unknown>) => LiveModel | null): LiveModel[] =>
    Array.isArray(arr) ? arr.map((o) => map(o as Record<string, unknown>)).filter((x): x is LiveModel => !!x) : [];

  switch (providerId) {
    case 'google':
      return pick(j.models, (o) => {
        const name = typeof o.name === 'string' ? o.name.replace(/^models\//, '') : '';
        return name ? { id: name, label: typeof o.displayName === 'string' ? o.displayName : undefined } : null;
      });
    case 'anthropic':
    case 'openai':
      return pick(j.data, (o) =>
        typeof o.id === 'string' ? { id: o.id, label: typeof o.display_name === 'string' ? o.display_name : undefined } : null
      );
    case 'replicate':
      return pick(j.results, (o) => {
        const owner = typeof o.owner === 'string' ? o.owner : '';
        const name = typeof o.name === 'string' ? o.name : '';
        return owner && name ? { id: `${owner}/${name}`, label: name } : null;
      });
    default:
      // OpenAI-compatible fallback.
      return pick(j.data, (o) => (typeof o.id === 'string' ? { id: o.id } : null));
  }
}

/** Default deps for a live pass (real network, real clock). Callers in a background job use this. */
export function liveRefreshDeps(now: number): RefreshDeps {
  return { now, fetchLive: fetchProviderModels };
}
