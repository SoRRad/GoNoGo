import Link from 'next/link';
import { getDb } from '@/lib/db';
import { median, studyPresenceAgreementBothLayers } from '@/lib/analysis';
import { summariseIntraRaterCached } from '@/lib/intra-rater';
import { isAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface SurgeonRow {
  id: number;
  name: string;
  email: string;
  yearsInPractice: number | null;
  casesPerYear: number | null;
  onboardedAt: string | null;
  assigned: number;
  completed: number;
  lastActive: string | null;
}

interface FrameRow {
  id: number;
  filename: string;
  sourceVideo: string | null;
  isPractice: number;
  raters: number;
}

/** Null means the metric is undefined for this data, not that it is zero. */
function formatMetric(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function LoginScreen({ error }: { error?: string }) {
  return (
    <main className="viewport-fill grid place-items-center px-6">
      <form action="/api/admin/login" method="post" className="w-full max-w-sm">
        <h1 className="text-lg font-semibold">Study administration</h1>
        {error === 'unset' ? (
          <p className="mt-3 rounded-lg border border-amber-900 bg-amber-950/50 p-3 text-sm text-amber-200">
            ADMIN_PASSWORD is not set on the server, so this page cannot be unlocked.
          </p>
        ) : error ? (
          <p className="mt-3 text-sm text-amber-300">That password was not correct.</p>
        ) : null}
        <input
          type="password"
          name="password"
          autoFocus
          required
          placeholder="Admin password"
          className="mt-4 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-3 text-base
                     text-zinc-100 outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-lg bg-white px-4 py-3 font-semibold text-zinc-900"
        >
          Unlock
        </button>
      </form>
    </main>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!(await isAdmin())) return <LoginScreen error={error} />;

  const db = getDb();

  const surgeons = db
    .prepare(
      `SELECT s.id                AS id,
              s.name              AS name,
              s.email             AS email,
              s.years_in_practice AS yearsInPractice,
              s.cases_per_year    AS casesPerYear,
              s.onboarded_at      AS onboardedAt,
              (SELECT COUNT(*) FROM assignments a WHERE a.surgeon_id = s.id) AS assigned,
              (SELECT COUNT(*) FROM annotations an
                WHERE an.surgeon_id = s.id AND an.submitted_at IS NOT NULL)  AS completed,
              (SELECT MAX(an.updated_at) FROM annotations an WHERE an.surgeon_id = s.id) AS lastActive
         FROM surgeons s
        ORDER BY s.id`,
    )
    .all() as SurgeonRow[];

  const secondsBySurgeon = new Map<number, number[]>();
  for (const row of db
    .prepare(
      `SELECT surgeon_id AS surgeonId, seconds_spent AS seconds
         FROM annotations WHERE submitted_at IS NOT NULL`,
    )
    .all() as { surgeonId: number; seconds: number }[]) {
    const bucket = secondsBySurgeon.get(row.surgeonId) ?? [];
    bucket.push(row.seconds);
    secondsBySurgeon.set(row.surgeonId, bucket);
  }

  const frames = db
    .prepare(
      `SELECT f.id           AS id,
              f.filename     AS filename,
              f.source_video AS sourceVideo,
              f.is_practice  AS isPractice,
              (SELECT COUNT(*) FROM annotations an
                WHERE an.frame_id = f.id AND an.submitted_at IS NOT NULL
                  AND an.status IN ('drawn', 'nothing_to_mark')) AS raters
         FROM frames f
        ORDER BY raters DESC, f.id`,
    )
    .all() as FrameRow[];

  const withOpinions = frames.filter((frame) => frame.raters > 0);

  // Decodes four mask PNGs per repeat pair, so it is cached against the
  // annotations table and only recomputed when something has been saved.
  const intraRater = summariseIntraRaterCached(db);
  const presence = studyPresenceAgreementBothLayers(db);
  const totalSubmitted = (
    db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE submitted_at IS NOT NULL').get() as { n: number }
  ).n;

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold">Study administration</h1>
        <div className="ml-auto flex items-center gap-3">
          <a
            href="/api/admin/export"
            className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
          >
            Export everything (.zip)
          </a>
          <form action="/api/admin/logout" method="post">
            <button type="submit" className="text-xs text-zinc-500 hover:text-zinc-300">
              Sign out
            </button>
          </form>
        </div>
      </div>

      <p className="mt-2 text-sm text-zinc-500">
        {totalSubmitted} submitted annotations · {withOpinions.length} frames with at least one opinion ·{' '}
        {frames.length} frames loaded
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Surgeons</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-zinc-900/70 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Surgeon</th>
                <th className="px-4 py-3 font-medium">Experience</th>
                <th className="px-4 py-3 font-medium">Frames completed</th>
                <th className="px-4 py-3 font-medium">Median s / frame</th>
                <th className="px-4 py-3 font-medium">Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {surgeons.map((surgeon) => {
                const medianSeconds = median(secondsBySurgeon.get(surgeon.id) ?? []);
                const percent = surgeon.assigned
                  ? Math.round((surgeon.completed / surgeon.assigned) * 100)
                  : 0;
                return (
                  <tr key={surgeon.id} className="text-zinc-200">
                    <td className="px-4 py-3">
                      <div className="font-medium">{surgeon.name}</div>
                      <div className="text-xs text-zinc-500">{surgeon.email}</div>
                      {!surgeon.onboardedAt && (
                        <div className="mt-1 text-xs text-amber-400">not started</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">
                      {surgeon.yearsInPractice === null
                        ? '—'
                        : `${surgeon.yearsInPractice} y · ${surgeon.casesPerYear}/y`}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
                          <div className="h-full bg-zinc-300" style={{ width: `${percent}%` }} />
                        </div>
                        <span className="tabular-nums">
                          {surgeon.completed} / {surgeon.assigned}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">
                      {medianSeconds === null ? '—' : `${medianSeconds} s`}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{formatWhen(surgeon.lastActive)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Self-agreement on hidden repeats
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Roughly one frame in ten comes back unannounced, at least 30 positions later. How closely a
          surgeon reproduces their own judgement is the ceiling on what agreement between surgeons can
          mean — and a surgeon whose repeats drift apart is changing their criteria mid-study.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-zinc-900/70 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Surgeon</th>
                <th className="px-4 py-3 font-medium">Repeats done</th>
                <th className="px-4 py-3 font-medium" title="Mean IoU between the two attempts, No-Go">
                  No-Go IoU
                </th>
                <th className="px-4 py-3 font-medium" title="Mean IoU between the two attempts, Go">
                  Go IoU
                </th>
                <th className="px-4 py-3 font-medium" title="Same yes/no call on whether a zone exists">
                  Same call
                </th>
                <th className="px-4 py-3 font-medium">Changed status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {intraRater.map((row) => {
                const shaky = row.nogo.meanIou !== null && row.nogo.meanIou < 0.4;
                return (
                  <tr key={row.surgeonId} className="text-zinc-200">
                    <td className="px-4 py-3 font-medium">{row.surgeonName}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{row.pairs}</td>
                    <td className={`px-4 py-3 tabular-nums ${shaky ? 'text-amber-400' : 'text-zinc-100'}`}>
                      {formatMetric(row.nogo.meanIou)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-100">{formatMetric(row.go.meanIou)}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">
                      {formatMetric(row.nogo.presenceAgreement)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-400">
                      {row.statusChanges} of {row.pairs}
                    </td>
                  </tr>
                );
              })}
              {intraRater.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-3 text-zinc-500">
                    No repeat pairs completed yet. They appear once a surgeon reaches the second showing
                    of a frame.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Presence agreement across the study
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Whether the surgeons agree a zone of each class exists at all, separately from where they drew
          it. Chance-corrected over the largest group of frames sharing a rater count.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {([presence.nogo, presence.go] as const).map((summary) => (
            <div key={summary.layer} className="rounded-lg border border-zinc-800 p-4">
              <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: summary.layer === 'go' ? '#22c55e' : '#ef4444' }}
                />
                {summary.layer === 'go' ? 'Go' : 'No-Go'}
              </h3>
              {summary.frames === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">Not enough frames rated by two or more surgeons yet.</p>
              ) : (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Observed agreement</dt>
                    <dd className="tabular-nums text-zinc-100">{formatMetric(summary.observedAgreement)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">
                      {summary.kappaNote === 'cohen' ? "Cohen's kappa" : "Fleiss' kappa"}
                    </dt>
                    <dd className="tabular-nums text-zinc-100">
                      {summary.kappa === null
                        ? summary.kappaNote === 'undefined_unanimous'
                          ? 'undefined (unanimous)'
                          : '—'
                        : summary.kappa.toFixed(3)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Frames / raters</dt>
                    <dd className="tabular-nums text-zinc-300">
                      {summary.frames} / {summary.raters}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Frames with any mark</dt>
                    <dd className="tabular-nums text-zinc-300">{summary.framesWithAnyMark}</dd>
                  </div>
                </dl>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Frames</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Open a frame to see every surgeon&apos;s zones overlaid and their pixel agreement.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {withOpinions.map((frame) => (
            <Link
              key={frame.id}
              href={`/admin/frames/${frame.id}`}
              className="flex items-center justify-between rounded-lg border border-zinc-800 px-4 py-3
                         transition-colors hover:border-zinc-600 hover:bg-zinc-900/60"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-zinc-200">{frame.filename}</span>
                <span className="block text-xs text-zinc-500">
                  frame {frame.id}
                  {frame.sourceVideo ? ` · ${frame.sourceVideo}` : ''}
                  {frame.isPractice ? ' · practice' : ''}
                </span>
              </span>
              <span className="ml-3 shrink-0 rounded-full bg-zinc-800 px-2.5 py-1 text-xs tabular-nums text-zinc-300">
                {frame.raters} {frame.raters === 1 ? 'opinion' : 'opinions'}
              </span>
            </Link>
          ))}
          {withOpinions.length === 0 && (
            <p className="text-sm text-zinc-500">No annotations submitted yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}
