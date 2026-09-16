import { NextResponse } from 'next/server';
import { completeOnboarding } from '@/lib/store';
import { getSessionSurgeon } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** The one-time background questions, asked before the practice frames. */
export async function POST(request: Request) {
  const surgeon = await getSessionSurgeon();
  if (!surgeon) return NextResponse.json({ error: 'not_authorised' }, { status: 401 });

  const form = await request.formData();
  const years = Number(form.get('yearsInPractice'));
  const cases = Number(form.get('casesPerYear'));

  if (!Number.isFinite(years) || years < 0 || years > 70) {
    return NextResponse.json({ error: 'bad_years' }, { status: 400 });
  }
  if (!Number.isFinite(cases) || cases < 0 || cases > 2000) {
    return NextResponse.json({ error: 'bad_cases' }, { status: 400 });
  }

  completeOnboarding(surgeon.id, Math.round(years), Math.round(cases));
  return NextResponse.json({ ok: true });
}
