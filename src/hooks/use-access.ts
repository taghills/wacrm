'use client';

// ============================================================
// useAccess — what the signed-in member is shown.
//
// Resolves the member's access role (migration 045) against the
// defaults for their account_role. Rendering only: see the scope
// note at the top of @/lib/access/modules.
//
// The result is cached on the module so the sidebar, the settings
// rail and the settings page share one request rather than three.
// A role change by an admin lands on the member's next page load,
// which is the right trade for not re-querying on every nav render.
// ============================================================

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  parsePermissions,
  resolveLevel,
  type AccessLevel,
  type AccessModule,
  type AccessPermissions,
} from '@/lib/access/modules';

interface Resolved {
  userId: string;
  permissions: AccessPermissions;
}

let cache: Resolved | null = null;

/** Drop the cache after the signed-in user's own role changes. */
export function invalidateAccessCache() {
  cache = null;
}

export function useAccess() {
  const { user, accountRole, profileLoading } = useAuth();
  const [fetched, setFetched] = useState<Resolved | null>(cache);

  // Derive rather than store: a cache hit or a signed-out user must
  // not setState during the effect, which would cascade a render.
  const resolved =
    user && cache?.userId === user.id
      ? cache
      : user && fetched?.userId === user.id
        ? fetched
        : null;

  useEffect(() => {
    if (!user) return;
    if (cache?.userId === user.id) return;

    let cancelled = false;
    (async () => {
      const supabase = createClient();
      // profiles RLS already scopes this to self, and
      // access_roles_select lets any member read their account's roles.
      const { data } = await supabase
        .from('profiles')
        .select('access_role_id, access_roles(permissions)')
        .eq('user_id', user.id)
        .maybeSingle();

      if (cancelled) return;

      const raw = (
        data as { access_roles?: { permissions?: unknown } | null } | null
      )?.access_roles?.permissions;
      const next = { userId: user.id, permissions: parsePermissions(raw) };
      cache = next;
      setFetched(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  function level(module: AccessModule): AccessLevel {
    return resolveLevel(accountRole, resolved?.permissions ?? null, module);
  }

  return {
    /** True until both the profile and the access role have settled. */
    loading: profileLoading || (!!user && !resolved),
    level,
    /** Shown at all — `view` or `edit`. */
    canSee: (module: AccessModule) => level(module) !== 'hidden',
    /** Shown with its controls enabled. */
    canEdit: (module: AccessModule) => level(module) === 'edit',
  };
}
