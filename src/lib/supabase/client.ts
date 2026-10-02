import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import { crossSiteCookiesEnabled } from './cookie-options'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Signing in from inside the ERP iframe writes the session
    // cookie from the browser, so it needs the same cross-site
    // attributes the server-side writers use. Omitted in dev, where
    // Secure cookies are dropped over http://localhost.
    crossSiteCookiesEnabled()
      ? { cookieOptions: { sameSite: 'none', secure: true } }
      : undefined
  )

  return browserClient
}
