import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INVITE,
  InviteTemplateError,
  getInviteTemplate,
  normaliseInviteTemplate,
  renderInvite,
  resetInviteTemplate,
  saveInviteTemplate,
} from '@/lib/invite';
import { ManageError, pauseSurgeon } from '@/lib/manage';
import { InviteRefused, sendInvitation, sendTestInvitation } from '@/server/invitations';
import { MailError, classifyMailError, mailSettings } from '@/server/mailer';
import type { MailEnv } from '@/server/mailer';
import { addSurgeon, testDb } from './helpers';

interface SinkMessage {
  from: string;
  to: string[];
  headers: Record<string, string>;
  body: string;
}
interface Sink {
  port: number;
  messages: SinkMessage[];
  logins: { user: string; pass: string }[];
  close: () => Promise<void>;
}
const { startSmtpSink } = createRequire(import.meta.url)('../scripts/smoke/smtp-sink.cjs') as {
  startSmtpSink: (options?: { rejectAuth?: boolean }) => Promise<Sink>;
};

const BASE = 'https://gonogo.example.org';

function envFor(sink: Sink, extra: Record<string, string> = {}): MailEnv {
  return {
    SMTP_USER: 'lab@example.org',
    // As Google displays it, spaces and all.
    SMTP_PASSWORD: 'abcd efgh ijkl mnop',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(sink.port),
    SMTP_SECURE: 'false',
    SMTP_INSECURE_FOR_TESTING: 'true',
    ...extra,
  };
}

describe('the invitation wording', () => {
  it('starts from the draft, which carries the link', () => {
    const db = testDb();
    expect(getInviteTemplate(db)).toEqual(DEFAULT_INVITE);
    expect(DEFAULT_INVITE.body).toContain('{link}');
    expect(DEFAULT_INVITE.body).toContain('{name}');
  });

  it('saves, reads back, and resets', () => {
    const db = testDb();
    saveInviteTemplate(db, { fromName: 'Study team', subject: 'Hello {name}', body: 'Hi {name}\n{link}' });
    expect(getInviteTemplate(db)).toEqual({ fromName: 'Study team', subject: 'Hello {name}', body: 'Hi {name}\n{link}' });
    resetInviteTemplate(db);
    expect(getInviteTemplate(db)).toEqual(DEFAULT_INVITE);
  });

  it('tidies what a browser submits', () => {
    const tidy = normaliseInviteTemplate({
      fromName: '  A-STAR\r\nLab ',
      subject: 'Line one\r\nBcc: someone@else.org',
      body: 'Dear {name},   \r\n\r\n{link}\r\n',
    });
    expect(tidy.fromName).toBe('A-STAR Lab');
    // A line break in a header would let the subject add headers of its own.
    expect(tidy.subject).toBe('Line one Bcc: someone@else.org');
    expect(tidy.body).toBe('Dear {name},\n\n{link}');
  });

  it('refuses a message with no link, and empty fields, without saving anything', () => {
    const db = testDb();
    expect(() => saveInviteTemplate(db, { fromName: 'Lab', subject: 'Hi', body: 'No link here' })).toThrow(
      expect.objectContaining({ code: 'template_needs_link' }),
    );
    expect(() => saveInviteTemplate(db, { fromName: ' ', subject: 'Hi', body: '{link}' })).toThrow(InviteTemplateError);
    expect(() => saveInviteTemplate(db, { fromName: 'Lab', subject: 'Hi', body: 'x'.repeat(5001) + '{link}' })).toThrow(
      expect.objectContaining({ code: 'template_invalid' }),
    );
    expect(getInviteTemplate(db)).toEqual(DEFAULT_INVITE);
  });

  it('fills in every placeholder, in one pass', () => {
    const out = renderInvite(
      { fromName: 'Lab', subject: 'For {name}', body: '{name}: {link}\nAgain: {link}' },
      { name: 'Dr {link} Smith', link: 'https://x/a/tok' },
    );
    expect(out.subject).toBe('For Dr {link} Smith');
    expect(out.text).toBe('Dr {link} Smith: https://x/a/tok\nAgain: https://x/a/tok');
  });
});

describe('mail settings', () => {
  it('are off until both the account and the password are set', () => {
    expect(mailSettings({})).toBeNull();
    expect(mailSettings({ SMTP_USER: 'lab@gmail.com' })).toBeNull();
    expect(mailSettings({ SMTP_PASSWORD: 'x' })).toBeNull();
  });

  it('default to Gmail over TLS, with the copy going to the sending inbox', () => {
    expect(mailSettings({ SMTP_USER: ' lab@gmail.com ', SMTP_PASSWORD: 'abcd efgh ijkl mnop' })).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      requireTls: false,
      user: 'lab@gmail.com',
      password: 'abcdefghijklmnop',
      from: 'lab@gmail.com',
      bcc: 'lab@gmail.com',
    });
  });

  it('require STARTTLS on a plain port, and can turn the copy off', () => {
    const settings = mailSettings({ SMTP_USER: 'a@b.org', SMTP_PASSWORD: 'p', SMTP_PORT: '587', INVITE_BCC: 'none' });
    expect(settings).toMatchObject({ port: 587, secure: false, requireTls: true, bcc: null });
    expect(mailSettings({ SMTP_USER: 'a@b.org', SMTP_PASSWORD: 'p', INVITE_BCC: 'records@b.org' })?.bcc).toBe(
      'records@b.org',
    );
  });

  it('turn what the server said into a plain answer', () => {
    expect(classifyMailError({ code: 'EAUTH', responseCode: 535 })).toBe('mail_auth');
    expect(classifyMailError({ code: 'EENVELOPE', responseCode: 553 })).toBe('mail_rejected');
    expect(classifyMailError({ code: 'ETIMEDOUT' })).toBe('mail_unreachable');
    expect(classifyMailError({ code: 'ECONNREFUSED' })).toBe('mail_unreachable');
    expect(classifyMailError(new Error('what'))).toBe('mail_failed');
    expect(classifyMailError(undefined)).toBe('mail_failed');
  });
});

describe('sending an invitation', () => {
  let sink: Sink;
  beforeEach(async () => {
    sink = await startSmtpSink();
  });
  afterEach(async () => {
    await sink.close();
  });

  it('emails the surgeon their own link, with a hidden copy to the study inbox', async () => {
    const db = testDb();
    const id = addSurgeon(db, 'Dr Zoë Smith');
    const token = (db.prepare('SELECT access_token AS t FROM surgeons WHERE id = ?').get(id) as { t: string }).t;

    const { surgeon, bcc } = await sendInvitation(db, id, BASE, envFor(sink));

    expect(bcc).toBe('lab@example.org');
    expect(sink.logins).toEqual([{ user: 'lab@example.org', pass: 'abcdefghijklmnop' }]);
    expect(sink.messages).toHaveLength(1);
    const [message] = sink.messages;
    expect(message.from).toBe('lab@example.org');
    expect(message.to.sort()).toEqual([surgeon.email, 'lab@example.org'].sort());
    // A Bcc is in the envelope only, never in the message the surgeon sees.
    expect(message.headers.bcc).toBeUndefined();
    expect(message.headers.to).toBe(surgeon.email);
    expect(message.headers.from).toBe('"A-STAR Lab" <lab@example.org>');
    expect(message.headers.subject).toBe(DEFAULT_INVITE.subject);
    expect(message.body).toContain('Dear Dr Zoë Smith,');
    expect(message.body).toContain(`${BASE}/a/${token}`);
    expect(message.body).not.toContain('{link}');

    const stored = db.prepare('SELECT invited_at AS at FROM surgeons WHERE id = ?').get(id) as { at: string };
    expect(stored.at).toBe(surgeon.invited_at);
  });

  it('uses the saved wording', async () => {
    const db = testDb();
    const id = addSurgeon(db, 'Dr Jones');
    saveInviteTemplate(db, { fromName: 'SADI study', subject: 'Welcome, {name}', body: 'Start here: {link}' });
    const { surgeon } = await sendInvitation(db, id, BASE, envFor(sink));
    expect(sink.messages[0].headers.from).toBe('SADI study <lab@example.org>');
    expect(sink.messages[0].headers.subject).toBe('Welcome, Dr Jones');
    expect(sink.messages[0].body.trim()).toBe(`Start here: ${BASE}/a/${surgeon.access_token}`);
  });

  it('sends one email for a double click', async () => {
    const db = testDb();
    const id = addSurgeon(db, 'Dr Quick');
    const results = await Promise.allSettled([
      sendInvitation(db, id, BASE, envFor(sink)),
      sendInvitation(db, id, BASE, envFor(sink)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(InviteRefused);
    expect(refused.reason.code).toBe('just_sent');
    expect(sink.messages).toHaveLength(1);
  });

  it('allows sending again after a minute', async () => {
    const db = testDb();
    const id = addSurgeon(db, 'Dr Again');
    db.prepare('UPDATE surgeons SET invited_at = ? WHERE id = ?').run(
      new Date(Date.now() - 61_000).toISOString(),
      id,
    );
    await sendInvitation(db, id, BASE, envFor(sink));
    expect(sink.messages).toHaveLength(1);
  });

  it('does not email a paused surgeon, or one that does not exist', async () => {
    const db = testDb();
    const id = addSurgeon(db, 'Dr Paused');
    pauseSurgeon(db, id);
    await expect(sendInvitation(db, id, BASE, envFor(sink))).rejects.toMatchObject({ code: 'paused' });
    await expect(sendInvitation(db, 9999, BASE, envFor(sink))).rejects.toBeInstanceOf(ManageError);
    expect(sink.messages).toHaveLength(0);
  });

  it('says so when email is not set up', async () => {
    const db = testDb();
    const id = addSurgeon(db, 'Dr Waiting');
    await expect(sendInvitation(db, id, BASE, {})).rejects.toMatchObject({ code: 'mail_not_configured' });
    const stored = db.prepare('SELECT invited_at AS at FROM surgeons WHERE id = ?').get(id) as { at: string | null };
    expect(stored.at).toBeNull();
  });

  it('reports a refused password, and does not record an invitation that was not sent', async () => {
    const refusing = await startSmtpSink({ rejectAuth: true });
    try {
      const db = testDb();
      const id = addSurgeon(db, 'Dr Refused');
      const earlier = new Date(Date.now() - 3 * 86_400_000).toISOString();
      db.prepare('UPDATE surgeons SET invited_at = ? WHERE id = ?').run(earlier, id);

      const failure = await sendInvitation(db, id, BASE, envFor(refusing)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MailError);
      expect((failure as MailError).code).toBe('mail_auth');
      expect(refusing.messages).toHaveLength(0);
      const stored = db.prepare('SELECT invited_at AS at FROM surgeons WHERE id = ?').get(id) as { at: string };
      expect(stored.at).toBe(earlier);
    } finally {
      await refusing.close();
    }
  });

  it('reports a mail server that cannot be reached', async () => {
    const db = testDb();
    const id = addSurgeon(db, 'Dr Offline');
    const port = sink.port;
    await sink.close();
    const failure = await sendInvitation(db, id, BASE, envFor({ ...sink, port }))
      .catch((error: unknown) => error);
    expect((failure as MailError).code).toBe('mail_unreachable');
    sink = await startSmtpSink();
  });

  it('sends a test to the study inbox with a link that is not a real one', async () => {
    const db = testDb();
    addSurgeon(db, 'Dr Real');
    const { to } = await sendTestInvitation(db, BASE, envFor(sink));
    expect(to).toBe('lab@example.org');
    const [message] = sink.messages;
    expect(message.to).toEqual(['lab@example.org']);
    expect(message.headers.subject).toBe(`[Test] ${DEFAULT_INVITE.subject}`);
    expect(message.body).toContain('Dear Dr Example Surgeon,');
    expect(message.body).toContain(`${BASE}/a/example-only-not-a-real-link`);
  });
});
