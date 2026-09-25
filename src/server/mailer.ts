/**
 * Sends email through an SMTP account, for invitations.
 *
 * Configured entirely from the environment, so no password is ever stored in
 * the database or shown on a page. The defaults are Gmail's: set SMTP_USER to
 * the Gmail address and SMTP_PASSWORD to a Google app password, and nothing
 * else is needed.
 */
import nodemailer from 'nodemailer';

export interface MailSettings {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS, which is required unless explicitly waived. */
  secure: boolean;
  requireTls: boolean;
  user: string;
  password: string;
  /** The address invitations come from. Gmail only sends as the signed-in account or its verified aliases. */
  from: string;
  /** Where a hidden copy of each invitation goes, or null for none. */
  bcc: string | null;
}

/** The environment variables mail is configured from; process.env by default. */
export type MailEnv = Record<string, string | undefined>;

/** The mail settings, or null while email is not set up (Copy link still works then). */
export function mailSettings(env: MailEnv = process.env): MailSettings | null {
  const user = (env.SMTP_USER ?? '').trim();
  // Google shows app passwords in four groups of four; the spaces are not part of it.
  const password = (env.SMTP_PASSWORD ?? '').replace(/\s+/g, '');
  if (!user || !password) return null;

  const port = Number(env.SMTP_PORT) || 465;
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE.trim() === 'true' : port === 465;
  const from = (env.MAIL_FROM ?? '').trim() || user;
  const bccSetting = (env.INVITE_BCC ?? '').trim();
  return {
    host: (env.SMTP_HOST ?? '').trim() || 'smtp.gmail.com',
    port,
    secure,
    // Only the container smoke test talks to a mail server without TLS.
    requireTls: !secure && env.SMTP_INSECURE_FOR_TESTING !== 'true',
    user,
    password,
    from,
    bcc: bccSetting === 'none' ? null : bccSetting || from,
  };
}

export type MailProblem = 'mail_not_configured' | 'mail_auth' | 'mail_unreachable' | 'mail_rejected' | 'mail_failed';

export class MailError extends Error {
  constructor(
    readonly code: MailProblem,
    message: string,
  ) {
    super(message);
  }
}

const UNREACHABLE = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ETLS',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** Turns what the mail server or the network said into one of a few plain answers. */
export function classifyMailError(error: unknown): MailProblem {
  const { code, responseCode } = (error ?? {}) as { code?: string; responseCode?: number };
  if (code === 'EAUTH' || responseCode === 534 || responseCode === 535) return 'mail_auth';
  if (code === 'EENVELOPE' || responseCode === 550 || responseCode === 553) return 'mail_rejected';
  if (code && UNREACHABLE.has(code)) return 'mail_unreachable';
  return 'mail_failed';
}

export async function sendMail(
  settings: MailSettings,
  message: { fromName: string; to: string; bcc?: string | null; subject: string; text: string },
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: settings.requireTls,
    auth: { user: settings.user, pass: settings.password },
    // A page is waiting on this; fail in seconds rather than minutes.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({
      from: { name: message.fromName, address: settings.from },
      to: message.to,
      bcc: message.bcc ?? undefined,
      subject: message.subject,
      text: message.text,
    });
  } catch (error) {
    const code = classifyMailError(error);
    // The server's own words go to the log for whoever looks after the machine; the page gets plain ones.
    console.error(`[sadi] email failed (${code}): ${(error as Error)?.message ?? error}`);
    throw new MailError(code, (error as Error)?.message ?? String(error));
  } finally {
    transport.close();
  }
}
