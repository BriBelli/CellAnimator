import { getDb, DEV_USER_ID, type Asset, type Thread } from '../../../../lib/db';

export const runtime = 'nodejs';

/**
 * /api/threads/[id] — rename + delete a project (Slice 5 CRUD). THE THREAD IS THE PROJECT.
 *
 * PATCH  { title }  → rename the project (updates the thread record title + bumps updated_at).
 * DELETE            → soft-delete the project AND its assets (status:'deleted'). Aggressive by design
 *                     (Brian): deleting a project removes its media too. Audit rows survive.
 */

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { title?: string; status?: 'active' };
    const db = await getDb();

    // UNDO a delete — restore the project + re-activate the assets the delete cascaded (status flip
    // back to 'active'; there is no trash table, per the object model). The 10-second Undo toast.
    if (body.status === 'active') {
      const url = new URL(req.url);
      const userId = (url.searchParams.get('user_id') ?? '').trim() || DEV_USER_ID;
      const restored = await db.update<Thread>('thread', id, { status: 'active' });
      if (!restored) return Response.json({ error: 'project not found' }, { status: 404 });
      try {
        const { items: assets } = await db.query({ category: 'asset', user_id: userId, filter: { thread_id: id, status: 'deleted' } });
        for (const a of assets as Asset[]) await db.update('asset', a.id, { status: 'active' });
        const { items: inters } = await db.query({ category: 'interaction', user_id: userId, filter: { thread_id: id, status: 'deleted' } });
        for (const it of inters) await db.update('interaction', it.id, { status: 'active' });
      } catch (err) {
        console.warn('[threads] restore failed (thread still restored):', err);
      }
      return Response.json({ thread: { id, updated_at: restored.updated_at } });
    }

    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
    if (!title) return Response.json({ error: 'title is required' }, { status: 400 });
    const updated = await db.update<Thread>('thread', id, { title });
    if (!updated) return Response.json({ error: 'project not found' }, { status: 404 });
    return Response.json({ thread: { id, title, updated_at: updated.updated_at } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: `Failed to rename project: ${message}` }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const userId = (url.searchParams.get('user_id') ?? '').trim() || DEV_USER_ID;
    const db = await getDb();
    const thread = await db.update<Thread>('thread', id, { status: 'deleted' });
    if (!thread) return Response.json({ error: 'project not found' }, { status: 404 });
    // Cascade: soft-delete the project's ASSETS *and* INTERACTIONS — otherwise loadThread finds the
    // still-active interactions on reload and RESURRECTS the "deleted" project (the bug).
    try {
      const { items: assets } = await db.query({ category: 'asset', user_id: userId, filter: { thread_id: id, status: 'active' } });
      for (const a of assets as Asset[]) await db.update('asset', a.id, { status: 'deleted' });
      const { items: inters } = await db.query({ category: 'interaction', user_id: userId, filter: { thread_id: id, status: 'active' } });
      for (const it of inters) await db.update('interaction', it.id, { status: 'deleted' });
    } catch (err) {
      console.warn('[threads] cascade failed (thread still deleted):', err);
    }
    return Response.json({ ok: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: `Failed to delete project: ${message}` }, { status: 500 });
  }
}
