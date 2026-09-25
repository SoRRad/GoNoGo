import { NextResponse } from 'next/server';
import { getSurgeonByToken } from '@/lib/store';
import { setSurgeonSession } from '@/server/auth';
import { seeOther } from '@/server/redirect';

export const dynamic = 'force-dynamic';

/**
 * The only way in. A surgeon opens their personal link, which exchanges the
 * token for an httpOnly session cookie and drops them straight into their queue.
 */
/** A small standalone page, so it renders even if the app's own pages cannot. */
function notice(status: number, title: string, body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <body style="background:#0b0b0d;color:#e8e8ec;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
       <div style="max-width:32rem;padding:2rem;text-align:center">
         <h1 style="font-size:1.25rem;margin:0 0 .75rem">${title}</h1>
         <p style="color:#a1a1aa;line-height:1.6;margin:0">${body}</p>
       </div>
     </body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const surgeon = getSurgeonByToken(token);

  if (!surgeon) {
    return notice(
      404,
      'This link was not recognised',
      'It may have been copied incompletely, or replaced with a newer one. Please open the link ' +
        'straight from your most recent email, or reply to the researcher who sent it.',
    );
  }
  if (surgeon.paused_at) {
    return notice(
      403,
      'Your access is paused',
      'The study team has paused this link. Your work so far is saved. Please contact the ' +
        'researcher who invited you if you think this is a mistake.',
    );
  }

  await setSurgeonSession(surgeon);
  const destination = surgeon.onboarded_at ? '/annotate' : '/welcome';
  return seeOther(destination);
}
