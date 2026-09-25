/**
 * The invitation email: its wording, which the admin can change on the admin
 * page, and filling it in for one surgeon.
 *
 * The wording lives in the settings table rather than in code, so the study
 * team can change it without a rebuild. {name} and {link} are the only
 * placeholders, and the link is required: an invitation without it would
 * leave a surgeon with no way in.
 */
import type Database from 'better-sqlite3';

export interface InviteTemplate {
  fromName: string;
  subject: string;
  body: string;
}

export const DEFAULT_INVITE: InviteTemplate = {
  fromName: 'A-STAR Lab',
  subject: 'Your invitation to the SADI Go/No-Go study',
  body: [
    'Dear {name},',
    '',
    'Thank you for agreeing to take part in our study of dissection zones in robotic duodenal switch operations.',
    '',
    'Your personal link is below. It signs you straight in, with no password, so please keep it to yourself and do not forward this email.',
    '',
    '{link}',
    '',
    'What to expect:',
    '- You will see still frames from the operations. On each one, mark where you would be willing to dissect (Go) and where you would not (No-Go).',
    '- The first few frames are practice.',
    '- You can stop at any time. Opening the same link again brings you back to where you left off.',
    '- A computer or an iPad works best.',
    '',
    'If you have any questions, simply reply to this email.',
    '',
    'With thanks,',
    'The A-STAR Lab',
  ].join('\n'),
};

const KEYS = { fromName: 'invite_from_name', subject: 'invite_subject', body: 'invite_body' } as const;

export const LIMITS = { fromName: 80, subject: 200, body: 5000 } as const;

export type InviteTemplateProblem = 'template_needs_link' | 'template_invalid';

export class InviteTemplateError extends Error {
  constructor(readonly code: InviteTemplateProblem, message: string) {
    super(message);
  }
}

export function getInviteTemplate(db: Database.Database): InviteTemplate {
  const read = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  return {
    fromName: read(KEYS.fromName) ?? DEFAULT_INVITE.fromName,
    subject: read(KEYS.subject) ?? DEFAULT_INVITE.subject,
    body: read(KEYS.body) ?? DEFAULT_INVITE.body,
  };
}

/** Tidies what was typed into the form and checks it can be sent. */
export function normaliseInviteTemplate(input: InviteTemplate): InviteTemplate {
  // Line breaks in a header would let the subject or sender name add headers of their own.
  const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
  const fromName = oneLine(input.fromName);
  const subject = oneLine(input.subject);
  // Browsers submit textarea line breaks as \r\n.
  const body = input.body.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

  if (
    !fromName ||
    !subject ||
    !body ||
    fromName.length > LIMITS.fromName ||
    subject.length > LIMITS.subject ||
    body.length > LIMITS.body
  ) {
    throw new InviteTemplateError(
      'template_invalid',
      `The sender name, subject and message are all needed (up to ${LIMITS.fromName}, ` +
        `${LIMITS.subject} and ${LIMITS.body} characters).`,
    );
  }
  if (!body.includes('{link}')) {
    throw new InviteTemplateError('template_needs_link', 'The message must contain {link}, where the surgeon’s link goes.');
  }
  return { fromName, subject, body };
}

export function saveInviteTemplate(db: Database.Database, input: InviteTemplate): InviteTemplate {
  const template = normaliseInviteTemplate(input);
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    upsert.run(KEYS.fromName, template.fromName);
    upsert.run(KEYS.subject, template.subject);
    upsert.run(KEYS.body, template.body);
  })();
  return template;
}

export function resetInviteTemplate(db: Database.Database): void {
  db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?)').run(KEYS.fromName, KEYS.subject, KEYS.body);
}

/**
 * Fills the template in for one surgeon. A single pass, so a surgeon's name
 * that happens to contain "{link}" is left as typed rather than expanded.
 */
export function renderInvite(
  template: InviteTemplate,
  values: { name: string; link: string },
): { subject: string; text: string } {
  const fill = (text: string) =>
    text.replace(/\{(name|link)\}/g, (_, key: 'name' | 'link') => values[key]);
  return { subject: fill(template.subject), text: fill(template.body) };
}
