import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import type { Frame } from '@/lib/db';
import { getSessionSurgeon } from '@/server/auth';
import ExampleFigure from '@/components/ExampleFigure';
import WelcomeForm from '@/components/WelcomeForm';

export const dynamic = 'force-dynamic';

const INSTRUCTIONS = [
  'These are still frames from robotic duodenal switch operations.',
  'On each frame, mark where you would be willing to dissect (Go, green) and where you would not (No-Go, red).',
  'Drag a rough loop with the lasso and it closes itself, or paint with the brush. Rough is fine — this is about zones, not outlines.',
  'Go and No-Go are independent. Leave either one empty, or let them overlap, exactly as your judgement requires.',
  'If there is nothing worth marking, or the view does not let you judge, use the two buttons under the frame.',
  'Set your confidence, then Next. There is no answer key and no scoring — your own judgement is the data.',
];

export default async function WelcomePage() {
  const surgeon = await getSessionSurgeon();
  if (!surgeon) {
    return (
      <main className="viewport-fill grid place-items-center px-6 text-center">
        <p className="max-w-sm text-sm text-zinc-400">
          Please open the personal link you were emailed.
        </p>
      </main>
    );
  }
  if (surgeon.onboarded_at) redirect('/annotate');

  const practiceFrame = getDb()
    .prepare('SELECT * FROM frames WHERE is_practice = 1 ORDER BY filename LIMIT 1')
    .get() as Frame | undefined;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome, {surgeon.name}.</h1>
      <p className="mt-2 text-sm text-zinc-400">Six lines, one example, two questions. Then you are drawing.</p>

      <ol className="mt-8 space-y-3">
        {INSTRUCTIONS.map((line, position) => (
          <li key={line} className="flex gap-3 text-[15px] leading-relaxed text-zinc-200">
            <span className="mt-0.5 w-5 shrink-0 text-right text-sm tabular-nums text-zinc-600">
              {position + 1}
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ol>

      <figure className="mt-8">
        <ExampleFigure
          frameUrl={practiceFrame ? `/api/frames/${practiceFrame.id}` : null}
          width={practiceFrame?.width ?? 960}
          height={practiceFrame?.height ?? 540}
        />
        <figcaption className="mt-2 text-xs text-zinc-500">
          A worked example. Green marks a zone this surgeon would dissect; red marks one they would not.
          Regions are drawn at the same transparency you will see, so the tissue stays visible underneath.
        </figcaption>
      </figure>

      <WelcomeForm />
    </main>
  );
}
