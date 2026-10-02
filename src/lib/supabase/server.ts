import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { sessionCookieOptions } from './cookie-options'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            // sessionCookieOptions() makes these survive the ERP
            // iframe (SameSite=None; Secure; Partitioned in
            // production). Without it the embedded CRM shows the
            // login page forever — see cookie-options.ts.
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, sessionCookieOptions(options))
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}
