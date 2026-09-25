import { getDb } from '@/lib/db';
import { ManageError, removeFrame } from '@/lib/manage';
import { refuseUnlessAdminAction, withQuery } from '@/server/admin-guard';
import { seeOther } from '@/server/redirect';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Removes a frame from the study. Needs confirm=remove, sent only by the confirmation page. */
export async function POST(request: Request, context: { params: Promise<{ frameId: string }> }) {
  const refused = await refuseUnlessAdminAction(request);
  if (refused) return refused;

  const { frameId: rawId } = await context.params;
  const frameId = Number(rawId);
  if (!Number.isInteger(frameId)) return seeOther(withQuery('/admin/images', { problem: 'not_found' }));

  const form = await request.formData();
  if (form.get('confirm') !== 'remove') return seeOther(`/admin/frames/${frameId}/remove`);

  try {
    const impact = removeFrame(getDb(), frameId);
    console.log(
      `[sadi] admin removed frame ${frameId} from ${impact.surgeons} queue(s), with ` +
        `${impact.annotations} annotations (${impact.submitted} submitted)`,
    );
    return seeOther(
      withQuery('/admin/images', {
        notice: 'image_removed',
        file: impact.frame.filename,
        surgeons: impact.surgeons,
        submitted: impact.submitted,
      }),
    );
  } catch (error) {
    if (error instanceof ManageError) return seeOther(withQuery('/admin/images', { problem: error.code }));
    throw error;
  }
}
