import { getDb } from '@/lib/db';
import { ManageError, pauseSurgeon, removeSurgeon, replaceLink, resumeSurgeon } from '@/lib/manage';
import { refuseUnlessAdminAction, withQuery } from '@/server/admin-guard';
import { InviteRefused, sendInvitation } from '@/server/invitations';
import { inviteBase } from '@/server/invite-link';
import { MailError } from '@/server/mailer';
import { seeOther } from '@/server/redirect';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ACTIONS = ['invite', 'link', 'pause', 'resume', 'remove'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * One surgeon's access: email their invitation, a new link, pause, resume, or remove. Removing deletes
 * their work, so it also needs confirm=remove, which only the confirmation page
 * sends: a stray or replayed post cannot delete anyone by itself.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ surgeonId: string; action: string }> },
) {
  const refused = await refuseUnlessAdminAction(request);
  if (refused) return refused;

  const { surgeonId: rawId, action: rawAction } = await context.params;
  const surgeonId = Number(rawId);
  const action = rawAction as Action;
  if (!Number.isInteger(surgeonId) || !ACTIONS.includes(action)) {
    return seeOther(withQuery('/admin', { problem: 'not_found' }));
  }

  const db = getDb();
  try {
    switch (action) {
      case 'invite': {
        await sendInvitation(db, surgeonId, await inviteBase());
        console.log(`[sadi] admin emailed an invitation to surgeon ${surgeonId}`);
        return seeOther(withQuery('/admin', { notice: 'invited', surgeon: surgeonId }) + '#surgeons');
      }
      case 'link':
        replaceLink(db, surgeonId);
        console.log(`[sadi] admin replaced the link of surgeon ${surgeonId}`);
        return seeOther(withQuery('/admin', { notice: 'link', surgeon: surgeonId }) + '#surgeons');
      case 'pause':
        pauseSurgeon(db, surgeonId);
        console.log(`[sadi] admin paused surgeon ${surgeonId}`);
        return seeOther(withQuery('/admin', { notice: 'paused', surgeon: surgeonId }) + '#surgeons');
      case 'resume':
        resumeSurgeon(db, surgeonId);
        console.log(`[sadi] admin resumed surgeon ${surgeonId}`);
        return seeOther(withQuery('/admin', { notice: 'resumed', surgeon: surgeonId }) + '#surgeons');
      case 'remove': {
        const form = await request.formData();
        if (form.get('confirm') !== 'remove') {
          return seeOther(`/admin/surgeons/${surgeonId}/remove`);
        }
        const impact = removeSurgeon(db, surgeonId);
        console.log(
          `[sadi] admin removed surgeon ${surgeonId} with ${impact.annotations} annotations ` +
            `(${impact.submitted} submitted) and ${impact.maskFiles} mask files`,
        );
        return seeOther(
          withQuery('/admin', { notice: 'removed', name: impact.surgeon.name, submitted: impact.submitted }) +
            '#surgeons',
        );
      }
    }
  } catch (error) {
    if (error instanceof ManageError || error instanceof MailError || error instanceof InviteRefused) {
      return seeOther(withQuery('/admin', { problem: error.code, surgeon: surgeonId }) + '#surgeons');
    }
    throw error;
  }
}
