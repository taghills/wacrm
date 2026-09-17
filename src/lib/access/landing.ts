// ============================================================
// Where a member lands, given what their access role hides.
//
// Split out of the hook so the choice is testable without React:
// the hook owns the effect, this owns the decision.
// ============================================================

import type { AccessModule } from './modules';

/**
 * Sidebar order, which doubles as the fall-through order when
 * picking a landing page — so a member ends up on the first thing
 * in their own menu.
 */
export const NAV_ROUTES: { path: string; module: AccessModule }[] = [
  { path: '/dashboard', module: 'dashboard' },
  { path: '/inbox', module: 'inbox' },
  { path: '/notifications', module: 'notifications' },
  { path: '/contacts', module: 'contacts' },
  { path: '/pipelines', module: 'pipelines' },
  { path: '/broadcasts', module: 'broadcasts' },
  { path: '/automations', module: 'automations' },
  { path: '/flows', module: 'flows' },
  { path: '/agents', module: 'agents' },
  { path: '/settings', module: 'settings' },
];

/**
 * Every role can reach their own profile — `settings.profile` is not
 * in ADMIN_SETTINGS, so no default hides it. That makes it a landing
 * page that always exists, for the pathological case of an admin who
 * hides every nav item.
 */
export const LAST_RESORT = '/settings?tab=profile';

/** The nav route a pathname belongs to, or null if it is not one. */
export function routeForPath(pathname: string) {
  return (
    NAV_ROUTES.find(
      (r) => pathname === r.path || pathname.startsWith(`${r.path}/`),
    ) ?? null
  );
}

/**
 * Where to send a member currently on `pathname`, or null to leave
 * them where they are.
 *
 * Returns null for a page they can see, and for any path outside the
 * nav (so /join/<token> and friends are never touched).
 */
export function redirectTarget(
  pathname: string,
  canSee: (module: AccessModule) => boolean,
): string | null {
  const current = routeForPath(pathname);
  if (!current) return null;
  if (canSee(current.module)) return null;

  const target = NAV_ROUTES.find((r) => canSee(r.module));
  return target ? target.path : LAST_RESORT;
}
