import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import type { Frame } from '@/lib/db';
import { frameAgreement } from '@/lib/analysis';
import { isAdmin } from '@/server/auth';
import AdminOverlay from '@/components/AdminOverlay';
import type { LayerAgreement } from '@/lib/analysis';

export const dynamic = 'force-dynamic';

function percent(value: number | null): string {
  // Null is a real answer here: the metric is undefined, not zero.
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500" title={hint}>
        {label}
      </dt>
      <dd className="tabular-nums text-zinc-100">{value}</dd>
    </div>
  );
}

function AgreementCard({ title, colour, summary }: { title: string; colour: string; summary: LayerAgreement }) {
  const { presence } = summary;
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
        <>
          <p className="mt-3 text-[11px] uppercase tracking-wide text-zinc-600">Presence</p>
          <dl className="mt-1.5 space-y-2 text-sm">
            <Row
              label="Marked a zone"
              value={`${presence.positive} of ${presence.n}`}
              hint="How many surgeons marked any pixel of this class at all."
            />
            <Row
              label="Agreed it exists"
              value={percent(presence.observedAgreement)}
              hint="Share of surgeon pairs making the same yes/no call on this frame."
            />
          </dl>

          <p className="mt-4 text-[11px] uppercase tracking-wide text-zinc-600">Shape</p>
          {summary.spatialPairs === 0 ? (
            <p className="mt-1.5 text-sm text-zinc-500">
              Nobody drew this class, so there is no shape to compare.
            </p>
          ) : (
            <dl className="mt-1.5 space-y-2 text-sm">
              <Row label="Overlap (IoU)" value={percent(summary.meanIou)} hint="Mean pairwise intersection over union." />
              <Row label="Overlap (Dice)" value={percent(summary.meanDice)} hint="Mean pairwise Dice / F1." />
              <Row
                label="Boundary (NSD)"
                value={percent(summary.boundary.meanNsd)}
                hint={`Share of each contour within ${summary.boundary.tolerancePixels.toFixed(1)} px of the other.`}
              />
              <Row
                label="Pixel agreement"
                value={percent(summary.meanPixelAgreement)}
                hint="Whole-image, so background inflates it on a sparse frame."
              />
            </dl>
          )}

          <dl className="mt-4 space-y-2 border-t border-zinc-800 pt-3 text-sm">
            <Row label="Majority-vote area" value={`${summary.consensusPixels.toLocaleString()} px`} />
            <Row
              label="Pairs compared"
              value={
                summary.excludedEmptyPairs > 0
                  ? `${summary.spatialPairs} (+${summary.excludedEmptyPairs} both empty)`
                  : String(summary.spatialPairs)
              }
              hint="Pairs where neither surgeon drew anything are excluded: overlap is undefined, not perfect."
            />
          </dl>
        </>
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/admin" className="text-zinc-500 hover:text-zinc-300">
          ← Study administration
        </Link>
        <Link href="/admin/images" className="text-zinc-500 hover:text-zinc-300">
          All images
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{frame.filename}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            frame {frame.id} · {frame.width} × {frame.height}
            {frame.source_video ? ` · ${frame.source_video}` : ''}
            {frame.is_practice ? ' · practice frame' : ''}
            {frame.is_core ? ' · seen by every surgeon' : ''}
          </p>
        </div>
        <Link
          href={`/admin/frames/${frame.id}/remove`}
          className="rounded-lg border border-red-900/80 px-3 py-2 text-sm text-red-300 hover:border-red-700 hover:text-red-200"
        >
          Remove this image…
        </Link>
      </div>

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
