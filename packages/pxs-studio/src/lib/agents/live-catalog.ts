/**
 * THE LIVE CATALOG — the merged read that layers the living DB records over the seed const.
 *
 * seed (hand-curated base) + freshness overlay + model_card layer =
 *   · discovered+researched models APPENDED (now routable, subject to their confidence gate)
 *   · retired seed ghosts FILTERED OUT (reversible)
 *
 * This is the surface the model-agent/router will consume so the self-maintaining registry actually
 * feeds routing (the final wire). It NEVER mutates the seed const — the DB holds the deltas. Guarded
 * for the hot path: any failure falls back to the plain seed, so a bad card can never dead-end
 * selection.
 */

import { IMAGE_MODELS, isPruned, type ImageModel } from '../engine/model-registry';
import { overlayFreshness, loadRefreshState } from './model-refresh-runner';
import type { Repository } from '../db/repository';
import type { ModelCard } from '../db/models';

export const SYSTEM_USER_ID = 'system';

/** Load the ACTIVE model cards, keyed by model_id. A card marked `deleted` is soft-removed: it
 *  leaves the catalog and becomes eligible for clean re-discovery, without destroying the record. */
export async function loadCards(repo: Repository): Promise<Map<string, ModelCard>> {
  const res = await repo.query({ category: 'model_card', user_id: SYSTEM_USER_ID, filter: { status: 'active' } });
  const map = new Map<string, ModelCard>();
  for (const c of res.items as ModelCard[]) map.set(c.model_id, c);
  return map;
}

/**
 * Compose the effective catalog from seed + persisted refresh freshness + model cards. Pure given
 * its inputs (so it's unit-tested without a repo); `getLiveCatalog` wires it to the DB.
 */
export function composeCatalog(
  seed: ImageModel[],
  refreshState: Parameters<typeof overlayFreshness>[1],
  cards: Map<string, ModelCard>
): ImageModel[] {
  // 1. Freshness overlay on the seed.
  let catalog = overlayFreshness(seed, refreshState);

  // 2. Drop seed models retired by a seed_override card (reversible).
  const retired = new Set(
    [...cards.values()].filter((c) => c.origin === 'seed_override' && c.retired).map((c) => c.model_id)
  );
  if (retired.size > 0) catalog = catalog.filter((m) => !retired.has(m.id));

  // 2b. PATCH seed models with RESEARCHED capabilities (seed_override cards, medium/high confidence).
  // This is what makes the hand-typed seed give way to SOURCED facts: the card's `card` holds the
  // researched partial (maxReferenceImages, supportsEditing, capabilities, aspectRatios). Low confidence
  // is ignored (stays seed — honest, never overwrites truth with a weak guess).
  const patches = new Map<string, Partial<ImageModel>>(
    [...cards.values()]
      .filter((c) => c.origin === 'seed_override' && !c.retired && c.confidence !== 'low' && c.card && typeof c.card === 'object')
      .map((c) => [c.model_id, c.card as Partial<ImageModel>])
  );
  if (patches.size > 0) catalog = catalog.map((m) => (patches.has(m.id) ? { ...m, ...patches.get(m.id) } : m));

  // 3. Append discovered+researched models that aren't already present. A card with `card: null` is
  //    a RECORDED REJECTION (not an image model, or a deliberately-pruned model found live again) —
  //    knowledge we keep so it isn't re-researched, but never something we route to.
  const seen = new Set(catalog.map((m) => m.id));
  for (const c of cards.values()) {
    if (c.origin !== 'discovered' || !c.card) continue;
    const model = c.card as ImageModel;
    if (!model?.id || seen.has(model.id)) continue;
    // Last line of defence: a pruned id can never re-enter the catalog through a stale card.
    if (isPruned(model.id) || isPruned(model.providerModelId ?? '')) continue;
    catalog.push(model);
    seen.add(model.id);
  }
  return catalog;
}

/** The DB-wired live catalog. Guarded: any error → the plain seed (never dead-ends selection). */
export async function getLiveCatalog(repo: Repository): Promise<ImageModel[]> {
  try {
    const [state, cards] = await Promise.all([loadRefreshState(repo), loadCards(repo)]);
    return composeCatalog(IMAGE_MODELS, state, cards);
  } catch {
    return IMAGE_MODELS;
  }
}
