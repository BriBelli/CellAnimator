import { getDb } from '../../../lib/db';
import { getDoctrine, loadDoctrines } from '../../../lib/agents/doctrine-refresh';
import { getLiveCatalog } from '../../../lib/agents/live-catalog';
import { getDefaultImageModel } from '../../../lib/engine/model-registry';
import { critiquePrompt, type CraftResult } from '../../../lib/agents/model-agent/craft-critique';
import { rollupCritiques } from '../../../lib/agents/model-agent/craft-rollup';
import { compileFan, formulaFor } from '../../../lib/engine/prompt-compile';
import type { ModelDoctrine } from '../../../lib/agents/model-agent/doctrine';
import type { PromptFormula } from '../../../lib/engine/model-registry';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/prompt-critique — the CRAFT score: the user's prompt judged against each target model's
 * distilled doctrine, with reasons and fixes attached.
 *
 * Two modes, matching how the cost should actually be spent:
 *   · ONE model (`modelId`)   — judge the lens the user is looking at. One call.
 *   · THE FAN (`modelIds[]`)  — judge every model, then ROLL UP: which findings are universal (fix
 *     once, everything improves) vs model-specific. N calls, so it is always user-initiated.
 *
 * The brief is authored ONCE in the lead model's formula and COMPILED into each model's shape before
 * judging (prompt-compile.ts) — every model is critiqued on the prompt it would actually receive,
 * not on the lead's wording. Degrades honestly: no doctrine → `available: false` with a reason.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      modelId?: string;
      modelIds?: string[];
      parts?: { id?: string; label?: string; value?: string }[];
      /** Per-model deliberate overrides (a diverged lens), keyed by model id → part id → value. */
      overrides?: Record<string, Record<string, string>>;
    };

    const parts = (body.parts ?? [])
      .map((p) => ({ id: String(p?.id ?? '').trim(), label: String(p?.label ?? '').trim(), value: String(p?.value ?? '') }))
      .filter((p) => p.id);
    if (parts.length === 0) return Response.json({ available: false, reason: 'empty_prompt' });

    const db = await getDb();
    const catalog = await getLiveCatalog(db);
    const pick = (id?: string) => catalog.find((m) => m.id === id);

    const requested = (body.modelIds ?? []).map(pick).filter((m): m is NonNullable<typeof m> => !!m);
    const lead = pick(body.modelId) ?? requested[0] ?? getDefaultImageModel();
    const targets = requested.length > 0 ? requested : [lead];

    // Doctrines drive BOTH the formula each model compiles into and the judgement itself.
    const doctrines = new Map<string, ModelDoctrine>();
    try {
      for (const [id, rec] of await loadDoctrines(db)) {
        if (rec.doctrine) doctrines.set(id, rec.doctrine as ModelDoctrine);
      }
    } catch {
      /* none yet — judged models will report no_doctrine, honestly */
    }
    const doctrineFormulas = new Map<string, PromptFormula>();
    for (const [id, d] of doctrines) if (d.formula) doctrineFormulas.set(id, d.formula);

    const leadValues = Object.fromEntries(parts.map((p) => [p.id, p.value]));
    const compiled = compileFan(targets, lead.id, leadValues, { doctrineFormulas, overrides: body.overrides });

    const results: CraftResult[] = [];
    for (const c of compiled) {
      const model = targets.find((m) => m.id === c.modelId)!;
      results.push(
        await critiquePrompt({
          modelId: model.id,
          modelLabel: model.label,
          formula: formulaFor(model, doctrineFormulas.get(model.id)),
          parts: c.parts.map((p) => ({ id: p.id, label: p.label, value: p.value })),
          doctrine: doctrines.get(model.id) ?? (await getDoctrine(db, model.id)),
        }),
      );
    }

    // Single-lens mode keeps the flat CraftResult shape the panel already renders.
    if (results.length === 1 && !body.modelIds?.length) return Response.json(results[0]);

    // Map each model's part ids back onto the lead's, so "location"/"setting" findings group as one.
    const leadIds = new Set(parts.map((p) => p.id));
    const partAliases: Record<string, string> = {};
    for (const c of compiled) {
      for (const p of c.parts) {
        if (!leadIds.has(p.id)) {
          const match = parts.find((lp) => lp.value && lp.value === p.value);
          if (match) partAliases[p.id] = match.id;
        }
      }
    }

    return Response.json({ results, rollup: rollupCritiques(results, partAliases), compiled });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'critique failed';
    return Response.json({ available: false, reason: 'failed', error: message }, { status: 500 });
  }
}
