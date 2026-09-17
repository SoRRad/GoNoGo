import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { checkLockout, clientAddress, recordFailure, recordSuccess, resetRateLimit } from '@/server/rate-limit';

describe('clientAddress', () => {
  it('takes the last X-Forwarded-For entry, which the proxy appended', () => {
    // Caddy appends the real client address to whatever the client sent, so the
    // last entry is the trustworthy one.
    const request = new Request('http://localhost/api/admin/login', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(clientAddress(request)).toBe('203.0.113.9');
  });

  it('ignores a client-supplied prefix, so the limit cannot be sidestepped', () => {
    const request = new Request('http://localhost/api/admin/login', {
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
    });
    expect(clientAddress(request)).toBe('203.0.113.9');
  });

  it('falls back to X-Real-IP, then to a constant', () => {
    expect(
      clientAddress(new Request('http://localhost/', { headers: { 'x-real-ip': '198.51.100.7' } })),
    ).toBe('198.51.100.7');
    expect(clientAddress(new Request('http://localhost/'))).toBe('unknown');
  });
});

describe('admin login attempt limiting', () => {
  beforeEach(() => {
    resetRateLimit();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetRateLimit();
  });

  it('allows five attempts, then locks out', () => {
    const address = '203.0.113.1';
    expect(checkLockout(address).attemptsRemaining).toBe(5);

    for (let attempt = 1; attempt <= 4; attempt++) {
      const state = recordFailure(address);
      expect(state.locked).toBe(false);
      expect(state.attemptsRemaining).toBe(5 - attempt);
    }

    const fifth = recordFailure(address);
    expect(fifth.locked).toBe(true);
    expect(fifth.retryAfterSeconds).toBeGreaterThan(0);
    expect(fifth.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it('keeps the lockout even for the correct password', () => {
    const address = '203.0.113.2';
    for (let i = 0; i < 5; i++) recordFailure(address);
    // The route checks the lockout before it checks the password.
    expect(checkLockout(address).locked).toBe(true);
  });

  it('locks one address without affecting another', () => {
    for (let i = 0; i < 5; i++) recordFailure('203.0.113.3');
    expect(checkLockout('203.0.113.3').locked).toBe(true);
    expect(checkLockout('198.51.100.9').locked).toBe(false);
  });

  it('expires the lockout after fifteen minutes', () => {
    const address = '203.0.113.4';
    for (let i = 0; i < 5; i++) recordFailure(address);
    expect(checkLockout(address).locked).toBe(true);

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(checkLockout(address).locked).toBe(true);

    vi.advanceTimersByTime(2 * 60 * 1000);
    const after = checkLockout(address);
    expect(after.locked).toBe(false);
    expect(after.attemptsRemaining).toBe(5);
  });

  it('forgets failures older than the window, so a slow typist is not punished', () => {
    const address = '203.0.113.5';
    recordFailure(address);
    recordFailure(address);
    expect(checkLockout(address).attemptsRemaining).toBe(3);

    // Two failures an hour apart should never accumulate into a lockout.
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(checkLockout(address).attemptsRemaining).toBe(5);
    for (let i = 0; i < 4; i++) recordFailure(address);
    expect(checkLockout(address).locked).toBe(false);
  });

  it('clears the record on a successful login', () => {
    const address = '203.0.113.6';
    recordFailure(address);
    recordFailure(address);
    recordSuccess(address);
    expect(checkLockout(address).attemptsRemaining).toBe(5);
  });
});
