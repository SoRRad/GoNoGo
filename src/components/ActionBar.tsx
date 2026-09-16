'use client';

import type { Confidence } from '@/lib/types';

interface Props {
  confidence: Confidence | null;
  canAdvance: boolean;
  busy: boolean;
  canGoBack: boolean;
  onConfidenceChange: (confidence: Confidence) => void;
  onNext: () => void;
  onBack: () => void;
  onNothingToMark: () => void;
  onCannotAssess: () => void;
}

const CONFIDENCE_OPTIONS: [Confidence, string][] = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];

export default function ActionBar({
  confidence,
  canAdvance,
  busy,
  canGoBack,
  onConfidenceChange,
  onNext,
  onBack,
  onNothingToMark,
  onCannotAssess,
}: Props) {
  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={!canGoBack || busy}
          title="Go back one frame to fix a misclick"
          className="rounded-lg px-3 py-3 text-sm text-zinc-500 hover:text-zinc-300 disabled:opacity-25"
        >
          ← Back
        </button>

        <div className="flex items-center gap-2" role="group" aria-label="Confidence">
          <span className="hidden text-xs uppercase tracking-wide text-zinc-500 sm:inline">Confidence</span>
          {CONFIDENCE_OPTIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onConfidenceChange(value)}
              aria-pressed={confidence === value}
              className={`min-w-[84px] rounded-lg px-4 py-3 text-sm font-medium transition-colors ${
                confidence === value
                  ? 'bg-zinc-200 text-zinc-900'
                  : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onNext}
          disabled={!canAdvance || busy}
          className="ml-auto min-w-[140px] rounded-lg bg-white px-6 py-3 text-base font-semibold text-zinc-900
                     transition-opacity hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-800
                     disabled:text-zinc-600"
        >
          {busy ? 'Saving…' : 'Next →'}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onNothingToMark}
          disabled={busy}
          className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900
                     disabled:opacity-40"
        >
          Nothing to mark here
        </button>
        <button
          type="button"
          onClick={onCannotAssess}
          disabled={busy}
          className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900
                     disabled:opacity-40"
        >
          Can&apos;t tell
        </button>
      </div>
    </div>
  );
}
