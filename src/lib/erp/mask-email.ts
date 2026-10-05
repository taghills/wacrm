// ============================================================
// Email masking for the ERP status endpoint.
//
// Its own module rather than an export from `route.ts`: Next
// type-checks route files against a generated declaration allowing
// only the route exports, so any extra export fails the build. Same
// trap as src/app/auth/erp/redirect.ts — and only `next build
// --webpack` (what `npm run build` and CI run) generates those
// declarations, so a Turbopack build will not catch it.
// ============================================================

/**
 * Partially mask an email: `user3taghills@gmail.com` ->
 * `us•••••••••@gmail.com`.
 *
 * This endpoint deliberately reads ACROSS accounts — that is the
 * whole point, since the problem it diagnoses is data landing in the
 * wrong one. But "across accounts" and "dump every user's email"
 * are different things, and this template can be deployed with
 * several unrelated businesses in one database. Masking keeps the
 * diagnostic value for the person who recognises their own
 * addresses, without handing an admin of one account a readable
 * roster of another.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '(none)';
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = local.slice(0, 2);
  return `${keep}${'•'.repeat(Math.max(local.length - 2, 1))}${domain}`;
}
