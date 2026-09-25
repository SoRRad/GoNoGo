import { getDb } from '@/lib/db';
import { ManageError, addSurgeon } from '@/lib/manage';
import { refuseUnlessAdminAction, withQuery } from '@/server/admin-guard';
import { seeOther } from '@/server/redirect';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Adds a surgeon from the admin panel and builds their queue in the same step. */
export async function POST(request: Request) {
  const refused = await refuseUnlessAdminAction(request);
  if (refused) return refused;

  const form = await request.formData();
  const name = String(form.get('name') ?? '');
  const email = String(form.get('email') ?? '');

  try {
    const { surgeon } = addSurgeon(getDb(), { name, email });
    console.log(`[sadi] admin added surgeon ${surgeon.id}`);
    return seeOther(withQuery('/admin', { notice: 'added', surgeon: surgeon.id }) + '#surgeons');
  } catch (error) {
    if (error instanceof ManageError) {
      return seeOther(
        withQuery('/admin', {
          problem: error.code,
          available: error.detail.available,
          formName: name,
          formEmail: email,
        }) + '#add-surgeon',
      );
    }
    throw error;
  }
}
