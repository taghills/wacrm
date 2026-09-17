import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Next's client router appends `?_rsc=<hash>` to the React Server
// Component fetches it makes behind a <Link>. That param belongs to
// the data request, never to a page the browser shows.
//
// A middleware redirect that carries it forward is how it escapes: the
// router turns the redirect into a hard navigation, the browser loads
// the redirect target as a document, and the server answers that URL
// with the RSC payload — so the user gets a screenful of raw
// `1:"$Sreact.fragment"` instead of a page, with `?_rsc=` sitting in
// the address bar (reported against /dashboard).
//
// The /login branch below already cleared the whole query string. The
// protected-path branch cloned it verbatim, which is where this came
// from. Strip the internal params on every redirect rather than
// per-branch, so a future branch can't reintroduce it — and keep the
// caller's own query (e.g. ?invite=, ?tab=), which clearing wholesale
// would have thrown away.
const INTERNAL_PARAMS = ['_rsc'] as const

const stripInternalParams = (url: URL): URL => {
  INTERNAL_PARAMS.forEach((param) => url.searchParams.delete(param))
  return url
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(stripInternalParams(url)))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(stripInternalParams(url)))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
