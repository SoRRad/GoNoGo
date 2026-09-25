'use client';

import { useState } from 'react';
import type { InviteTemplate } from '@/lib/invite';

const LIMITS = { fromName: 80, subject: 200, body: 5000 };

/**
 * The invitation wording. Checked here before it is sent, so a long edit is
 * never thrown away by the server refusing it; the server checks again.
 */
export default function InviteTemplateForm({
  initial,
  canSend,
  testAddress,
}: {
  initial: InviteTemplate;
  canSend: boolean;
  testAddress: string | null;
}) {
  const [fromName, setFromName] = useState(initial.fromName);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const missingLink = !body.includes('{link}');

  const field =
    'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500';

  return (
    <form
      action="/api/admin/invitation"
      method="post"
      className="mt-3 space-y-3"
      onSubmit={(event) => {
        if (missingLink) event.preventDefault();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">
          Sender name
          <input
            name="fromName"
            required
            maxLength={LIMITS.fromName}
            value={fromName}
            onChange={(event) => setFromName(event.target.value)}
            className={`mt-1 ${field}`}
          />
        </label>
        <label className="block text-xs text-zinc-400">
          Subject
          <input
            name="subject"
            required
            maxLength={LIMITS.subject}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className={`mt-1 ${field}`}
          />
        </label>
      </div>
      <label className="block text-xs text-zinc-400">
        Message
        <textarea
          name="body"
          required
          rows={16}
          maxLength={LIMITS.body}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className={`mt-1 font-mono leading-relaxed ${field}`}
        />
      </label>
      <p className={`text-xs ${missingLink ? 'text-amber-300' : 'text-zinc-500'}`}>
        {missingLink
          ? 'Put {link} back where the surgeon’s personal link should go. It cannot be saved without it.'
          : 'Where you write {name} and {link}, each email has that surgeon’s name and personal link.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={missingLink}
          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100
                     disabled:bg-zinc-800 disabled:text-zinc-600"
        >
          Save wording
        </button>
        {canSend && testAddress && (
          <button
            type="submit"
            name="intent"
            value="test"
            disabled={missingLink}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500
                       disabled:text-zinc-600"
          >
            Save and send a test to {testAddress}
          </button>
        )}
      </div>
    </form>
  );
}
