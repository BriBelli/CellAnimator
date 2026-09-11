import { getDb } from '../../../../lib/db';
import { runModelIntelligence } from '../../../../lib/agents/model-intelligence';
import { loadCards } from '../../../../lib/agents/live-catalog';
import { loadRefreshState } from '../../../../lib/agents/model-refresh-runner';
import { loadDoctrines } from '../../../../lib/agents/doctrine-refresh';

export const runtime = 'nodejs';
export const maxDuration = 120; // a BOUNDED pass — see runModelIntelligence's per-call caps

/**
 * THE MODEL-INTELLIGENCE ENDPOINT — the single trigger for the single workflow (see
 * lib/agents/model-intelligence.ts). The old /api/models/refresh and /api/models/research routes are
 * folded in here: one POST = availability sweep -> discovery research / ghost judgment -> capability
 * re-verification. Point the daily cron here; the image-agent hot path runs the same workflow lazily
 * (TTL-gated) so the cycle holds even without a cron.
 *
 * GET  -> the living state: per-provider availability + researched model cards + prompt doctrines.
 * POST -> run a BOUNDED pass now (deliberate, metered: Tavily + LLM spend). Capped per call so the
 *         request returns promptly and cannot monopolize the server; call it again to continue
 *         through the catalog. `?force=1` runs everything regardless of freshness — operator-only,
 *         and genuinely long-running.
 */
export async function GET() {
  const db = await getDb();
  const [cards, providers, doctrines] = await Promise.all([loadCards(db), loadRefreshState(db), loadDoctrines(db)]);
  return Response.json({
    providers: Array.from(providers.values()),
    cards: Array.from(cards.values()),
    doctrines: Array.from(doctrines.values()),
  });
}

export async function POST(req: Request) {
  const db = await getDb();
  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    const summary = await runModelIntelligence(db, Date.now(), { force });
    return Response.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'model intelligence pass failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
