import { NextResponse } from 'next/server';
import { getSurgeonByToken } from '@/lib/store';
import { setSurgeonSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

/**
 * The only way in. A surgeon opens their personal link, which exchanges the
 * token for an httpOnly session cookie and drops them straight into their queue.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const surgeon = getSurgeonByToken(token);

  if (!surgeon) {
    return new NextResponse(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
       <title>Link not recognised</title>
       <body style="background:#0b0b0d;color:#e8e8ec;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
         <div style="max-width:32rem;padding:2rem;text-align:center">
           <h1 style="font-size:1.25rem;margin:0 0 .75rem">This link was not recognised</h1>
           <p style="color:#a1a1aa;line-height:1.6;margin:0">
             It may have been copied incompletely. Please open the link straight from the
             email, or reply to the researcher who sent it.
           </p>
         </div>
       </body>`,
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  await setSurgeonSession(surgeon.id);
  const destination = surgeon.onboarded_at ? '/annotate' : '/welcome';
  return NextResponse.redirect(new URL(destination, request.url), { status: 303 });
}
