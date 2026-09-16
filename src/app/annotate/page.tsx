import { redirect } from 'next/navigation';
import { getSessionSurgeon } from '@/server/auth';
import { buildWindow } from '@/server/queue-access';
import Annotator from '@/components/Annotator';

export const dynamic = 'force-dynamic';

export default async function AnnotatePage() {
  const surgeon = await getSessionSurgeon();
  if (!surgeon) {
    return (
      <main className="viewport-fill grid place-items-center px-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-lg font-semibold">Please use your personal link</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Open the link you were emailed to continue where you left off.
          </p>
        </div>
      </main>
    );
  }

  if (!surgeon.onboarded_at) redirect('/welcome');

  // Rendered on the server so the first frame is on screen without a round trip.
  return <Annotator initial={buildWindow(surgeon.id)} />;
}
