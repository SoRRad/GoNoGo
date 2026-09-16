'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Asked once, before the practice frames, and never again. */
export default function WelcomeForm() {
  const router = useRouter();
  const [years, setYears] = useState('');
  const [cases, setCases] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('yearsInPractice', years);
      form.set('casesPerYear', cases);
      const response = await fetch('/api/onboarding', { method: 'POST', body: form });
      if (!response.ok) throw new Error(String(response.status));
      router.push('/annotate');
    } catch {
      setError('Could not save that. Please try again.');
      setBusy(false);
    }
  };

  const ready = years !== '' && cases !== '';

  return (
    <form onSubmit={submit} className="mt-8 border-t border-zinc-800 pt-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="block text-sm text-zinc-300">Years in independent practice</span>
          <input
            type="number"
            min={0}
            max={70}
            inputMode="numeric"
            required
            value={years}
            onChange={(event) => setYears(event.target.value)}
            className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-3 text-base
                       text-zinc-100 outline-none focus:border-zinc-500"
          />
        </label>
        <label className="block">
          <span className="block text-sm text-zinc-300">Duodenal switch cases per year, approximately</span>
          <input
            type="number"
            min={0}
            max={2000}
            inputMode="numeric"
            required
            value={cases}
            onChange={(event) => setCases(event.target.value)}
            className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-3 text-base
                       text-zinc-100 outline-none focus:border-zinc-500"
          />
        </label>
      </div>

      {error && <p className="mt-4 text-sm text-amber-300">{error}</p>}

      <button
        type="submit"
        disabled={!ready || busy}
        className="mt-6 w-full rounded-lg bg-white px-6 py-4 text-base font-semibold text-zinc-900
                   disabled:bg-zinc-800 disabled:text-zinc-600 sm:w-auto"
      >
        {busy ? 'Starting…' : 'Start with 5 practice frames'}
      </button>
    </form>
  );
}
