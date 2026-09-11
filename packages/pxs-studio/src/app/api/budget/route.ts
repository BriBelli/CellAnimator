import { getDb } from '../../../lib/db';
import { getBudget, setSpendCap } from '../../../lib/db/usage';

export const runtime = 'nodejs';

const DEV_USER_ID = 'dev-user';

/**
 * /api/budget — the user's own spend budget.
 *
 * This exists because the cap was previously a developer guardrail: a $5 number set once at account
 * creation that nobody could change. On a medium where one 10-second 1080p clip is $3.40, that is
 * not a safety rail, it is a wall. The person paying decides how much they are willing to spend;
 * our job is to meter it honestly, show it before they commit, and stop cleanly when it runs out.
 *
 * GET   → the current budget (cap, spent, remaining, used fraction).
 * PATCH → set the cap. Honoured immediately; only refused for values that cannot be meant.
 */
export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get('user_id')?.trim() || DEV_USER_ID;
  const db = await getDb();
  return Response.json(await getBudget(db, userId));
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { cap_usd?: unknown; user_id?: string };
  const userId = (body.user_id ?? '').trim() || DEV_USER_ID;
  const cap = typeof body.cap_usd === 'number' ? body.cap_usd : Number(body.cap_usd);

  const db = await getDb();
  const result = await setSpendCap(db, userId, cap);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  return Response.json(result.budget);
}
