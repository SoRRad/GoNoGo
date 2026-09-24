import { NextResponse } from 'next/server';

/**
 * A 303 to a path on this site, with a relative Location.
 *
 * Behind Caddy the app never sees the public origin: Next builds request.url
 * from its own listening address, so `new URL(path, request.url)` came out as
 * https://localhost:3000/... and sent every browser to its own machine. That
 * broke the admin login and, worse, every surgeon's access link. A relative
 * Location is resolved by the browser against the address it is actually on,
 * whatever proxy sits in front, and needs no configuration to be right.
 */
export function seeOther(path: string, headers: Record<string, string> = {}): NextResponse {
  if (!path.startsWith('/') || path.startsWith('//')) {
    // '//host' is protocol-relative and would leave the site.
    throw new Error(`seeOther expects a site-relative path, got ${path}`);
  }
  return new NextResponse(null, { status: 303, headers: { ...headers, Location: path } });
}
