import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Liveness for Docker and for whatever sits in front of it. Leaks nothing. */
export async function GET() {
  try {
    getDb().prepare('SELECT 1').get();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
