'use client';

import { useState } from 'react';

/**
 * Copies a surgeon's link without showing it, so it does not end up in a
 * screenshot or over a shoulder. If the browser refuses the clipboard, the link
 * is revealed, selected, for copying by hand.
 */
export default function CopyLinkButton({ link, label = 'Copy link' }: { link: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setState('copied');
      setTimeout(() => setState('idle'), 2500);
    } catch {
      setState('manual');
    }
  }

  if (state === 'manual') {
    return (
      <input
        readOnly
        autoFocus
        value={link}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="Invite link, selected for copying"
        className="w-64 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
    >
      {state === 'copied' ? 'Copied ✓' : label}
    </button>
  );
}
