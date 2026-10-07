// ============================================================
// GET /r/<store id> — send the customer to that branch's Google
// review page.
//
// Why this exists, rather than putting the review link straight on
// the template's button:
//
//   Meta allows exactly one variable on a URL button, and only as a
//   SUFFIX on a fixed base: `https://example.com/thing/{{1}}`. The
//   whole URL cannot be a variable. Each branch's Google listing is
//   a different link, so there is no fixed base to hang them off —
//   one template could not serve four shops.
//
//   So the button points here, with the store's id as the suffix,
//   and this route looks up that branch's link. One template, any
//   number of branches.
//
//   It also means a review link can be changed in Settings -> Stores
//   and take effect on the next message, with no Meta re-approval.
//   A template edit costs another review round; this costs nothing.
//
// Public on purpose: the customer who taps the button is not signed
// in. It leaks nothing — a store id maps to a Google page that is
// already public.
// ============================================================

import { NextResponse } from 'next/server';

import { normalizeUrl, resolveMessageSettings } from '@/lib/erp/message-settings';
import { resolveReviewUrl } from '@/lib/erp/review-queue';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export const dynamic = 'force-dynamic';

/** A store id is a UUID; anything else is not worth a database trip. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const admin = supabaseAdmin();

  const { data: store } = await admin
    .from('stores')
    .select('account_id, review_url')
    .eq('id', id)
    .maybeSingle();

  if (!store) return notFound();

  // Same precedence as the send path: the branch's own listing, then
  // the account-wide link.
  const settings = await resolveMessageSettings(admin, store.account_id as string);
  const target = resolveReviewUrl(
    store.review_url as string | null,
    settings.reviewUrl,
  );

  // Re-validated here, not just on the way in. This is the only place
  // the value becomes a redirect, and a redirect to whatever a
  // database row happens to hold is how open redirects are built.
  const safe = normalizeUrl(target);
  if (!safe) return notFound();

  return NextResponse.redirect(safe, {
    status: 302,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * A plain page rather than a bare 404, because the person reading it
 * is a customer who tapped a button in a WhatsApp message, not a
 * developer. It should not look broken, and it should give them
 * something to do.
 */
function notFound() {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review link unavailable</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font:16px/1.5 system-ui,-apple-system,sans-serif;background:#f3f6f4;color:#15201c;padding:24px}
  main{max-width:28rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;color:#5d6b64}
  @media (prefers-color-scheme:dark){body{background:#0e1412;color:#e7edea}p{color:#94a49d}}
</style></head><body><main>
<h1>This review link isn't available</h1>
<p>Sorry about that. If you'd like to leave a review, please search for our shop on Google, or call the number in the message you received.</p>
</main></body></html>`,
    {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}
