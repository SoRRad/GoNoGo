import { headers } from 'next/headers';

/**
 * The public address a surgeon's link starts with. BASE_URL is what
 * seed:surgeons prints links with, so the two always agree; the request's own
 * host is only a fallback for a server started without it.
 */
export async function inviteBase(): Promise<string> {
  const configured = process.env.BASE_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  const list = await headers();
  const proto = list.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${list.get('host') ?? 'localhost:3000'}`;
}
