import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import type { Frame } from '@/lib/db';
import { frameAgreement } from '@/lib/analysis';
import { isAdmin } from '@/server/auth';
import AdminOverlay from '@/components/AdminOverlay';
import type { AgreementSummary } from '@/lib/masks';

export const dynamic = 'force-dynamic';

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function AgreementCard({ title, colour, summary }: { title: string; colour: string; summary: AgreementSummary }) {
  return (
    <div className="rounded-lg border border-zinc-800 p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
        {title}
      </h3>
      {summary.n < 2 ? (
        <p className="mt-3 text-sm text-zinc-500">
          {summary.n === 0 ? 'No opinions yet.' : 'Only one opinion — agreement needs at least two.'}
        </p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Pixel agreement</dt>
            <dd className="tabular-nums text-zinc-100">{percent(summary.meanPixelAgreement)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Overlap (mean IoU)</dt>
            <dd className="tabular-nums text-zinc-100">{percent(summary.meanIou)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Majority-vote area</dt>
            <dd className="tabular-nums text-zinc-300">{summary.consensusPixels.toLocaleString()} px</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Surgeons</dt>
            <dd className="tabular-nums text-zinc-300">{summary.n}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

export default async function AdminFramePage({ params }: { params: Promise<{ frameId: string }> }) {
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

  const frame = getDb().prepare('SELECT * FROM frames WHERE id = ?').get(frameId) as Frame | undefined;
  if (!frame) notFound();

  // Reads and compares every mask for this frame; done per frame, on demand.
  const agreement = frameAgreement(getDb(), frame.id, frame.width, frame.height);

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <Link href="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← All frames
      </Link>

      <h1 className="mt-3 text-xl font-semibold">{frame.filename}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        frame {frame.id} · {frame.width} × {frame.height}
        {frame.source_video ? ` · ${frame.source_video}` : ''}
        {frame.is_practice ? ' · practice frame' : ''}
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <AdminOverlay
          frameId={frame.id}
          width={frame.width}
          height={frame.height}
          raters={agreement.raters}
        />

        <div className="space-y-4">
          <AgreementCard title="No-Go" colour="#ef4444" summary={agreement.nogo} />
          <AgreementCard title="Go" colour="#22c55e" summary={agreement.go} />

          <div className="rounded-lg border border-zinc-800 p-4">
            <h3 className="text-sm font-medium text-zinc-200">Per surgeon</h3>
            <table className="mt-3 w-full text-xs">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Surgeon</th>
                  <th className="pb-2 text-right font-medium">Go px</th>
                  <th className="pb-2 text-right font-medium">No-Go px</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {agreement.raters.map((rater) => (
                  <tr key={rater.surgeonId} className="text-zinc-300">
                    <td className="py-2 pr-2">
                      {rater.surgeonName}
                      {rater.status === 'nothing_to_mark' && (
                        <span className="ml-1 text-zinc-600">· nothing to mark</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{rater.goPixels.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{rater.nogoPixels.toLocaleString()}</td>
                  </tr>
                ))}
                {agreement.raters.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-2 text-zinc-500">
                      No submitted opinions yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
              Pixel agreement is the mean, over every pair of surgeons, of the share of the frame they
              classify the same way. IoU is the mean pairwise intersection over union of the marked
              regions, which ignores the shared background. A surgeon who marked nothing counts as a
              rater voting zero; &quot;can&apos;t tell&quot; is excluded.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
