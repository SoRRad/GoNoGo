import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="viewport-fill grid place-items-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold">Dissection zone study</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Participants: please open the personal link you were emailed. It signs you in and takes you
          straight to where you left off.
        </p>
        <Link href="/admin" className="mt-6 inline-block text-xs text-zinc-600 hover:text-zinc-400">
          Study administration
        </Link>
      </div>
    </main>
  );
}
