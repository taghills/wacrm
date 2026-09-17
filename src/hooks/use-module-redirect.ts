'use client';

// ============================================================
// useModuleRedirect — keep a member off a page their access role
// hides, by sending them somewhere they can actually use.
//
// Why a redirect and not the "not available" panel the settings
// sections get: /dashboard is where everyone lands after signing in
// (src/app/page.tsx and the middleware both send there), so hiding
// it without this would drop a member on a dead end with no
// Dashboard in their sidebar to explain it. A bounce to their first
// visible page means the hidden one simply isn't part of their app.
//
// The choice of destination lives in @/lib/access/landing so it can
// be tested without React; this owns only the effect.
//
// Rendering only, like everything keyed off useAccess — the database
// is what refuses the reads. See @/lib/access/modules.
// ============================================================

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { useAccess } from '@/hooks/use-access';
import { redirectTarget } from '@/lib/access/landing';

export function useModuleRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const access = useAccess();

  // Resolve before the effect so the dependency is a plain string:
  // `access` returns fresh closures every render, so depending on it
  // would re-run this constantly.
  const target = access.loading
    ? null
    : redirectTarget(pathname, access.canSee);

  useEffect(() => {
    // Fail open while resolving: bouncing on an unresolved role would
    // throw a member off a page they may see, on every reload.
    if (!target) return;
    router.replace(target);
  }, [target, router]);
}
