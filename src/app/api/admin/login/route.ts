import { NextResponse } from 'next/server';
import { checkAdminPassword, setAdminSession } from '@/server/auth';
import { checkLockout, clientAddress, recordFailure, recordSuccess } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const address = clientAddress(request);

  const lockout = checkLockout(address);
  if (lockout.locked) {
    return NextResponse.redirect(
      new URL(`/admin?error=locked&retry=${lockout.retryAfterSeconds}`, request.url),
      { status: 303, headers: { 'Retry-After': String(lockout.retryAfterSeconds) } },
    );
  }

  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.redirect(new URL('/admin?error=unset', request.url), { status: 303 });
  }

  if (!checkAdminPassword(password)) {
    const state = recordFailure(address);
    const query = state.locked
      ? `error=locked&retry=${state.retryAfterSeconds}`
      : `error=1&left=${state.attemptsRemaining}`;
    return NextResponse.redirect(new URL(`/admin?${query}`, request.url), { status: 303 });
  }

  recordSuccess(address);
  await setAdminSession();
  return NextResponse.redirect(new URL('/admin', request.url), { status: 303 });
}
