import { cookies } from 'next/headers';
import { seal, unseal, safeEqual } from '@/lib/crypto';
import { getSurgeonById } from '@/lib/store';
import type { Surgeon } from '@/lib/db';

export const SURGEON_COOKIE = 'sadi_session';
export const ADMIN_COOKIE = 'sadi_admin';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function cookieOptions() {
  const isHttps = (process.env.BASE_URL || '').startsWith('https://');
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isHttps,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}

export async function setSurgeonSession(surgeonId: number): Promise<void> {
  const store = await cookies();
  store.set(SURGEON_COOKIE, seal(`s1:${surgeonId}:${Date.now()}`), cookieOptions());
}

export async function clearSurgeonSession(): Promise<void> {
  (await cookies()).delete(SURGEON_COOKIE);
}

/** The signed-in surgeon, or null. Every surgeon-facing route goes through this. */
export async function getSessionSurgeon(): Promise<Surgeon | null> {
  const raw = (await cookies()).get(SURGEON_COOKIE)?.value;
  const payload = unseal(raw);
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts[0] !== 's1') return null;
  const id = Number(parts[1]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return getSurgeonById(id) ?? null;
}

export async function setAdminSession(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_COOKIE, seal(`a1:${Date.now()}`), { ...cookieOptions(), maxAge: 60 * 60 * 12 });
}

export async function clearAdminSession(): Promise<void> {
  (await cookies()).delete(ADMIN_COOKIE);
}

export async function isAdmin(): Promise<boolean> {
  const payload = unseal((await cookies()).get(ADMIN_COOKIE)?.value);
  return payload?.startsWith('a1:') ?? false;
}

export function checkAdminPassword(candidate: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return safeEqual(candidate, expected);
}
