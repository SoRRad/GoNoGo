import { getDb } from '@/lib/db';
import { InviteTemplateError, resetInviteTemplate, saveInviteTemplate } from '@/lib/invite';
import { refuseUnlessAdminAction, withQuery } from '@/server/admin-guard';
import { sendTestInvitation } from '@/server/invitations';
import { inviteBase } from '@/server/invite-link';
import { MailError } from '@/server/mailer';
import { seeOther } from '@/server/redirect';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Back to the wording, with the message shown there rather than at the top of the page. */
const back = (params: Record<string, string | undefined>) =>
  seeOther(withQuery('/admin', { ...params, from: 'invitation' }) + '#invitation-email');

/**
 * The invitation email's wording. "Save" stores it, "Send me a test" saves and
 * then sends it to the study inbox, so what was tested is what gets sent, and
 * "Reset" goes back to the original draft.
 */
export async function POST(request: Request) {
  const refused = await refuseUnlessAdminAction(request);
  if (refused) return refused;

  const form = await request.formData();
  const intent = String(form.get('intent') ?? 'save');
  const db = getDb();

  if (intent === 'reset') {
    resetInviteTemplate(db);
    console.log('[sadi] admin reset the invitation wording');
    return back({ notice: 'template_reset' });
  }

  try {
    saveInviteTemplate(db, {
      fromName: String(form.get('fromName') ?? ''),
      subject: String(form.get('subject') ?? ''),
      body: String(form.get('body') ?? ''),
    });
  } catch (error) {
    // Nothing is saved, and the page shows what is stored; the problem says why.
    if (error instanceof InviteTemplateError) return back({ problem: error.code });
    throw error;
  }
  console.log('[sadi] admin saved the invitation wording');
  if (intent !== 'test') return back({ notice: 'template_saved' });

  try {
    await sendTestInvitation(db, await inviteBase());
  } catch (error) {
    if (error instanceof MailError) return back({ problem: error.code, saved: '1' });
    throw error;
  }
  console.log('[sadi] admin sent a test invitation');
  return back({ notice: 'test_sent' });
}
