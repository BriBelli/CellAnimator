import { getDb } from '../../../../lib/db';
import { IMAGE_MODELS } from '../../../../lib/engine/model-registry';
import { refreshCapabilities } from '../../../../lib/agents/capability-refresh';

export const runtime = 'nodejs';
export const maxDuration = 300; // research is a Tavily + Claude call per model

/**
 * POST /api/models/research — run grounded capability research across every image model and persist the
 * SOURCED facts as seed_override cards (which composeCatalog overlays onto the seed). This is the agent
 * maintaining its own knowledge; the response summarizes what it applied + the provenance.
 */
export async function POST() {
  try {
    const db = await getDb();
    const results = await refreshCapabilities(IMAGE_MODELS, db, { now: Date.now() });
    const applied = results.filter((r) => r.applied).length;
    return Response.json({ applied, total: results.length, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: `capability research failed: ${message}` }, { status: 500 });
  }
}
