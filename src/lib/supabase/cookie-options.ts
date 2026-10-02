// ============================================================
// Cookie attributes for the Supabase session cookies.
//
// Why this exists
//
//   The TAGHills ERP renders this CRM inside an iframe on
//   erp.taghills.com. To the browser that makes every request from
//   the iframe a CROSS-SITE request, and a cookie written with the
//   default `SameSite=Lax` is simply not sent on one. The visible
//   symptom is the login page appearing inside the ERP no matter how
//   many times the user signs in — the session exists, the cookie is
//   just never attached.
//
//   `SameSite=None` is what makes it travel, and the spec requires
//   `Secure` alongside it. `Partitioned` (CHIPS) opts into the
//   browser's per-top-level-site cookie jar, which is where
//   third-party cookies are headed; without it this breaks again the
//   day Chrome finishes its phase-out.
//
// Why it is conditional
//
//   `Secure` cookies are rejected over plain HTTP, so applying this
//   unconditionally would break `http://localhost:3000` — you would
//   sign in and bounce straight back to the login page, locally only.
//   Development keeps the defaults; production (always HTTPS) gets
//   the cross-site attributes.
//
// The CSRF question
//
//   `SameSite=Lax` is a defence-in-depth measure against cross-site
//   request forgery, and None gives it up. What still stands: every
//   mutating endpoint here is a JSON `fetch` from our own origin, and
//   a cross-origin JSON POST requires a CORS preflight that this app
//   does not answer. The framing policy in next.config.mjs also
//   restricts embedding to the one ERP origin. Losing Lax is a real
//   cost, accepted deliberately, because without it the embedded CRM
//   cannot hold a session at all.
// ============================================================

/** Shape shared by Next's cookie setters and Supabase's cookie options. */
export interface SessionCookieOptions {
  sameSite?: 'lax' | 'strict' | 'none' | boolean;
  secure?: boolean;
  partitioned?: boolean;
  [key: string]: unknown;
}

/**
 * True when session cookies should carry the cross-site attributes.
 *
 * Keyed off NODE_ENV rather than sniffing the request protocol: a
 * production deploy is HTTPS by definition here (HSTS is set
 * unconditionally in next.config.mjs), and a per-request check would
 * make the attribute set vary between responses in the same session,
 * which is how you end up with two cookies of the same name.
 */
export function crossSiteCookiesEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return nodeEnv === 'production';
}

/**
 * Apply the iframe-safe attributes to a set of cookie options,
 * leaving everything else (path, maxAge, httpOnly, domain) alone.
 *
 * Every place that writes a Supabase auth cookie must go through
 * this — the SSR client, the middleware's token refresh, the browser
 * client and the ERP SSO route. Miss one and that writer silently
 * downgrades the cookie back to `Lax` on its next write, which looks
 * like "the iframe logs itself out after a while".
 */
export function sessionCookieOptions<T extends SessionCookieOptions>(
  options: T,
  enabled: boolean = crossSiteCookiesEnabled(),
): T & SessionCookieOptions {
  if (!enabled) return options;
  return { ...options, sameSite: 'none', secure: true, partitioned: true };
}
