import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { ManageError, surgeonImpact } from '@/lib/manage';
import { isAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

/**
 * The only way to remove a surgeon: this page states exactly what goes, offers
 * pausing as the reversible alternative, and sends the confirm=remove the
 * action route insists on.
 */
export default async function RemoveSurgeonPage({ params }: { params: Promise<{ surgeonId: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main className="viewport-fill grid place-items-center px-6">
        <Link href="/admin" className="text-sm text-zinc-400 underline">
          Sign in to study administration
        </Link>
      </main>
    );
  }

  const { surgeonId: rawId } = await params;
  const surgeonId = Number(rawId);
  if (!Number.isInteger(surgeonId)) notFound();

  let impact;
  try {
    impact = surgeonImpact(getDb(), surgeonId);
  } catch (error) {
    if (error instanceof ManageError) notFound();
    throw error;
  }
  const { surgeon } = impact;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <main className="mx-auto max-w-xl px-5 py-10">
      <Link href="/admin#surgeons" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← Back to study administration
      </Link>
      <h1 className="mt-4 text-xl font-semibold">Remove {surgeon.name}?</h1>
      <p className="mt-1 text-sm text-zinc-500">{surgeon.email}</p>

      <div className="mt-6 rounded-lg border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-100">
        <p className="font-medium">Removing permanently deletes:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-red-200/90">
          <li>their list of {plural(impact.queued, 'image', 'images')}</li>
          <li>
            {plural(impact.submitted, 'submitted drawing', 'submitted drawings')}
            {impact.annotations > impact.submitted &&
              ` and ${plural(impact.annotations - impact.submitted, 'unfinished one', 'unfinished ones')}`}
          </li>
          <li>their personal link, which stops working immediately</li>
        </ul>
        <p className="mt-3 text-red-200/80">
          This cannot be undone, except by restoring a backup. Their images become free for surgeons added
          later.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <form action={`/api/admin/surgeons/${surgeon.id}/remove`} method="post">
          <input type="hidden" name="confirm" value="remove" />
          <button
            type="submit"
            className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500"
          >
            Remove permanently
          </button>
        </form>
        {!surgeon.paused_at && impact.submitted > 0 && (
          <form action={`/api/admin/surgeons/${surgeon.id}/pause`} method="post">
            <button
              type="submit"
              className="rounded-lg border border-zinc-600 px-4 py-2.5 text-sm text-zinc-100 hover:border-zinc-400"
            >
              Pause instead — keep their drawings
            </button>
          </form>
        )}
        <Link href="/admin#surgeons" className="px-2 text-sm text-zinc-400 hover:text-zinc-200">
          Cancel
        </Link>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-zinc-500">
        Pausing switches their link off but keeps everything they have drawn in the study and the export,
        for a surgeon who stops partway. Removing is for people who should not be in the data at all, such
        as pilot testers.
      </p>
    </main>
  );
}
