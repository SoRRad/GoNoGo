import crypto from 'crypto';

let cachedSecret: string | null = null;

/**
 * SESSION_SECRET signs the surgeon and admin cookies. Production refuses to
 * start without one; development falls back to a per-process random value so
 * `npm run dev` works out of the box, at the cost of logging everyone out on
 * restart.
 */
export function getSessionSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set (at least 16 characters) in production.');
  }
  cachedSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[sadi] SESSION_SECRET is unset — using a random development secret. Sessions reset on restart.');
  return cachedSecret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

export function seal(payload: string): string {
  return `${payload}.${sign(payload)}`;
}

/** Constant-time verification; returns the payload or null. */
export function unseal(sealed: string | undefined | null): string | null {
  if (!sealed) return null;
  const cut = sealed.lastIndexOf('.');
  if (cut <= 0) return null;
  const payload = sealed.slice(0, cut);
  const provided = sealed.slice(cut + 1);
  const expected = sign(payload);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? payload : null;
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
