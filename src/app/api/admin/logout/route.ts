import { clearAdminSession } from '@/server/auth';
import { seeOther } from '@/server/redirect';

export const dynamic = 'force-dynamic';

export async function POST() {
  await clearAdminSession();
  return seeOther('/admin');
}
