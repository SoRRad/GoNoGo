import { NextResponse } from 'next/server';
import { isAdmin } from './auth';
import { isFromOwnPages } from './same-origin';

/**
 * Admin actions change the study, so a valid admin cookie is not enough on its
 * own: the request must also come from this site's own pages.
 *
 * The cookie's SameSite=Lax is weaker here than it looks. It only stops other
 * *sites*, and a site is the registrable domain: every *.sslip.io address is
 * the same site, so a page on anyone else's sslip.io address could post to
 * this one with the admin cookie attached. And Origin cannot tell the two
 * apart either, because this app sends Referrer-Policy: no-referrer, under
 * which browsers post forms with `Origin: null`.
 *
 * Sec-Fetch-Site can: browsers set it on every request whatever the referrer
 * policy, and it is "same-origin" only for this exact scheme, host and port.
 * Older clients that do not send it fall back to Origin, and a request with
 * neither signal (curl, a script on the server) is allowed, since it cannot be
 * carrying a browser's cookie on another page's behalf.
 */
export async function refuseUnlessAdminAction(request: Request): Promise<NextResponse | null> {
  if (!(await isAdmin())) return NextResponse.json({ error: 'not_authorised' }, { status: 401 });
  if (!isFromOwnPages(request)) return NextResponse.json({ error: 'cross_origin' }, { status: 403 });
  return null;
}

/** A site-relative path with a query string, for redirecting back with a message. */
export function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
