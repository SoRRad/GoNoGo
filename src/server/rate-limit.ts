/**
 * Attempt limiting for the admin password, keyed by client IP.
 *
 * The admin page is the one door into every surgeon's data, and it is guarded
 * by a single shared password. Without a limit, that password is open to an
 * unlimited online guessing attack from anyone who finds the URL. Five attempts
 * then a fifteen minute lockout makes brute force impractical while barely
 * inconveniencing someone who mistyped.
 *
 * State is in process memory and deliberately dependency-free. A restart clears
 * it, and a second server process would keep its own counter; both are
 * acceptable for a single-container study deployment, and neither weakens the
 * limit below what a determined attacker would have to sustain.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Failures older than this stop counting towards the limit. */
const WINDOW_MS = 15 * 60 * 1000;

interface Record {
  failures: number[];
  lockedUntil: number;
}

const records = new Map<string, Record>();

/**
 * The client address, as seen through the reverse proxy.
 *
 * The app binds to localhost and only Caddy can reach it, so the socket address
 * is always 127.0.0.1 and X-Forwarded-For is what identifies the client. Caddy
 * APPENDS the real address to any header the client sent, so the last entry is
 * the trustworthy one; taking the first would let a client pick their own key
 * and sidestep the limit entirely.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function prune(now: number): void {
  for (const [key, record] of records) {
    const recent = record.failures.filter((at) => now - at < WINDOW_MS);
    if (recent.length === 0 && record.lockedUntil <= now) records.delete(key);
    else record.failures = recent;
  }
}

export interface LockoutState {
  locked: boolean;
  retryAfterSeconds: number;
  attemptsRemaining: number;
}

export function checkLockout(address: string): LockoutState {
  const now = Date.now();
  prune(now);
  const record = records.get(address);
  if (!record) return { locked: false, retryAfterSeconds: 0, attemptsRemaining: MAX_ATTEMPTS };

  if (record.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000),
      attemptsRemaining: 0,
    };
  }
  return {
    locked: false,
    retryAfterSeconds: 0,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - record.failures.length),
  };
}

/** Returns the state after recording this failure. */
export function recordFailure(address: string): LockoutState {
  const now = Date.now();
  prune(now);
  const record = records.get(address) ?? { failures: [], lockedUntil: 0 };
  record.failures.push(now);

  if (record.failures.length >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.failures = [];
  }
  records.set(address, record);

  // Logged so a sustained attempt is visible in the container logs. The
  // password itself is never logged, on success or failure.
  console.warn(
    `[sadi] admin login failed from ${address} at ${new Date(now).toISOString()}` +
      (record.lockedUntil > now ? ` — locked out for ${LOCKOUT_MS / 60000} minutes` : ''),
  );

  return checkLockout(address);
}

export function recordSuccess(address: string): void {
  records.delete(address);
  console.info(`[sadi] admin login succeeded from ${address} at ${new Date().toISOString()}`);
}

/** Test seam: forget every recorded attempt. */
export function resetRateLimit(): void {
  records.clear();
}
