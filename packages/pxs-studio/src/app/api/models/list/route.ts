import '../../../../lib/engine/adapters'; // registers provider adapters so readyProviders() is accurate
import { IMAGE_MODELS } from '../../../../lib/engine/model-registry';
import { readyProviders } from '../../../../lib/engine/executor';

export const runtime = 'nodejs';

/**
 * GET /api/models/list — the image models the fan-out picker offers. Each carries what the picker needs
 * to show + let the user choose: label, provider, tier, capabilities, cost band, ref limit, and whether
 * it's READY (a configured adapter with a key). Preview-only models are excluded (not callable). The
 * registry is the source of truth + self-maintaining — this is a read.
 */
export async function GET() {
  const ready = new Set(readyProviders());
  const models = IMAGE_MODELS.filter((m) => !m.preview).map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    tier: m.tier,
    capabilities: m.capabilities,
    brief: m.brief,
    maxReferenceImages: m.maxReferenceImages,
    costPerImageUsd: m.costPerImageUsd,
    ready: ready.has(m.provider),
  }));
  return Response.json({ models });
}
