/**
 * Whether a request came from this site's own pages. See admin-guard.ts for
 * why Sec-Fetch-Site decides it: Origin is `null` under this app's
 * no-referrer policy, and SameSite treats every *.sslip.io address as one site.
 */
export function isFromOwnPages(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return true;
  return isOwnOrigin(origin, request);
}

function isOwnOrigin(origin: string, request: Request): boolean {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  // Behind Caddy the Host header is the public name the browser used.
  if (host === request.headers.get('host')) return true;
  try {
    return Boolean(process.env.BASE_URL) && new URL(process.env.BASE_URL as string).host === host;
  } catch {
    return false;
  }
}
