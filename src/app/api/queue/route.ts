import { NextResponse } from 'next/server';
import { getQueueItem, getQueueState } from '@/lib/store';
import { getSessionSurgeon } from '@/server/auth';
import { buildWindow, canRead, toPayload } from '@/server/queue-access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/queue            -> the window around the current position
 * GET /api/queue?index=12   -> one item, if the surgeon is allowed to see it
 */
export async function GET(request: Request) {
  const surgeon = await getSessionSurgeon();
  if (!surgeon) return NextResponse.json({ error: 'not_authorised' }, { status: 401 });

  const url = new URL(request.url);
  const rawIndex = url.searchParams.get('index');

  if (rawIndex === null) {
    return NextResponse.json(buildWindow(surgeon.id));
  }

  const index = Number(rawIndex);
  if (!Number.isInteger(index)) return NextResponse.json({ error: 'bad_index' }, { status: 400 });

  const state = getQueueState(surgeon.id);
  if (!canRead(state, index)) return NextResponse.json({ error: 'out_of_range' }, { status: 403 });

  const item = getQueueItem(surgeon.id, index);
  if (!item) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json({ state, items: [toPayload(item, state.total)] });
}
