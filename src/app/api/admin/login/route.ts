import { NextResponse } from 'next/server';
import { checkAdminPassword, setAdminSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.redirect(new URL('/admin?error=unset', request.url), { status: 303 });
  }
  if (!checkAdminPassword(password)) {
    return NextResponse.redirect(new URL('/admin?error=1', request.url), { status: 303 });
  }

  await setAdminSession();
  return NextResponse.redirect(new URL('/admin', request.url), { status: 303 });
}
