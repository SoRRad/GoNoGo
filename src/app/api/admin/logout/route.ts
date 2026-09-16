import { NextResponse } from 'next/server';
import { clearAdminSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  await clearAdminSession();
  return NextResponse.redirect(new URL('/admin', request.url), { status: 303 });
}
