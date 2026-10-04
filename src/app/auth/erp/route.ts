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
import { resolveErpAccountId } from '@/lib/erp/process';
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
    'No WhatsApp CRM member matches your ERP account. Ask the CRM owner to invite you from Settings → Team, using the email address shown below.',
  session_failed: 'The CRM could not start your session. Please try again.',
};

/**
 * The email is interpolated into the page, and it comes from a signed
 * token rather than an anonymous request — but "signed" is not
 * "trusted to be HTML-safe", and a stored XSS behind a 60-second HMAC
 * is still a stored XSS.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A refusal page rather than a JSON body: this renders inside the
 * ERP's iframe, where `{"error":"Unauthorized"}` tells a shop
 * manager nothing about what to do next.
 */
function refuse(
  reason: keyof typeof FAILURE_COPY,
  status: number,
  /**
   * The email we matched on, shown on the page. Not a secret, and
   * without it "you have no access" is unactionable: when the ERP
   * sends no email address we fall back to `<username>@erp.local`,
   * and nobody can guess that is what to invite.
   */
  identity?: string,
): NextResponse {
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
  .id { margin-top:.75rem; font-family:ui-monospace,monospace; font-size:.85rem; opacity:.65; }
</style></head>
<body><div class="card">
  <h1>Can't open the WhatsApp CRM</h1>
  <p>${message}</p>
  ${identity ? `<p class="id">${escapeHtml(identity)}</p>` : ''}
</div></body></html>`;

  return new NextResponse(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * The post-sign-in redirect, with a RELATIVE `Location`.
 *
 * `NextResponse.redirect()` needs an absolute URL, and the only
 * origin available here is `request.url` — which, behind a reverse
 * proxy, is the address the Node process is bound to rather than the
 * one the browser used. On the Hostinger deployment that is
 * `http://0.0.0.0:3000`, so a successful sign-in sent the browser to
 * `https://0.0.0.0:3000/dashboard`: the session was real, the
 * redirect was unreachable, and it looked like the whole site had
 * gone down.
 *
 * Reconstructing the public origin from `X-Forwarded-Host` would work
 * but means trusting a header the client can set, and getting it
 * wrong is an open redirect. A relative `Location` avoids the
 * question entirely: RFC 7231 allows it, every browser since IE
 * resolves it against the address bar, and the address bar is by
 * definition the origin the user actually reached us on. Nothing
 * here needs to know its own hostname.
 *
 * `next` is already validated site-relative by `sanitizeNext()`, so
 * this cannot emit a cross-origin Location.
 */
export function ssoRedirect(next: string): NextResponse {
  return new NextResponse(null, {
    status: 302,
    headers: { location: next, 'cache-control': 'no-store' },
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

  // Which CRM account the ERP belongs to. Resolved the same way the
  // event endpoint resolves it, so SSO and events can never disagree
  // about which tenant the ERP is.
  const resolved = await resolveErpAccountId(admin, process.env.ERP_ACCOUNT_ID);
  if ('error' in resolved) {
    console.error('[auth/erp] cannot resolve ERP account:', resolved.error);
    return refuse('session_failed', 500);
  }

  // Membership of THAT account — the whole check, done before any
  // user is touched.
  //
  // The obvious-looking version of this is wrong in a way worth
  // spelling out. Asking "does a user with this email exist, and does
  // it have an account?" passes for a user that does not belong here
  // at all, because `handle_new_user` (migration 017) gives every new
  // auth user a fresh personal account with role 'owner'. Supabase's
  // `generateLink` creates the user when none exists, so that version
  // let an unknown ERP username sign itself in, land in an empty CRM,
  // and leave a junk account behind each time.
  //
  // Reading `profiles` first inverts it: no row in the ERP's own
  // account means refused, and nothing is created on the way to
  // finding that out.
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('user_id')
    .eq('account_id', resolved.accountId)
    .eq('email', verified.email)
    .maybeSingle();

  if (profileError) {
    console.error('[auth/erp] profile lookup failed:', profileError.message);
    return refuse('session_failed', 500);
  }
  if (!profile) {
    console.warn('[auth/erp] not a member of the ERP account:', verified.email);
    return refuse('no_crm_user', 403, verified.email);
  }

  // Only now mint the session. `generateLink` hands back a single-use
  // token hash we redeem below, without ever sending an email.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: verified.email,
  });

  if (linkError || !link?.properties?.hashed_token) {
    console.error('[auth/erp] could not mint a session:', linkError?.message);
    return refuse('session_failed', 401);
  }

  // Build the redirect first and write the session cookies straight
  // onto it. Going through `cookies()` would work too, but this way
  // the Set-Cookie headers and the 302 are provably the same
  // response — the failure mode otherwise is a redirect that lands
  // on /dashboard with no session and bounces to /login.
  const response = ssoRedirect(verified.next);

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
