import Link from 'next/link';
import { getDb } from '@/lib/db';
import { CORE_TARGET, INDIVIDUAL_TARGET } from '@/lib/queue';
import { isAdmin } from '@/server/auth';
import ImageUploader from '@/components/ImageUploader';

export const dynamic = 'force-dynamic';

interface ImageRow {
  id: number;
  filename: string;
  sourceVideo: string | null;
  isPractice: number;
  isCore: number;
  surgeons: number;
  submitted: number;
}

/**
 * Every loaded image, grouped by the operation it came from. Groups start
 * closed, so no thumbnail is fetched until its operation is opened.
 */
export default async function ImagesPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; problem?: string; file?: string; surgeons?: string; submitted?: string }>;
}) {
  if (!(await isAdmin())) {
    return (
      <main className="viewport-fill grid place-items-center px-6">
        <Link href="/admin" className="text-sm text-zinc-400 underline">
          Sign in to study administration
        </Link>
      </main>
    );
  }
  const params = await searchParams;

  const rows = getDb()
    .prepare(
      `SELECT f.id AS id, f.filename AS filename, f.source_video AS sourceVideo,
              f.is_practice AS isPractice, f.is_core AS isCore,
              (SELECT COUNT(DISTINCT a.surgeon_id) FROM assignments a WHERE a.frame_id = f.id) AS surgeons,
              (SELECT COUNT(*) FROM annotations an
                WHERE an.frame_id = f.id AND an.submitted_at IS NOT NULL) AS submitted
         FROM frames f
        ORDER BY f.id`,
    )
    .all() as ImageRow[];

  const groups = new Map<string, ImageRow[]>();
  for (const row of rows) {
    const key = row.isPractice ? 'Practice' : row.sourceVideo ?? 'No operation recorded';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === 'Practice' ? -1 : b === 'Practice' ? 1 : a.localeCompare(b, undefined, { numeric: true }),
  );

  const study = rows.filter((row) => !row.isPractice);
  const unused = study.filter((row) => row.surgeons === 0 && !row.isCore).length;
  // As on the admin page: until the first list is built, the core set is still to come out of the pool.
  const spare = study.some((row) => row.isCore) ? unused : Math.max(0, study.length - CORE_TARGET);
  const room = Math.floor(spare / INDIVIDUAL_TARGET);

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <Link href="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← Study administration
      </Link>
      <h1 className="mt-3 text-xl font-semibold">Images</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {rows.length - study.length} practice · {study.length} study ·{' '}
        {study.filter((row) => row.isCore).length} seen by every surgeon · {unused} not yet in anyone&apos;s
        list
      </p>

      {params.notice === 'image_removed' && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-200"
        >
          {params.file ?? 'The image'} was removed from {params.surgeons ?? 0}{' '}
          {params.surgeons === '1' ? 'surgeon’s list' : 'surgeons’ lists'}, with{' '}
          {params.submitted ?? 0} submitted drawings.
        </p>
      )}
      {params.problem === 'not_found' && (
        <p className="mt-4 rounded-lg border border-amber-900 bg-amber-950/50 p-3 text-sm text-amber-200">
          That image no longer exists. The list below is up to date.
        </p>
      )}

      <section className="mt-6 rounded-lg border border-zinc-800 p-4">
        <h2 className="text-sm font-medium text-zinc-200">Add images</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Choose a folder with one sub-folder per operation, like the one the study was loaded from, or a single
          operation&apos;s folder. New images go into the spare pool for surgeons you add from now on; nobody&apos;s
          current list changes. Images already in the study are recognised and skipped, even if renamed. Folder
          and file names are kept in the study records and the export, so they must not contain patient details.
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          {spare} spare {spare === 1 ? 'image' : 'images'} now: enough for {room} more{' '}
          {room === 1 ? 'surgeon' : 'surgeons'}, who need {INDIVIDUAL_TARGET} each.
        </p>
        <div className="mt-3">
          <ImageUploader />
        </div>
      </section>

      <p className="mt-6 text-xs text-zinc-500">
        Open an operation to see its images. Select one to view it, and to remove it from the study.
      </p>
      <div className="mt-3 space-y-2">
        {ordered.map(([name, images]) => (
          <details key={name} className="group rounded-lg border border-zinc-800">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 hover:bg-zinc-900/60">
              <span className="text-sm font-medium text-zinc-200">{name}</span>
              <span className="text-xs tabular-nums text-zinc-500">
                {images.length} {images.length === 1 ? 'image' : 'images'}
                <span className="ml-2 inline-block transition-transform group-open:rotate-90">›</span>
              </span>
            </summary>
            <div className="grid gap-3 border-t border-zinc-800 p-3 sm:grid-cols-3 lg:grid-cols-5">
              {images.map((image) => (
                <Link
                  key={image.id}
                  href={`/admin/frames/${image.id}`}
                  className="block rounded-md border border-zinc-800 p-1.5 hover:border-zinc-500"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- admin-only, served with auth */}
                  <img
                    src={`/api/frames/${image.id}`}
                    alt=""
                    loading="lazy"
                    className="aspect-video w-full rounded object-cover"
                  />
                  <span className="mt-1.5 block truncate text-[11px] text-zinc-300">{image.filename}</span>
                  <span className="block text-[11px] text-zinc-500">
                    {image.isCore ? 'every surgeon · ' : ''}
                    {image.surgeons} {image.surgeons === 1 ? 'list' : 'lists'} · {image.submitted} drawn
                  </span>
                </Link>
              ))}
            </div>
          </details>
        ))}
        {rows.length === 0 && <p className="text-sm text-zinc-500">No images are loaded yet.</p>}
      </div>
    </main>
  );
}
