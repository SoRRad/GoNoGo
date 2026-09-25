/**
 * Emailing a surgeon their invitation, and a test of the wording.
 */
import type Database from 'better-sqlite3';
import type { Surgeon } from '@/lib/db';
import { nowIso } from '@/lib/ids';
import { getInviteTemplate, renderInvite } from '@/lib/invite';
import { ManageError } from '@/lib/manage';
import { MailError, mailSettings, sendMail } from './mailer';
import type { MailEnv } from './mailer';

/** A second click within this long is taken as a double click, not a resend. */
export const RESEND_GUARD_MS = 60_000;

export type InviteRefusal = 'paused' | 'just_sent';

export class InviteRefused extends Error {
  constructor(readonly code: InviteRefusal) {
    super(code);
  }
}

/**
 * Emails one surgeon their personal link, with a hidden copy to the study
 * inbox. The send is claimed in the database first, so two clicks in quick
 * succession send one email; if sending fails the claim is undone.
 */
export async function sendInvitation(
  db: Database.Database,
  surgeonId: number,
  base: string,
  env: MailEnv = process.env,
): Promise<{ surgeon: Surgeon; bcc: string | null }> {
  const settings = mailSettings(env);
  if (!settings) throw new MailError('mail_not_configured', 'Email sending is not set up.');

  const surgeon = db.prepare('SELECT * FROM surgeons WHERE id = ?').get(surgeonId) as Surgeon | undefined;
  if (!surgeon) throw new ManageError('not_found', 'That surgeon no longer exists.');
  if (surgeon.paused_at) throw new InviteRefused('paused');

  const now = nowIso();
  const cutoff = new Date(Date.now() - RESEND_GUARD_MS).toISOString();
  const claimed = db
    .prepare('UPDATE surgeons SET invited_at = ? WHERE id = ? AND (invited_at IS NULL OR invited_at < ?)')
    .run(now, surgeonId, cutoff);
  if (claimed.changes === 0) throw new InviteRefused('just_sent');

  const template = getInviteTemplate(db);
  const { subject, text } = renderInvite(template, { name: surgeon.name, link: `${base}/a/${surgeon.access_token}` });
  try {
    await sendMail(settings, { fromName: template.fromName, to: surgeon.email, bcc: settings.bcc, subject, text });
  } catch (error) {
    db.prepare('UPDATE surgeons SET invited_at = ? WHERE id = ? AND invited_at = ?').run(
      surgeon.invited_at,
      surgeonId,
      now,
    );
    throw error;
  }
  return { surgeon: { ...surgeon, invited_at: now }, bcc: settings.bcc };
}

/**
 * Sends the current wording to the study's own inbox, filled in with an
 * example name and a link that is deliberately not a working one.
 */
export async function sendTestInvitation(
  db: Database.Database,
  base: string,
  env: MailEnv = process.env,
): Promise<{ to: string }> {
  const settings = mailSettings(env);
  if (!settings) throw new MailError('mail_not_configured', 'Email sending is not set up.');
  const template = getInviteTemplate(db);
  const { subject, text } = renderInvite(template, {
    name: 'Dr Example Surgeon',
    link: `${base}/a/example-only-not-a-real-link`,
  });
  await sendMail(settings, { fromName: template.fromName, to: settings.from, subject: `[Test] ${subject}`, text });
  return { to: settings.from };
}
