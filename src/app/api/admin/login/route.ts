import { checkAdminPassword, setAdminSession } from '@/server/auth';
import { checkLockout, clientAddress, recordFailure, recordSuccess } from '@/server/rate-limit';
import { seeOther } from '@/server/redirect';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const address = clientAddress(request);

  const lockout = checkLockout(address);
  if (lockout.locked) {
    return seeOther(`/admin?error=locked&retry=${lockout.retryAfterSeconds}`, {
      'Retry-After': String(lockout.retryAfterSeconds),
    });
  }

  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (!process.env.ADMIN_PASSWORD) {
    return seeOther('/admin?error=unset');
  }

  if (!checkAdminPassword(password)) {
    const state = recordFailure(address);
    const query = state.locked
      ? `error=locked&retry=${state.retryAfterSeconds}`
      : `error=1&left=${state.attemptsRemaining}`;
    return seeOther(`/admin?${query}`);
  }

  recordSuccess(address);
  await setAdminSession();
  return seeOther('/admin');
}
