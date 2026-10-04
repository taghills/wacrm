// ============================================================
// The post-sign-in redirect for /auth/erp.
//
// Its own module rather than an export from `route.ts`: Next
// type-checks every route file against a generated declaration that
// allows ONLY the route exports (GET, POST, config, …), so any extra
// export fails the build with
//
//   Property 'ssoRedirect' is incompatible with index signature.
//   Type '(next: string) => NextResponse' is not assignable to 'never'.
//
// Note that `next build --webpack` (what `npm run build` and CI run)
// generates those declarations and `next build` with Turbopack does
// not — so this only fails under the repo's own build script.
// ============================================================

import { NextResponse } from 'next/server';

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
