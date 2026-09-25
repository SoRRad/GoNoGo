import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { CORE_TARGET } from '@/lib/queue';
import { ManageError, frameImpact } from '@/lib/manage';
import { isAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** States exactly what removing a frame deletes, and sends the confirm=remove the route requires. */
export default async function RemoveFramePage({ params }: { params: Promise<{ frameId: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main className="viewport-fill grid place-items-center px-6">
        <Link href="/admin" className="text-sm text-zinc-400 underline">
          Sign in to study administration
        </Link>
      </main>
    );
  }

  const { frameId: rawId } = await params;
  const frameId = Number(rawId);
  if (!Number.isInteger(frameId)) notFound();

  let impact;
  try {
    impact = frameImpact(getDb(), frameId);
  } catch (error) {
    if (error instanceof ManageError) notFound();
    throw error;
  }
  const { frame } = impact;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const repeats = impact.queued - impact.surgeons;

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <Link href={`/admin/frames/${frame.id}`} className="text-sm text-zinc-500 hover:text-zinc-300">
        ← Back to this image
      </Link>
      <h1 className="mt-4 text-xl font-semibold">Remove this image from the study?</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {frame.filename}
        {frame.source_video ? ` · ${frame.source_video}` : ''}
        {frame.is_practice ? ' · practice image' : ''}
      </p>

      {/* eslint-disable-next-line @next/next/no-img-element -- admin-only, served with auth */}
      <img
        src={`/api/frames/${frame.id}`}
        alt=""
        className="mt-4 max-h-72 w-auto rounded-lg border border-zinc-800"
      />

      <div className="mt-6 rounded-lg border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-100">
        <p className="font-medium">Removing permanently:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-red-200/90">
          <li>
            takes it out of {plural(impact.surgeons, 'surgeon’s list', 'surgeons’ lists')}
            {repeats > 0 && `, including ${plural(repeats, 'hidden repeat', 'hidden repeats')}`}
          </li>
          <li>
            deletes {plural(impact.submitted, 'submitted drawing', 'submitted drawings')} made on it
            {impact.annotations > impact.submitted &&
              ` and ${plural(impact.annotations - impact.submitted, 'unfinished one', 'unfinished ones')}`}
          </li>
          <li>deletes the image file from the server</li>
        </ul>
        {frame.is_core === 1 && (
          <p className="mt-3 text-red-200/80">
            This is one of the images every surgeon sees. The shared set becomes one smaller, for everyone
            including surgeons added later (normally {CORE_TARGET}).
          </p>
        )}
        <p className="mt-3 text-red-200/80">
          Everyone&apos;s other work is untouched, and each list closes up so nobody skips an image. This
          cannot be undone, except by restoring a backup.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <form action={`/api/admin/frames/${frame.id}/remove`} method="post">
          <input type="hidden" name="confirm" value="remove" />
          <button
            type="submit"
            className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500"
          >
            Remove image permanently
          </button>
        </form>
        <Link href={`/admin/frames/${frame.id}`} className="px-2 text-sm text-zinc-400 hover:text-zinc-200">
          Cancel
        </Link>
      </div>
    </main>
  );
}
