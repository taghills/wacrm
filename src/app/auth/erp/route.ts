// ============================================================
// GET /auth/erp?token=<payload>.<sig> — single sign-on from the
// TAGHills ERP.
//
// The ERP embeds this CRM in an iframe. Rather than making staff
// keep a second password, its "CRM" tab loads this route with a
// 60-second signed token; we verify it, open the matching CRM
// session, and redirect to `next`.
//
// Three things decide whether someone gets in, in this order:
//
//   1. the HMAC signature — proves the ERP minted the token
//   2. `exp` — proves it was minted seconds ago, not captured
//      from a log last month
//   3. CRM membership — proves this person is actually a member of
//      the CRM account
//
// (3) is the one that is NOT in the handover, and it is deliberate.
// The handover says "find or create the CRM user by email". Creating
// one here would land them in a brand-new empty personal account
// (that is what the signup trigger does), so they would sign in
// successfully and see a CRM with no contacts, no inbox and no
// WhatsApp — which looks far more broken than being told they have
// no access. Instead: whoever should reach the CRM is invited from
// Settings -> Team first, exactly like any other staff member, and
// the owner keeps control of who has access in one place.
//
// Session cookies are written with SameSite=None; Secure;
// Partitioned in production (see lib/supabase/cookie-options.ts) —
// a Lax cookie is simply not sent on a request from a cross-site
// iframe, which is the usual reason an embedded app shows its login
// page forever.
// ============================================================

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { verifyErpSsoToken, type SsoFailure } from '@/lib/erp/sso';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sessionCookieOptions } from '@/lib/supabase/cookie-options';

/** Human wording for each refusal, shown inside the ERP's iframe. */
const FAILURE_COPY: Record<SsoFailure | 'no_crm_user' | 'session_failed', string> = {
  malformed: 'That sign-in link is not readable. Open the CRM tab again from the ERP.',
  bad_signature:
    'That sign-in link could not be verified. If this keeps happening, the ERP and the CRM are configured with different shared secrets.',
  expired:
    'That sign-in link has expired — they are only valid for a minute. Open the CRM tab again from the ERP.',
  role_not_allowed: 'Your ERP role does not have access to the WhatsApp CRM.',
  no_identity: 'Your ERP user has no email address, so the CRM cannot identify you.',
  no_crm_user:
    'You do not have a WhatsApp CRM account yet. Ask the CRM owner to invite you from Settings → Team, using this same email address.',
  session_failed: 'The CRM could not start your session. Please try again.',
};

/**
 * A refusal page rather than a JSON body: this renders inside the
 * ERP's iframe, where `{"error":"Unauthorized"}` tells a shop
 * manager nothing about what to do next.
 */
function refuse(reason: keyof typeof FAILURE_COPY, status: number): NextResponse {
  const message = FAILURE_COPY[reason];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp CRM</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         background:#fff; color:#111; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#0b0d0e; color:#e8eaed; } }
  .card { max-width:30rem; text-align:center; }
  h1 { font-size:1.1rem; margin:0 0 .5rem; }
  p { margin:0; opacity:.8; }
</style></head>
<body><div class="card">
  <h1>Can't open the WhatsApp CRM</h1>
  <p>${message}</p>
</div></body></html>`;

  return new NextResponse(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const verified = verifyErpSsoToken(token, process.env.ERP_SHARED_SECRET);

  if (!verified.ok) {
    console.warn('[auth/erp] refused:', verified.reason);
    return refuse(verified.reason, verified.reason === 'role_not_allowed' ? 403 : 401);
  }

  const admin = supabaseAdmin();

  // `generateLink` with type 'magiclink' does double duty: it refuses
  // outright if no user has this email (so it is also our existence
  // check) and, when one does, hands back a single-use token hash we
  // can redeem into a session without ever sending an email.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: verified.email,
  });

  if (linkError || !link?.user || !link.properties?.hashed_token) {
    console.warn('[auth/erp] no CRM user for', verified.email, linkError?.message);
    return refuse('no_crm_user', 403);
  }

  // Membership, not just existence. A user row can outlive the
  // account it belonged to (removed from the team, left, account
  // deleted) and must not get back in through the side door.
  const { data: profile } = await admin
    .from('profiles')
    .select('account_id')
    .eq('user_id', link.user.id)
    .maybeSingle();

  if (!profile?.account_id) {
    console.warn('[auth/erp] user has no account:', verified.email);
    return refuse('no_crm_user', 403);
  }

  // Build the redirect first and write the session cookies straight
  // onto it. Going through `cookies()` would work too, but this way
  // the Set-Cookie headers and the 302 are provably the same
  // response — the failure mode otherwise is a redirect that lands
  // on /dashboard with no session and bounces to /login.
  const response = NextResponse.redirect(new URL(verified.next, request.url));
  response.headers.set('cache-control', 'no-store');

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, sessionCookieOptions(options)),
          );
        },
      },
    },
  );

  const { error: otpError } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });

  if (otpError) {
    console.error('[auth/erp] session exchange failed:', otpError.message);
    return refuse('session_failed', 401);
  }

  return response;
}
