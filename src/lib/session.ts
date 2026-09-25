import crypto from 'crypto';
import type { Surgeon } from './db';

/**
 * What a surgeon's session cookie says, before it is sealed.
 *
 * The session is bound to the access link it was opened with, not only to the
 * surgeon: `s2:<id>:<fingerprint>:<issued>`. Replacing a surgeon's link changes
 * the fingerprint, so a link sent to the wrong person stops working in every
 * browser that already opened it, not just for new visits. Pausing a surgeon
 * is checked on every request for the same reason.
 *
 * Sessions from before this format (`s1:`) are refused, which signs those
 * browsers out once; reopening the emailed link signs them straight back in.
 */
export function tokenFingerprint(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
}

export function encodeSurgeonSession(surgeon: Pick<Surgeon, 'id' | 'access_token'>, issuedAt: number): string {
  return `s2:${surgeon.id}:${tokenFingerprint(surgeon.access_token)}:${issuedAt}`;
}

/** The surgeon a session payload still entitles, or null if it no longer does. */
export function surgeonFromSession(
  payload: string | null,
  lookup: (id: number) => Surgeon | undefined,
): Surgeon | null {
  if (!payload) return null;
  const [version, rawId, fingerprint] = payload.split(':');
  if (version !== 's2' || !fingerprint) return null;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const surgeon = lookup(id);
  if (!surgeon) return null;
  if (surgeon.paused_at) return null;
  if (tokenFingerprint(surgeon.access_token) !== fingerprint) return null;
  return surgeon;
}
